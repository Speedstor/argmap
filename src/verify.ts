import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitBuffer, refExists, tryGit } from './git.ts';
import { parseFile, pinClaims } from './parse.ts';
import type { RawFile } from './parse.ts';
import { vouchers } from './predict.ts';
import { claimRev } from './review.ts';
import type { Prediction, Signed, Term } from './types.ts';

export const SIGNERS_FILE = 'allowed_signers';

export interface Signer {
  /** As written in the list, e.g. "aldrin@person" or "claude-fable@ai". */
  principal: string;
  name: string;
  kind: 'person' | 'ai' | 'unknown';
  /** The public key, base64, as it appears in the list. */
  key: string;
  /** The comment after the key, if any: a free description of which key this is. */
  label?: string;
}

const KEY_TYPE = /^(ssh-|ecdsa-|sk-)/;

/**
 * Read an allowed-signers list in the format git and ssh-keygen use:
 *   principal[,principal] [options] key-type base64-key [comment]
 * The list holds public keys only, so it is safe to publish.
 */
export function parseSigners(text: string): Signer[] {
  const out: Signer[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    const typeAt = tokens.findIndex((t, i) => i > 0 && KEY_TYPE.test(t));
    if (typeAt === -1 || !tokens[typeAt + 1]) continue;
    // A certificate authority vouches for other keys; this tool only trusts keys listed by name.
    if (tokens.slice(1, typeAt).some((t) => t.toLowerCase() === 'cert-authority')) continue;
    for (const principal of (tokens[0] as string).split(',')) {
      const at = principal.lastIndexOf('@');
      const suffix = at === -1 ? '' : principal.slice(at + 1);
      const kind = suffix === 'person' || suffix === 'ai' ? suffix : 'unknown';
      const signer: Signer = { principal, name: kind === 'unknown' ? principal : principal.slice(0, at), kind, key: tokens[typeAt + 1] as string };
      const label = tokens.slice(typeAt + 2).join(' ');
      if (label !== '') signer.label = label;
      out.push(signer);
    }
  }
  return out;
}

/** Split a raw commit into what was signed and the signature attached to it. */
export function splitCommit(raw: Buffer): { payload: Buffer; signature?: string } {
  const text = raw.toString('latin1');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd === -1 ? text : text.slice(0, headerEnd + 1);
  const m = /^gpgsig (.*\n(?: .*\n)*)/m.exec(header);
  if (!m) return { payload: raw };
  const start = m.index;
  const end = start + m[0].length;
  const signature = (m[1] as string).replace(/\n /g, '\n').trim();
  return { payload: Buffer.concat([raw.subarray(0, start), raw.subarray(end)]), signature };
}

function reader(buf: Buffer): { string: () => Buffer; uint32: () => number; rest: () => Buffer } {
  let at = 0;
  const uint32 = (): number => {
    if (at + 4 > buf.length) throw new Error('truncated');
    const n = buf.readUInt32BE(at);
    at += 4;
    return n;
  };
  return {
    uint32,
    string: () => {
      const n = uint32();
      if (at + n > buf.length) throw new Error('truncated');
      const out = buf.subarray(at, at + n);
      at += n;
      return out;
    },
    rest: () => buf.subarray(at),
  };
}

