import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitBuffer, refExists, tryGit } from './git.ts';
import { parseFile } from './parse.ts';
import type { RawFile } from './parse.ts';

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
  problems: string[];
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
 */
export function verifyRange(root: string, range: string, signers: Signer[]): CommitCheck[] {
  const commits = git(root, ['rev-list', '--reverse', range]).split('\n').filter(Boolean);
  const byKey = new Map(signers.map((s) => [s.key, s]));
  const checks: CommitCheck[] = [];
  for (const commit of commits) {
    const check: CommitCheck = { commit, subject: git(root, ['log', '-1', '--format=%s', commit]), problems: [] };
    const { payload, signature } = splitCommit(gitBuffer(root, ['cat-file', 'commit', commit]));
    if (!signature) {
      check.problems.push('not signed');
    } else {
      const result = checkSshSignature(payload, signature);
      if (!result.ok) check.problems.push(result.problem ?? 'bad signature');
      else {
        const signer = byKey.get(result.key as string);
        if (signer) check.signer = signer;
        else check.problems.push('signed with a key that is not on the list');
      }
    }

    const signer = check.signer;
    const parents = git(root, ['log', '-1', '--format=%P', commit]).split(' ').filter(Boolean);
    if (signer && parents.length <= 1) {
      const changed = git(root, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit])
        .split('\n')
        .filter((path) => /^(arguments|claims)\/.*\.ya?ml$/.test(path));
      for (const path of changed) {
        const read = (rev: string): RawFile | undefined => {
          const text = tryGit(root, ['show', `${rev}:${path}`]);
          return text === undefined ? undefined : parseFile(text, path);
        };
        const before = recordsOf(parents[0] ? read(parents[0]) : undefined);
        const after = recordsOf(read(commit));
        for (const item of added(before.reviews, after.reviews)) {
          const [claim, by, kind] = JSON.parse(item) as [string, string, string];
          if (by !== signer.name) check.problems.push(`${path}: a review of "${claim}" is recorded as by "${by}", but the commit was signed by ${signer.principal}`);
          else if (signer.kind !== 'unknown' && kind !== signer.kind) {
            check.problems.push(`${path}: the review of "${claim}" says its reviewer is ${kind === 'ai' ? 'an AI' : 'a person'}, but ${signer.principal} is listed as ${signer.kind === 'ai' ? 'an AI' : 'a person'}`);
          }
        }
        for (const item of added(before.evidence, after.evidence)) {
          const [claim, by] = JSON.parse(item) as [string, string];
          if (by !== signer.name) check.problems.push(`${path}: evidence on "${claim}" is recorded as added by "${by || 'nobody'}", but the commit was signed by ${signer.principal}`);
        }
        for (const item of added(before.log, after.log)) {
          const [by] = JSON.parse(item) as [string];
          if (by !== signer.name) check.problems.push(`${path}: a log entry is recorded as by "${by}", but the commit was signed by ${signer.principal}`);
        }
      }
    }
    checks.push(check);
  }
  return checks;
}