function wire(...parts: (string | Buffer)[]): Buffer {
  return Buffer.concat(
    parts.map((part) => {
      const body = typeof part === 'string' ? Buffer.from(part) : part;
      const length = Buffer.alloc(4);
      length.writeUInt32BE(body.length);
      return Buffer.concat([length, body]);
    }),
  );
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface SignatureCheck {
  ok: boolean;
  /** The public key that made the signature, base64, when it could be read. */
  key?: string;
  problem?: string;
}

/**
 * Check an SSH signature (the SSHSIG format git uses) with only the public key
 * that is embedded in it. No private key and no ssh-keygen are needed.
 */
export function checkSshSignature(payload: Buffer, armored: string): SignatureCheck {
  if (!armored.includes('BEGIN SSH SIGNATURE')) return { ok: false, problem: 'signed, but not with an SSH key' };
  try {
    const blob = Buffer.from(armored.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
    if (blob.subarray(0, 6).toString() !== 'SSHSIG') return { ok: false, problem: 'not an SSH signature' };
    const r = reader(blob.subarray(6));
    if (r.uint32() !== 1) return { ok: false, problem: 'unknown signature version' };
    const publicKey = r.string();
    const namespace = r.string();
    const reserved = r.string();
    const hashName = r.string().toString();
    const signature = r.string();
    const key = publicKey.toString('base64');
    if (namespace.toString() !== 'git') return { ok: false, key, problem: 'signature was not made for git' };
    if (hashName !== 'sha512' && hashName !== 'sha256') return { ok: false, key, problem: `unknown hash ${hashName}` };

    const keyReader = reader(publicKey);
    const keyType = keyReader.string().toString();
    if (keyType !== 'ssh-ed25519') return { ok: false, key, problem: `key type ${keyType} is not supported yet (only ssh-ed25519)` };
    const rawKey = keyReader.string();
    const sigReader = reader(signature);
    if (sigReader.string().toString() !== 'ssh-ed25519') return { ok: false, key, problem: 'signature type does not match the key' };
    const rawSignature = sigReader.string();

    const digest = createHash(hashName).update(payload).digest();
    const signed = Buffer.concat([Buffer.from('SSHSIG'), wire(namespace, reserved, hashName, digest)]);
    const keyObject = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]), format: 'der', type: 'spki' });
    return verifySignature(null, signed, keyObject, rawSignature) ? { ok: true, key } : { ok: false, key, problem: 'signature does not match the commit' };
  } catch {
    return { ok: false, problem: 'signature could not be read' };
  }
}

export interface CommitCheck {
  commit: string;
  subject: string;
  /** Who signed it, when the signature is good and the key is on the list. */
  signer?: Signer;
  /**
   * Set on a commit with more than one parent. "clean": its files are exactly
   * what git gets by combining its parents, so it adds nothing of its own.
   * "edited": it differs from that, so somebody changed something in the merge.
   */
  merge?: 'clean' | 'edited';
  problems: string[];
}

/**
 * Does a merge commit add anything of its own? It does not when its files are
 * exactly what git produces by merging its two parents. Then every line in it
 * comes from a commit that is checked separately, and it does not matter who
 * pressed the merge button. GitHub signs its merges with its own key, and a
 * workflow leaves them unsigned, so without this no merged pull request passes.
 */
export function mergeKind(root: string, commit: string, parents: string[]): { kind: 'clean' | 'edited'; why?: string } {
  if (parents.length !== 2) return { kind: 'edited', why: `it has ${parents.length} parents, and only a merge of two can be checked` };
  let merged: string;
  try {
    merged = git(root, ['merge-tree', '--write-tree', parents[0] as string, parents[1] as string]).split('\n')[0] ?? '';
  } catch (e) {
    // git exits with 1 when the two sides conflict, and with something else when it could not merge at all.
    if ((e as { status?: number }).status === 1) return { kind: 'edited', why: 'its parents conflict, so somebody chose how to combine them' };
    return { kind: 'edited', why: 'git could not redo the merge to compare (this needs git 2.38 or later, and the full history of both parents)' };
  }
  const actual = git(root, ['rev-parse', `${commit}^{tree}`]);
  return merged === actual ? { kind: 'clean' } : { kind: 'edited', why: 'its files differ from what combining its parents gives' };
}

/** The list of trusted keys, taken from main so that a branch cannot add its own key. */
export function readSigners(root: string, explicit?: string): { text: string; from: string } {
  if (explicit) return { text: readFileSync(explicit, 'utf8'), from: explicit };
  for (const ref of ['origin/main', 'main']) {
    if (!refExists(root, ref)) continue;
    const text = tryGit(root, ['show', `${ref}:${SIGNERS_FILE}`]);
    if (text !== undefined) return { text, from: `${ref}:${SIGNERS_FILE}` };
  }
  const path = join(root, SIGNERS_FILE);
  return existsSync(path) ? { text: readFileSync(path, 'utf8'), from: SIGNERS_FILE } : { text: '', from: 'nowhere (no allowed_signers file found)' };
}

function recordsOf(file: RawFile | undefined): { reviews: string[]; evidence: string[]; log: string[] } {
  const out = { reviews: [] as string[], evidence: [] as string[], log: [] as string[] };
  if (!file) return out;
  for (const claim of file.claims.values()) {
    for (const r of claim.reviews) out.reviews.push(JSON.stringify([claim.id, r.by, r.kind, r.verdict, r.note ?? '', r.date ?? '', r.rev ?? '']));
    for (const e of claim.evidence) out.evidence.push(JSON.stringify([claim.id, e.by ?? '', e]));
  }
  for (const entry of file.log) out.log.push(JSON.stringify([entry.by, entry]));
  return out;
}

/** A prediction as verify sees it: the part that may never change, and the parts that are added later. */
interface Tracked {
  /** The claim it is on and everything fixed when it is made. Two predictions with the same key are the same prediction. */
  key: string;
  claim: string;
  says: string;
  by: string;
  kind: string;
  made: string;
  due: string;
  /** The fingerprint it carries, and the fingerprint of its claim in this version of the file. */
  rev: string;
  claimRev: string;
  accepted: Signed[];
  overdue?: Signed;
  /** The outcome and everything recorded with it, as one string. */
  outcome?: string;
  voided: boolean;
  resolved?: string;
  resolvedBy?: string;
  resolvedKind?: string;
  confirmed: Signed[];
  /** Who vouched for the claim in this version of the file. */
  vouchers: string[];
}

/**
 * A prediction belongs to its claim. The claim's id is part of the key, so a
 * test cannot be carried from one claim to another: that reads as removing it
 * here and recording a new one there, and both are refused.
 */
const fixedKey = (claim: string, p: Prediction): string =>
  JSON.stringify([claim, p.says, p.how, p.type, p.p, p.ifTrue, p.ifFalse ?? null, p.sample ?? null, p.needs ?? null, p.by, p.kind, p.made, p.due, p.rev ?? null]);

function track(file: RawFile | undefined, into: Map<string, Tracked>): void {
  if (!file) return;
  for (const claim of file.claims.values()) {
    const backers = vouchers(claim);
    const rev = claimRev(claim);
    for (const p of claim.predictions) {
      const key = fixedKey(claim.id, p);
      const seen = into.get(key);
      const one: Tracked = { key, claim: claim.id, says: p.says, by: p.by, kind: p.kind, made: p.made, due: p.due, rev: p.rev ?? '', claimRev: rev, accepted: [...p.accepted], confirmed: [...p.confirmed], voided: p.outcome === 'void', vouchers: backers };
      if (p.overdue) one.overdue = p.overdue;
      if (p.outcome !== undefined) {
        one.outcome = JSON.stringify([p.outcome, p.found ?? null, p.resolved ?? null, p.resolvedBy ?? null, p.resolvedKind ?? null, p.source ?? null, p.note ?? null]);
        if (p.resolved) one.resolved = p.resolved;
        if (p.resolvedBy) one.resolvedBy = p.resolvedBy;
        if (p.resolvedKind) one.resolvedKind = p.resolvedKind;
      }
      if (!seen) {
        into.set(key, one);
        continue;
      }
      // The same prediction seen on two sides of a merge: what either side added counts as already there.
      for (const a of one.accepted) if (!seen.accepted.some((x) => x.by === a.by)) seen.accepted.push(a);
      for (const c of one.confirmed) if (!seen.confirmed.some((x) => x.by === c.by)) seen.confirmed.push(c);
      if (!seen.overdue && one.overdue) seen.overdue = one.overdue;
      if (seen.outcome === undefined && one.outcome !== undefined) Object.assign(seen, { outcome: one.outcome, voided: one.voided, resolved: one.resolved, resolvedBy: one.resolvedBy, resolvedKind: one.resolvedKind });
    }
  }
}

/** The trust label on each bet in a file: the level, and whose name is on it. */
const labels = (file: RawFile | undefined): Map<string, { trust: string; by?: string }> => {
  const out = new Map<string, { trust: string; by?: string }>();
  if (file) for (const claim of file.claims.values()) if (claim.bet) out.set(claim.id, claim.bet.by ? { trust: claim.bet.trust, by: claim.bet.by } : { trust: claim.bet.trust });
  return out;
};

const DAY = 24 * 60 * 60 * 1000;
/** A date written in a record must be within two days of the commit that records it. The slack covers time zones. */
const nearDay = (typed: string | undefined, commitDay: string): boolean => typed !== undefined && Math.abs(Date.parse(typed) - Date.parse(commitDay)) <= 2 * DAY;

/**
 * The rules that make a prediction worth scoring. The guess must come first:
 * a prediction arrives without its outcome, and is never edited or removed
 * afterwards. Each later part (an acceptance, an overdue marker, the outcome, a
 * second name on it) is added once, in the signer's own name.
 */
function predictionProblems(before: Map<string, Tracked>, after: Map<string, Tracked>, signer: Signer, path: string, commitDay: string): string[] {
  const problems: string[] = [];
  const mine = (who: { by: string; kind: string }, what: string): void => {
    if (who.by !== signer.name) problems.push(`${path}: ${what} is recorded as by "${who.by}", but the commit was signed by ${signer.principal}`);
    else if (signer.kind !== 'unknown' && who.kind !== signer.kind) problems.push(`${path}: ${what} says it is by ${who.kind === 'ai' ? 'an AI' : 'a person'}, but ${signer.principal} is listed as ${signer.kind === 'ai' ? 'an AI' : 'a person'}`);
  };
  for (const [key, old] of before) {
    if (!after.has(key)) problems.push(`${path}: a prediction on "${old.claim}" was changed or removed ("${old.says}"). Once recorded, a prediction's wording, chances and dates are fixed; to withdraw it, record the outcome void.`);
  }
  for (const [key, now] of after) {
    const old = before.get(key);
    const name = `the prediction on "${now.claim}" ("${now.says}")`;
    if (!old) {
      mine(now, name);
      if (now.rev !== now.claimRev) problems.push(`${path}: ${name} does not carry the fingerprint of the claim it is recorded on. A prediction tests the claim as it reads when the prediction is made.`);
      if (now.vouchers.includes(now.by) && !now.accepted.some((a) => a.by === now.by)) {
        problems.push(`${path}: ${now.by} vouches for "${now.claim}" and set ${name} without accepting it. Someone who vouches for a claim stands behind the tests they set on it.`);
      }
      if (!nearDay(now.made, commitDay)) problems.push(`${path}: ${name} says it was made on ${now.made}, but the commit that records it is dated ${commitDay}.`);
      if (now.outcome !== undefined) problems.push(`${path}: ${name} arrived together with its outcome. The prediction must be recorded first, in an earlier commit.`);
      if (now.overdue) problems.push(`${path}: ${name} arrived already marked overdue.`);
      if (now.confirmed.length > 0) problems.push(`${path}: ${name} arrived with its outcome already confirmed.`);
    }
    const had = old ?? { accepted: [], confirmed: [] as Signed[], overdue: undefined, outcome: undefined };
    if (old && old.outcome === undefined && old.accepted.length > 0 && old.rev === old.claimRev && now.rev !== now.claimRev) {
      problems.push(`${path}: "${now.claim}" was reworded or rewired while an accepted test of it was waiting for its outcome ("${now.says}"). Record what was found first.`);
    }
    for (const gone of had.accepted.filter((a) => !now.accepted.some((x) => x.by === a.by))) problems.push(`${path}: ${gone.by}'s acceptance of ${name} was removed.`);
    for (const a of now.accepted.filter((x) => !had.accepted.some((y) => y.by === x.by))) {
      mine(a, `an acceptance of ${name}`);
      if (!now.vouchers.includes(a.by)) problems.push(`${path}: ${a.by} accepted ${name} without vouching for the claim. Only someone named on its trust label, or with a standing confirmation of it, can accept a test.`);
      if (now.outcome !== undefined) problems.push(`${path}: ${name} was accepted when its outcome was already known. A test is accepted before the answer, or not at all.`);
    }
    if (had.overdue && JSON.stringify(had.overdue) !== JSON.stringify(now.overdue)) problems.push(`${path}: the overdue marker on ${name} was changed or removed.`);
    if (!had.overdue && now.overdue) {
      mine(now.overdue, `the overdue marker on ${name}`);
      if (now.overdue.date === undefined || now.overdue.date <= now.due) problems.push(`${path}: ${name} is marked overdue${now.overdue.date ? ` on ${now.overdue.date}` : ' with no date'}, but it is due on ${now.due}.`);
      else if (!nearDay(now.overdue.date, commitDay)) problems.push(`${path}: the overdue marker on ${name} is dated ${now.overdue.date}, but the commit that records it is dated ${commitDay}.`);
    }
    if (had.outcome !== undefined && had.outcome !== now.outcome) problems.push(`${path}: the outcome of ${name} was changed or removed. An outcome is recorded once.`);
    if (had.outcome === undefined && now.outcome !== undefined) {
      if (old) mine({ by: now.resolvedBy ?? '', kind: now.resolvedKind ?? '' }, `the outcome of ${name}`);
      if (!nearDay(now.resolved, commitDay)) problems.push(`${path}: the outcome of ${name} is dated ${now.resolved ?? 'nothing'}, but the commit that records it is dated ${commitDay}.`);
      if (now.voided && now.resolvedBy !== now.by) problems.push(`${path}: ${now.resolvedBy} withdrew ${name}, which ${now.by} set. Only its setter can withdraw a prediction; anyone can record what was found.`);
    }
    for (const gone of had.confirmed.filter((c) => !now.confirmed.some((x) => x.by === c.by))) problems.push(`${path}: ${gone.by}'s confirmation of the outcome of ${name} was removed.`);
    for (const c of now.confirmed.filter((x) => !had.confirmed.some((y) => y.by === x.by))) {
      mine(c, `a confirmation of the outcome of ${name}`);
      if (c.by === now.resolvedBy) problems.push(`${path}: ${c.by} recorded the outcome of ${name} and also confirmed it. A second name must be someone else.`);
    }
  }
  return problems;
}

function added(before: string[], after: string[]): string[] {
  const pool = [...before];
  return after.filter((item) => {
    const at = pool.indexOf(item);
    if (at === -1) return true;
    pool.splice(at, 1);
    return false;
  });
}

/**
 * Check a range of commits against the list of trusted keys. Each commit must
 * be signed by a listed key, and any review, evidence or log entry it adds must
 * be in the signer's own name: nobody can record a judgment as someone else.
 *
 * A merge that adds nothing of its own passes without a trusted signature (see
 * mergeKind). A merge that was edited is treated like any other commit: it
 * needs a trusted signature, and what it adds beyond its parents must be in the
 * signer's name.
 */
export interface VerifyOptions {
  /** Refuse a prediction and its outcome in the same range. For a pull request: the prediction must be on main first. */
  separate?: boolean;
  /** Refuse a commit dated after this moment, in seconds since 1970. The command line passes the present time. */
  notAfter?: number;
}

/** How far a commit's date may run ahead of the clock, or behind its parent's, before it is refused. Covers clocks that disagree. */
const SKEW_SECONDS = 60 * 60;

export function verifyRange(root: string, range: string, signers: Signer[], options: VerifyOptions = {}): CommitCheck[] {
  const commits = git(root, ['rev-list', '--reverse', range]).split('\n').filter(Boolean);
  const byKey = new Map(signers.map((s) => [s.key, s]));
  const checks: CommitCheck[] = [];
  const dateOf = (rev: string): number => Number(git(root, ['log', '-1', '--format=%ct', rev]));
  // For a pull request, the newest commit on the base. A prediction's time is when it reaches main, so a commit
  // that adds to the predictions cannot be dated before that: a branch cut from an old commit would otherwise
  // carry a forecast "made" long ago.
  const base = options.separate && /^[^.]+\.\.[^.]+$/.test(range) ? range.split('..')[0] : undefined;
  const baseDate = base !== undefined && refExists(root, base) ? dateOf(base) : undefined;
  const day = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);
  // The terms defined in the claims library at a commit. A claim's fingerprint takes in the definitions of the terms it pins.
  const libraryTerms = new Map<string, Map<string, Term>>();
  const termsAt = (rev: string): Map<string, Term> => {
    let terms = libraryTerms.get(rev);
    if (!terms) {
      terms = new Map();
      for (const path of (tryGit(root, ['ls-tree', '-r', '--name-only', rev, '--', 'claims']) ?? '').split('\n').filter((name) => /\.ya?ml$/.test(name))) {
        const text = tryGit(root, ['show', `${rev}:${path}`]);
        if (text !== undefined) for (const [key, term] of parseFile(text, path).terms) terms.set(key, term);
      }
      libraryTerms.set(rev, terms);
    }
    return terms;
  };
  /** Predictions first recorded inside this range, with the commit that brought each in. */
  const born = new Map<string, string>();
  for (const commit of commits) {
    const check: CommitCheck = { commit, subject: git(root, ['log', '-1', '--format=%s', commit]), problems: [] };
    const parents = git(root, ['log', '-1', '--format=%P', commit]).split(' ').filter(Boolean);
    const merge = parents.length > 1 ? mergeKind(root, commit, parents) : undefined;
    if (merge) check.merge = merge.kind;

    // A commit's date is typed by whoever makes it. Two bounds keep it honest without a clock of our own:
    // it cannot be earlier than the commit it builds on, and it cannot be later than now.
    const dated = dateOf(commit);
    const newest = Math.max(0, ...parents.map(dateOf));
    if (dated < newest - SKEW_SECONDS) check.problems.push(`dated ${day(dated)}, before the commit it builds on (${day(newest)}). A commit cannot be older than its parent.`);
    if (options.notAfter !== undefined && dated > options.notAfter + SKEW_SECONDS) check.problems.push(`dated ${day(dated)}, which has not happened yet.`);

    const unsigned: string[] = [];
    const { payload, signature } = splitCommit(gitBuffer(root, ['cat-file', 'commit', commit]));
    if (!signature) {
      unsigned.push('not signed');
    } else {
      const result = checkSshSignature(payload, signature);
      if (!result.ok) unsigned.push(result.problem ?? 'bad signature');
      else {
        const signer = byKey.get(result.key as string);
        if (signer) check.signer = signer;
        else unsigned.push('signed with a key that is not on the list');
      }
    }
    if (merge?.kind !== 'clean') {
      check.problems.push(...unsigned);
      if (merge && unsigned.length > 0) check.problems.push(`this merge needs a trusted signature, because ${merge.why}`);
    }

    const signer = check.signer;
    if (signer && merge?.kind !== 'clean') {
      // With -m a merge is compared with each parent in turn; an ordinary commit has one.
      const tracked = (path: string): boolean => /^(arguments|claims)\/.*\.ya?ml$/.test(path);
      let changed = [...new Set(git(root, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-m', commit]).split('\n').filter(tracked))];
      // Redefining a term in the library rewords every claim that pins it, in files this commit never touched.
      // When a definition changed, look at every file, so a test waiting on such a claim is not left behind unseen.
      const definitions = (rev: string): string => JSON.stringify([...termsAt(rev)].map(([key, term]) => [key, term.definition]).sort());
      if (changed.some((path) => path.startsWith('claims/')) && parents.some((parent) => definitions(parent) !== definitions(commit))) {
        changed = [...new Set([...changed, ...(tryGit(root, ['ls-tree', '-r', '--name-only', commit, '--', 'arguments', 'claims']) ?? '').split('\n').filter(tracked)])];
      }
      // Predictions are followed across every file the commit touches, so moving a claim to another file does not look like deleting its tests.
      const hadPredictions = new Map<string, Tracked>();
      const hasPredictions = new Map<string, Tracked>();
      const commitDay = day(dated);
      /** Trust labels across every file the commit touches: before (one map per parent) and now. */
      const labelsBefore = parents.map(() => new Map<string, { trust: string; by?: string }>());
      const labelsNow = new Map<string, { trust: string; by?: string }>();
      /** Claims that exist now and rest on other claims, so are no longer bets. */
      const supportedNow = new Set<string>();
      for (const path of changed) {
        const read = (rev: string): RawFile | undefined => {
          const text = tryGit(root, ['show', `${rev}:${path}`]);
          if (text === undefined) return undefined;
          const file = parseFile(text, path);
          pinClaims(file.claims.values(), new Map([...termsAt(rev), ...file.terms]));
          return file;
        };
        const now = read(commit);
        const was = parents.map(read);
        for (const file of was) track(file, hadPredictions);
        track(now, hasPredictions);
        for (const issue of now?.issues ?? []) if (issue.code === 'prediction-shape') check.problems.push(`${path}: ${issue.message}`);

        was.forEach((file, at) => {
          for (const [id, label] of labels(file)) (labelsBefore[at] as Map<string, { trust: string; by?: string }>).set(id, label);
        });
        for (const [id, label] of labels(now)) labelsNow.set(id, label);
        for (const claim of now?.claims.values() ?? []) if (claim.because.length > 0) supportedNow.add(claim.id);
        const fingerprints = new Map([...(now?.claims.values() ?? [])].map((claim) => [claim.id, claimRev(claim)]));

        const after = recordsOf(now);
        const earlierRecords = was.map(recordsOf);
        // What was already on record in any parent is not new, so a merge answers only for what it adds itself.
        const known = (kind: 'reviews' | 'evidence' | 'log'): string[] => earlierRecords.flatMap((r) => r[kind]);
        // What a commit takes away: on record in every parent, and gone now. A signer can take back only their own.
        const gone = (kind: 'reviews' | 'evidence' | 'log'): string[] => {
          const perParent = earlierRecords.map((r) => added(after[kind], r[kind]));
          return (perParent[0] ?? []).filter((item) => perParent.every((list) => list.includes(item)));
        };
        for (const item of added(known('reviews'), after.reviews)) {
          const [claim, by, kind, , , , rev] = JSON.parse(item) as [string, string, string, string, string, string, string];
          if (by !== signer.name) check.problems.push(`${path}: a review of "${claim}" is recorded as by "${by}", but the commit was signed by ${signer.principal}`);
          else if (signer.kind !== 'unknown' && kind !== signer.kind) {
            check.problems.push(`${path}: the review of "${claim}" says its reviewer is ${kind === 'ai' ? 'an AI' : 'a person'}, but ${signer.principal} is listed as ${signer.kind === 'ai' ? 'an AI' : 'a person'}`);
          }
          // A new review has to say which wording it judged, with the full fingerprint. With the short one or none,
          // it would carry over to a wording the reviewer never saw.
          if (rev !== fingerprints.get(claim)) {
            check.problems.push(`${path}: the review of "${claim}" by ${by} ${rev === '' ? 'carries no fingerprint' : 'does not carry the fingerprint'} of the claim as it reads. Record reviews with "argmap review" or the add_review tool, which write it.`);
          }
        }
        for (const item of added(known('evidence'), after.evidence)) {
          const [claim, by] = JSON.parse(item) as [string, string];
          if (by !== signer.name) check.problems.push(`${path}: evidence on "${claim}" is recorded as added by "${by || 'nobody'}", but the commit was signed by ${signer.principal}`);
        }
        for (const item of added(known('log'), after.log)) {
          const [by] = JSON.parse(item) as [string];
          if (by !== signer.name) check.problems.push(`${path}: a log entry is recorded as by "${by}", but the commit was signed by ${signer.principal}`);
        }
        for (const item of gone('reviews')) {
          const [claim, by] = JSON.parse(item) as [string, string];
          if (by !== signer.name) check.problems.push(`${path}: ${by}'s review of "${claim}" was changed or removed by ${signer.principal}. A signer can take back only what is in their own name.`);
        }
        for (const item of gone('evidence')) {
          const [claim, by] = JSON.parse(item) as [string, string];
          if (by !== '' && by !== signer.name) check.problems.push(`${path}: evidence on "${claim}" added by ${by} was changed or removed by ${signer.principal}. A signer can take back only what is in their own name.`);
        }
        for (const item of gone('log')) {
          const [by] = JSON.parse(item) as [string];
          if (by !== signer.name) check.problems.push(`${path}: a log entry by ${by} was changed or removed by ${signer.principal}. The log is a record, and a signer can take back only what is in their own name.`);
        }
      }
      // A trust label carries the name of whoever set it, and that name vouches for the bet. A signer can put down
      // only their own name. A label that carries someone else's name cannot be changed, stripped or deleted,
      // except by taking it over in the signer's own name, or by giving the claim support so it stops being a bet.
      const where = changed.length === 1 ? (changed[0] as string) : 'trust labels';
      for (const [id, label] of labelsNow) {
        if (labelsBefore.length > 0 && labelsBefore.some((b) => b.get(id)?.trust === label.trust && b.get(id)?.by === label.by)) continue;
        if (label.by !== undefined && label.by !== signer.name) {
          check.problems.push(`${where}: the trust label on "${id}" is recorded as set by "${label.by}", but the commit was signed by ${signer.principal}`);
        }
      }
      for (const [id, earlier] of labelsBefore[0] ?? []) {
        if (earlier.by === undefined || earlier.by === signer.name) continue;
        // Only what every parent agreed on, and this commit changed, is this commit's doing.
        if (!labelsBefore.every((b) => b.get(id)?.trust === earlier.trust && b.get(id)?.by === earlier.by)) continue;
        const label = labelsNow.get(id);
        if (label?.trust === earlier.trust && label.by === earlier.by) continue;
        if (label?.by === signer.name || label?.by === earlier.by || supportedNow.has(id)) continue;
        check.problems.push(`${where}: the trust label on "${id}" carried ${earlier.by}'s name, and ${signer.principal} ${label ? 'changed it without putting their own name on it' : 'removed it'}`);
      }
      check.problems.push(...predictionProblems(hadPredictions, hasPredictions, signer, changed.length === 1 ? (changed[0] as string) : 'predictions', commitDay));
      const grew = [...hasPredictions].some(([key, now]) => {
        const old = hadPredictions.get(key);
        return !old || (old.outcome === undefined && now.outcome !== undefined) || (!old.overdue && now.overdue !== undefined) || now.accepted.length > old.accepted.length;
      });
      if (grew && baseDate !== undefined && dated < baseDate - SKEW_SECONDS) {
        check.problems.push(`adds to the predictions but is dated ${day(dated)}, before the newest commit on the base (${day(baseDate)}). Rebase onto the base first: a prediction's time is when it reaches main.`);
      }
      for (const [key, now] of hasPredictions) {
        if (!hadPredictions.has(key)) born.set(key, commit);
        else if (options.separate && now.outcome !== undefined && hadPredictions.get(key)?.outcome === undefined && born.has(key)) {
          check.problems.push(
            `the outcome of the prediction on "${now.claim}" ("${now.says}") is in the same set of commits as the prediction itself (${(born.get(key) as string).slice(0, 7)}). The prediction must be merged first, and its outcome recorded afterwards.`,
          );
        }
      }
    }
    checks.push(check);
  }
  return checks;
}
