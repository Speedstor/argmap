import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { claimRev } from '../src/index.ts';
import { isOwner, parseSigners, verifyRange } from '../src/verify.ts';

let root: string;
const run = (args: string[], input?: string): string =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', input }).trim();

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

interface Key {
  privateKey: KeyObject;
  blob: Buffer;
  listed: string;
}

function makeKey(): Key {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  const blob = wire('ssh-ed25519', raw);
  return { privateKey, blob, listed: `ssh-ed25519 ${blob.toString('base64')}` };
}

/** Sign the way `git commit -S` does with an SSH key. */
function sshSignature(payload: Buffer, key: Key): string {
  const digest = createHash('sha512').update(payload).digest();
  const signature = sign(null, Buffer.concat([Buffer.from('SSHSIG'), wire('git', '', 'sha512', digest)]), key.privateKey);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1);
  const blob = Buffer.concat([Buffer.from('SSHSIG'), version, wire(key.blob, 'git', '', 'sha512', wire('ssh-ed25519', signature))]);
  const body = (blob.toString('base64').match(/.{1,70}/g) ?? []).join('\n');
  return `-----BEGIN SSH SIGNATURE-----\n${body}\n-----END SSH SIGNATURE-----`;
}

let clock = 1_700_000_000;

/** Write files and commit them, signed with `key` or unsigned. Returns the commit id. */
function commit(files: Record<string, string>, subject: string, key?: Key): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  run(['add', '-A']);
  const tree = run(['write-tree']);
  let parent = '';
  try {
    parent = run(['rev-parse', '--verify', '--quiet', 'HEAD']);
  } catch {
    parent = '';
  }
  const who = `Tester <tester@example.com> ${clock++} +0000`;
  const head = `tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author ${who}\ncommitter ${who}\n`;
  const payload = `${head}\n${subject}\n`;
  const raw = key ? `${head}gpgsig ${sshSignature(Buffer.from(payload), key).split('\n').join('\n ')}\n\n${subject}\n` : payload;
  const id = run(['hash-object', '-t', 'commit', '-w', '--stdin'], raw);
  run(['update-ref', 'HEAD', id]);
  return id;
}

const claims = (review: string): string => `claims:
  fact:
    text: Output was 10 Mt in 2005.
    bet: assumed
${review}`;
/** The fingerprint a review of that claim has to carry. */
const FACT = claimRev({ text: 'Output was 10 Mt in 2005.', because: [] });

const ann = makeKey();
const bot = makeKey();
const stranger = makeKey();
const signers = parseSigners(`# trusted keys
ann@person ${ann.listed} Ann's laptop
model-x@ai namespaces="git" ${bot.listed}
ca@person cert-authority ${stranger.listed}
`);

const roots: string[] = [];
function newRepo(): void {
  root = mkdtempSync(join(tmpdir(), 'argmap-verify-'));
  roots.push(root);
  run(['init', '-q', '-b', 'main']);
  // The merge tests ask git to merge, which needs a name to write down.
  run(['config', 'user.name', 'Tester']);
  run(['config', 'user.email', 'tester@example.com']);
  run(['config', 'commit.gpgsign', 'false']);
}

before(newRepo);

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

test('the list is read in the format git uses, and a certificate authority is not trusted by name', () => {
  assert.deepEqual(
    signers.map((s) => [s.principal, s.name, s.kind, s.label]),
    [
      ['ann@person', 'ann', 'person', "Ann's laptop"],
      ['model-x@ai', 'model-x', 'ai', undefined],
    ],
  );
  // Two keys can carry the same name: one identity, signing from two places.
  const two = parseSigners(`model-x@ai ${bot.listed} project key\nmodel-x@ai ${stranger.listed} workspace key\n`);
  assert.deepEqual(two.map((s) => [s.name, s.label]), [['model-x', 'project key'], ['model-x', 'workspace key']]);
  assert.notEqual(two[0]?.key, two[1]?.key);
});

test('commits are attributed by signature, and records must be in the signer\'s own name', () => {
  const ids = [
    commit({ 'claims/facts.yaml': claims('') }, 'add a fact', ann),
    commit({ 'claims/facts.yaml': claims(`    reviews:\n      - { by: ann, kind: person, verdict: confirm, rev: ${FACT} }\n`) }, 'ann reviews', ann),
    commit(
      { 'claims/facts.yaml': claims(`    reviews:\n      - { by: ann, kind: person, verdict: confirm, rev: ${FACT} }\n      - { by: model-x, kind: ai, verdict: reject, rev: ${FACT} }\n`) },
      'the model reviews',
      bot,
    ),
    commit(
      {
        'claims/facts.yaml': claims(
          `    reviews:\n      - { by: ann, kind: person, verdict: confirm, rev: ${FACT} }\n      - { by: model-x, kind: ai, verdict: reject, rev: ${FACT} }\n      - { by: ann, kind: person, verdict: reject, note: forged, rev: ${FACT} }\n`,
        ),
      },
      'the model writes a review as ann',
      bot,
    ),
    commit({ 'claims/facts.yaml': claims('    evidence:\n      - { kind: paper, says: It did., source: "doi:1", by: model-x }\n') }, 'the model claims to be a person', bot),
    commit({ 'notes.txt': 'unsigned\n' }, 'unsigned change'),
    commit({ 'notes.txt': 'stranger\n' }, 'signed by a stranger', stranger),
  ];
  const checks = verifyRange(root, 'HEAD', signers);
  assert.deepEqual(
    checks.map((c) => c.commit),
    ids,
  );
  assert.deepEqual(
    checks.map((c) => c.signer?.principal),
    ['ann@person', 'ann@person', 'model-x@ai', 'model-x@ai', 'model-x@ai', undefined, undefined],
  );
  assert.deepEqual(checks[0]?.problems, []);
  assert.deepEqual(checks[1]?.problems, []);
  assert.deepEqual(checks[2]?.problems, []);
  assert.match(checks[3]?.problems[0] ?? '', /recorded as by "ann", but the commit was signed by model-x@ai/);
  // That commit replaced the reviews with evidence. Taking away someone else's review is refused; taking back its own is not.
  assert.equal(checks[4]?.problems.length, 2);
  assert.ok(checks[4]?.problems.every((p) => /ann's review of "fact" was changed or removed by model-x@ai/.test(p)));
  assert.deepEqual(checks[5]?.problems, ['not signed']);
  assert.deepEqual(checks[6]?.problems, ['signed with a key that is not on the list']);
});

test('a reviewer cannot pass as the other kind', () => {
  commit({ 'claims/facts.yaml': claims(`    reviews:\n      - { by: model-x, kind: person, verdict: confirm, rev: ${FACT} }\n`) }, 'the model poses as a person', bot);
  const last = verifyRange(root, 'HEAD~1..HEAD', signers)[0];
  assert.match(last?.problems[0] ?? '', /says its reviewer is a person, but model-x@ai is listed as an AI/);
});

test('a commit changed after signing no longer verifies', () => {
  const id = commit({ 'notes.txt': 'signed\n' }, 'signed note', ann);
  const raw = run(['cat-file', 'commit', id]).replace('signed note', 'altered note');
  const forged = run(['hash-object', '-t', 'commit', '-w', '--stdin'], `${raw}\n`);
  run(['update-ref', 'HEAD', forged]);
  assert.deepEqual(verifyRange(root, 'HEAD~1..HEAD', signers)[0]?.problems, ['signature does not match the commit']);
});

/** Make a commit with the given parents and tree, signed with `key` or unsigned, and move HEAD to it. */
function mergeCommit(parents: string[], tree: string, subject: string, key?: Key): string {
  const who = `Tester <tester@example.com> ${clock++} +0000`;
  const head = `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${who}\ncommitter ${who}\n`;
  const payload = `${head}\n${subject}\n`;
  const raw = key ? `${head}gpgsig ${sshSignature(Buffer.from(payload), key).split('\n').join('\n ')}\n\n${subject}\n` : payload;
  const id = run(['hash-object', '-t', 'commit', '-w', '--stdin'], raw);
  run(['reset', '-q', '--hard', id]);
  return id;
}

/** Two signed commits that start from the same place: one on each side of a merge. */
function fork(left: Record<string, string>, right: Record<string, string>): { base: string; a: string; b: string } {
  const base = commit({ 'notes.txt': 'base\n' }, 'base of a merge', ann);
  const a = commit(left, 'left side', ann);
  run(['reset', '-q', '--hard', base]);
  const b = commit(right, 'right side', bot);
  return { base, a, b };
}

const cleanTree = (a: string, b: string): string => run(['merge-tree', '--write-tree', a, b]).split('\n')[0] as string;

test('a merge that adds nothing of its own passes without a trusted signature', () => {
  const { base, a, b } = fork({ 'left.txt': 'left\n' }, { 'right.txt': 'right\n' });
  // The way GitHub's merge button and a workflow leave it: unsigned, or signed with a key that is not listed.
  for (const key of [undefined, stranger]) {
    const id = mergeCommit([a, b], cleanTree(a, b), 'Merge pull request', key);
    const checks = verifyRange(root, `${base}..HEAD`, signers);
    assert.deepEqual(checks.map((c) => c.problems), [[], [], []]);
    const merge = checks.find((c) => c.commit === id);
    assert.equal(merge?.merge, 'clean');
    assert.equal(merge?.signer, undefined);
  }
});

test('the commits a merge brings in are still checked one by one', () => {
  const base = commit({ 'notes.txt': 'base again\n' }, 'base of a merge', ann);
  const a = commit({ 'left.txt': 'more\n' }, 'left side', ann);
  run(['reset', '-q', '--hard', base]);
  const b = commit({ 'right.txt': 'unsigned\n' }, 'unsigned side');
  mergeCommit([a, b], cleanTree(a, b), 'Merge an unsigned branch');
  const checks = verifyRange(root, `${base}..HEAD`, signers);
  assert.deepEqual(checks.find((c) => c.commit === b)?.problems, ['not signed']);
  assert.equal(checks.filter((c) => c.problems.length > 0).length, 1);
});

test('a merge that was edited needs a trusted signature', () => {
  const { base, a, b } = fork({ 'left.txt': 'left 2\n' }, { 'right.txt': 'right 2\n' });
  // Something slipped into the merge that neither side had.
  run(['reset', '-q', '--hard', a]);
  run(['merge', '-q', '--no-commit', '--no-ff', b]);
  writeFileSync(join(root, 'extra.txt'), 'added in the merge\n');
  run(['add', '-A']);
  const edited = run(['write-tree']);
  run(['merge', '--abort']);

  const unsigned = mergeCommit([a, b], edited, 'Merge with an extra file');
  let check = verifyRange(root, `${base}..HEAD`, signers).find((c) => c.commit === unsigned);
  assert.equal(check?.merge, 'edited');
  assert.equal(check?.problems[0], 'not signed');
  assert.match(check?.problems[1] ?? '', /needs a trusted signature, because its files differ/);

  const signed = mergeCommit([a, b], edited, 'Merge with an extra file, signed', ann);
  check = verifyRange(root, `${base}..HEAD`, signers).find((c) => c.commit === signed);
  assert.equal(check?.merge, 'edited');
  assert.equal(check?.signer?.principal, 'ann@person');
  assert.deepEqual(check?.problems, []);
});

test('a merge whose sides conflict needs a trusted signature', () => {
  const { base, a, b } = fork({ 'same.txt': 'one way\n' }, { 'same.txt': 'another way\n' });
  const resolved = run(['rev-parse', `${a}^{tree}`]);
  const id = mergeCommit([a, b], resolved, 'Merge, keeping the left side');
  const check = verifyRange(root, `${base}..HEAD`, signers).find((c) => c.commit === id);
  assert.match(check?.problems[1] ?? '', /because its parents conflict/);
  const signed = mergeCommit([a, b], resolved, 'Merge, keeping the left side, signed', bot);
  assert.deepEqual(verifyRange(root, `${base}..HEAD`, signers).find((c) => c.commit === signed)?.problems, []);
});

test('an edited merge answers for the records it adds, and not for those its parents had', () => {
  const review = (by: string, kind: string): string => `      - { by: ${by}, kind: ${kind}, verdict: confirm, rev: ${FACT} }\n`;
  const { base, a, b } = fork(
    { 'claims/merge-a.yaml': claims(`    reviews:\n${review('ann', 'person')}`).replace('fact:', 'fact-a:') },
    { 'claims/merge-b.yaml': claims(`    reviews:\n${review('model-x', 'ai')}`).replace('fact:', 'fact-b:') },
  );
  run(['reset', '-q', '--hard', a]);
  run(['merge', '-q', '--no-commit', '--no-ff', b]);
  // The model merges, and writes a review as ann while doing it.
  writeFileSync(
    join(root, 'claims/merge-b.yaml'),
    claims(`    reviews:\n${review('model-x', 'ai')}      - { by: ann, kind: person, verdict: reject, note: forged, rev: ${FACT} }\n`).replace('fact:', 'fact-b:'),
  );
  run(['add', '-A']);
  const forged = run(['write-tree']);
  run(['merge', '--abort']);
  const id = mergeCommit([a, b], forged, 'Merge, with a forged review', bot);
  const check = verifyRange(root, `${base}..HEAD`, signers).find((c) => c.commit === id);
  assert.equal(check?.problems.length, 1);
  assert.match(check?.problems[0] ?? '', /a review of "fact-b" is recorded as by "ann", but the commit was signed by model-x@ai/);
});

/* ---------- Predictions: the guess must come first ---------- */

const LICENCES = 'At least 9 in 10 public repositories with over 1,000 stars carry a licence file.';
const licences = (rest: string, vouchedBy = 'ann'): string => `claims:
  licences:
    text: ${LICENCES}
    bet: { trust: assumed, by: ${vouchedBy} }
${rest}`;

/** Date the commits that follow. A date written in a record has to match the commit that records it. */
const on = (day: string): void => {
  clock = Date.parse(`${day}T12:00:00Z`) / 1000;
};
/** A repository of its own for one test, with a first commit on the given day. Commits cannot be dated before their parents. */
const startOn = (day: string): void => {
  newRepo();
  on(day);
  commit({ 'README.md': 'start\n' }, 'start', ann);
};

const guess = (rest = '', p = 0.8): string => `    predictions:
      - says: Of 60 such repositories drawn at random, at least 51 have a licence file.
        how: A repository counts when a LICENSE or COPYING file is at its top level.
        type: lookup
        p: ${p}
        if_false: 0.2
        sample: 60
        needs: 51
        by: ann
        made: 2026-11-14
        due: 2026-11-28
        rev: ${claimRev({ text: LICENCES, because: [] })}
${rest}`;

const annAccepts = '        accepted: [{ by: ann, kind: person, date: 2026-11-14 }]\n';
const outcomeBy = (by: string, kind: string, found = 47): string =>
  `        outcome: ${found >= 51 ? 'yes' : 'no'}\n        found: ${found}\n        resolved: 2026-11-20\n        resolved_by: ${by}\n        resolved_kind: ${kind}\n        source: https://example.org/sample-of-60.csv\n`;

/** Problems of every commit after `from`, oldest first. */
const since = (from: string, options: { separate?: boolean } = {}): string[][] => verifyRange(root, `${from}..HEAD`, signers, options).map((c) => c.problems);
const head = (): string => run(['rev-parse', 'HEAD']);

test('a prediction, then its acceptance and outcome in later commits, each in the signer\'s name, pass', () => {
  startOn('2026-11-14');
  const from = head();
  const file = 'claims/p1.yaml';
  on('2026-11-14');
  commit({ [file]: licences('') }, 'ann makes a bet', ann);
  commit({ [file]: licences(guess(annAccepts)) }, 'ann predicts', ann);
  on('2026-11-20');
  commit({ [file]: licences(guess(annAccepts + outcomeBy('model-x', 'ai'))) }, 'the model records what it found', bot);
  commit({ [file]: licences(guess(`${annAccepts + outcomeBy('model-x', 'ai')}        confirmed: [{ by: ann, kind: person, date: 2026-11-21 }]\n`)) }, 'ann confirms the outcome', ann);
  assert.deepEqual(since(from), [[], [], [], []]);
  // In a pull request the prediction must already be merged, so the same four commits in one range do not pass.
  const strict = since(from, { separate: true });
  assert.match(strict[2]?.[0] ?? '', /is in the same set of commits as the prediction itself/);
  assert.deepEqual([strict[0], strict[1], strict[3]], [[], [], []]);
  // With the prediction already behind the range, the outcome passes.
  assert.deepEqual(verifyRange(root, 'HEAD~2..HEAD', signers, { separate: true }).map((c) => c.problems), [[], []]);
});

test('a prediction cannot arrive with its outcome, be edited, or be removed', () => {
  startOn('2026-11-14');
  const file = 'claims/p2.yaml';
  on('2026-11-14');
  commit({ [file]: licences('') }, 'ann makes a bet', ann);
  let from = head();
  commit({ [file]: licences(guess(annAccepts + outcomeBy('ann', 'person', 55))) }, 'a prediction made after looking', ann);
  assert.match(since(from)[0]?.[0] ?? '', /arrived together with its outcome/);

  commit({ [file]: licences(guess(annAccepts)) }, 'ann predicts 80%', ann);
  from = head();
  commit({ [file]: licences(guess(annAccepts, 0.95)) }, 'ann raises it to 95%', ann);
  assert.match(since(from)[0]?.[0] ?? '', /was changed or removed .*wording, chances and dates are fixed/);

  from = head();
  commit({ [file]: licences('') }, 'ann deletes the prediction', ann);
  assert.match(since(from)[0]?.[0] ?? '', /was changed or removed/);
});

test('an outcome is recorded once, and in the name of whoever signs', () => {
  startOn('2026-11-14');
  const file = 'claims/p3.yaml';
  on('2026-11-14');
  commit({ [file]: licences('') }, 'ann makes a bet', ann);
  commit({ [file]: licences(guess(annAccepts)) }, 'ann predicts', ann);
  on('2026-11-20');
  let from = head();
  commit({ [file]: licences(guess(annAccepts + outcomeBy('ann', 'person'))) }, 'the model records an outcome as ann', bot);
  assert.match(since(from)[0]?.[0] ?? '', /the outcome of the prediction .* is recorded as by "ann", but the commit was signed by model-x@ai/);
  from = head();
  commit({ [file]: licences(guess(annAccepts + outcomeBy('ann', 'person', 55))) }, 'the outcome turns into a yes', ann);
  assert.match(since(from)[0]?.[0] ?? '', /the outcome of .* was changed or removed. An outcome is recorded once/);
});

test('only someone who vouches for a claim can accept a test of it, and only before the outcome', () => {
  startOn('2026-11-14');
  const file = 'claims/p4.yaml';
  on('2026-11-14');
  commit({ [file]: licences('') }, 'ann makes a bet', ann);
  commit({ [file]: licences(guess()) }, 'ann predicts', ann);
  let from = head();
  commit({ [file]: licences(guess('        accepted: [{ by: model-x, kind: ai }]\n')) }, 'the model accepts a test of a claim it does not vouch for', bot);
  assert.match(since(from)[0]?.[0] ?? '', /model-x accepted .* without vouching for the claim/);

  // Putting someone else's name on the trust label would make them vouch for it.
  from = head();
  commit({ 'claims/p5.yaml': licences('') }, 'the model names ann on a bet', bot);
  assert.match(since(from)[0]?.[0] ?? '', /the trust label on "licences" is recorded as set by "ann", but the commit was signed by model-x@ai/);

  commit({ 'claims/p6.yaml': licences(guess()) }, 'ann bets and predicts', ann);
  on('2026-11-20');
  commit({ 'claims/p6.yaml': licences(guess(outcomeBy('model-x', 'ai'))) }, 'the model records a failure', bot);
  from = head();
  commit({ 'claims/p6.yaml': licences(guess(annAccepts + outcomeBy('model-x', 'ai'))) }, 'ann accepts after the fact', ann);
  assert.match(since(from)[0]?.[0] ?? '', /was accepted when its outcome was already known/);
});

/* ---------- Attacks found in review: each passed verify before, and is refused now ---------- */

// Two bets in one file: ann vouches for the first, and the second has whoever is named.
const SHOPS = 'Every shop on the street opens before nine.';
const OTHER = 'The street has a bakery.';
const street = (onShops: string, onOther = '', otherBy = 'bob'): string => `claims:
  shops:
    text: ${SHOPS}
    bet: { trust: assumed, by: ann }
${onShops}  other:
    text: ${OTHER}
    bet: { trust: assumed, by: ${otherBy} }
${onOther}`;
const door = (o: { says?: string; by?: string; rev?: string; made?: string; due?: string; type?: string; rest?: string } = {}): string => `    predictions:
      - says: ${o.says ?? 'The bakery opens before nine.'}
        how: Read the sign on the door.
        type: ${o.type ?? 'lookup'}
        p: 0.9
        if_false: 0.3
        by: ${o.by ?? 'ann'}
        made: ${o.made ?? '2026-11-14'}
        due: ${o.due ?? '2026-11-28'}
        rev: ${o.rev ?? claimRev({ text: SHOPS, because: [] })}
${o.rest ?? ''}`;
const acceptedBy = (by: string): string => `        accepted: [{ by: ${by}, kind: person, date: 2026-11-14 }]\n`;
const doorSays = (word: string, by: string): string => `        outcome: "${word}"\n        resolved: 2026-11-20\n        resolved_by: ${by}\n        resolved_kind: person\n        source: https://example.org/door\n`;
const bob = makeKey();
const three = parseSigners(`ann@person ${ann.listed}\nbob@person ${bob.listed}\nmodel-x@ai ${bot.listed}\n`);
const sinceWith = (from: string): string[] => verifyRange(root, `${from}..HEAD`, three).flatMap((c) => c.problems);

test('a test cannot be carried from one claim to another', () => {
  startOn('2026-11-14');
  const file = 'claims/a1.yaml';
  on('2026-11-14');
  commit({ [file]: street('', '', 'ann') }, 'ann bets', ann);
  commit({ [file]: street(door({ rest: acceptedBy('ann') })) }, 'ann predicts', ann);
  on('2026-11-20');
  commit({ [file]: street(door({ rest: acceptedBy('ann') + doorSays('no', 'ann') })) }, 'it fails', ann);
  const from = head();
  // Laundering a failure: move the failed test to a claim nobody reads.
  commit({ [file]: street('', door({ rest: acceptedBy('ann') + doorSays('no', 'ann') })) }, 'ann moves the failed test', ann);
  const found = sinceWith(from);
  assert.ok(found.some((p) => /a prediction on "shops" was changed or removed/.test(p)));
  assert.ok(found.some((p) => /the prediction on "other" .* arrived together with its outcome/.test(p)));
  assert.ok(found.some((p) => /does not carry the fingerprint of the claim it is recorded on/.test(p)));
});

test('nobody can knock out a claim by vouching for a test somewhere else', () => {
  startOn('2026-11-14');
  const file = 'claims/a2.yaml';
  on('2026-11-14');
  commit({ [file]: street('', '').replace('by: bob', 'by: ann') }, 'ann bets', ann);
  commit({ [file]: street('', '') }, 'bob takes the second bet in his own name', bob);
  let from = head();
  // Bob sets a strawman on his own claim, typed with the fingerprint of ann's, and accepts it himself.
  const straw = (rest: string): string => door({ says: 'Every shop on the street is open at 3am.', by: 'bob', rest });
  commit({ [file]: street('', straw(acceptedBy('bob'))) }, 'bob sets a strawman on his own claim', bob);
  assert.ok(sinceWith(from).some((p) => /does not carry the fingerprint of the claim it is recorded on/.test(p)));
  on('2026-11-20');
  commit({ [file]: street('', straw(acceptedBy('bob') + doorSays('no', 'bob'))) }, 'bob records no', bob);
  from = head();
  commit({ [file]: street(straw(acceptedBy('bob') + doorSays('no', 'bob')), '') }, 'bob moves it onto ann\'s claim', bob);
  const found = sinceWith(from);
  assert.ok(found.some((p) => /a prediction on "other" was changed or removed/.test(p)));
  assert.ok(found.some((p) => /the prediction on "shops" .* arrived together with its outcome/.test(p)));
  assert.ok(found.some((p) => /bob accepted .* without vouching for the claim/.test(p)));
});

test('a prediction copied under another claim is a new prediction, and is refused with its outcome', () => {
  startOn('2026-11-14');
  const file = 'claims/a3.yaml';
  on('2026-11-14');
  commit({ [file]: street('', '', 'ann') }, 'ann bets', ann);
  commit({ [file]: street(door({ rest: acceptedBy('ann') })) }, 'ann predicts', ann);
  on('2026-11-20');
  const passed = door({ rest: acceptedBy('ann') + doorSays('yes', 'ann') });
  commit({ [file]: street(passed) }, 'it passes', ann);
  const from = head();
  commit({ [file]: street(passed, passed) }, 'ann copies it under the other claim', ann);
  assert.ok(sinceWith(from).some((p) => /the prediction on "other" .* arrived together with its outcome/.test(p)));
  // Written twice under the same claim, the file does not load, and verify says so.
  const twice = street(passed + passed.replace('    predictions:\n', ''));
  commit({ [file]: twice }, 'ann writes it twice', ann);
  assert.ok(sinceWith(from).some((p) => /is the same prediction as an earlier one/.test(p)));
});

test('only its setter can withdraw a prediction', () => {
  startOn('2026-11-14');
  const file = 'claims/a4.yaml';
  on('2026-11-14');
  commit({ [file]: street('', '', 'ann') }, 'ann bets', ann);
  commit({ [file]: street(door({ rest: acceptedBy('ann') })) }, 'ann predicts', ann);
  const from = head();
  on('2026-11-15');
  commit({ [file]: street(door({ rest: `${acceptedBy('ann')}        outcome: void\n        resolved: 2026-11-15\n        resolved_by: bob\n        note: Changed my mind.\n` })) }, 'bob withdraws ann\'s test', bob);
  assert.ok(sinceWith(from).some((p) => /bob withdrew the prediction .* which ann set/.test(p)));
});

test('a signer can take back only what is in their own name', () => {
  startOn('2026-11-14');
  const file = 'claims/a5.yaml';
  const bet = (rest: string): string => `claims:\n  shops:\n    text: ${SHOPS}\n    bet: assumed\n${rest}`;
  const bobs = `    evidence:\n      - { kind: account, stance: against, says: The bakery opened at ten., source: "https://example.org/x", by: bob }\n    reviews:\n      - { by: bob, kind: person, verdict: reject }\nlog:\n  - { at: 2026-11-14, by: bob, did: review, claim: shops }\n`;
  commit({ [file]: bet(bobs) }, 'bob rejects, with evidence', bob);
  let from = head();
  commit({ [file]: bet('') }, 'ann deletes bob\'s review, evidence and log entry', ann);
  const found = sinceWith(from);
  assert.equal(found.length, 3);
  assert.ok(found.some((p) => /bob's review of "shops" was changed or removed by ann@person/.test(p)));
  assert.ok(found.some((p) => /evidence on "shops" added by bob was changed or removed/.test(p)));
  assert.ok(found.some((p) => /a log entry by bob was changed or removed/.test(p)));
  // Bob taking back his own is his to do.
  commit({ [file]: bet(bobs) }, 'bob puts them back', bob);
  from = head();
  commit({ [file]: bet('') }, 'bob withdraws them', bob);
  assert.deepEqual(sinceWith(from), []);
});

test('a trust label that carries a name can only be changed by taking it over', () => {
  startOn('2026-11-14');
  const file = 'claims/a6.yaml';
  const label = (bet: string): string => `claims:\n  shops:\n    text: ${SHOPS}\n    bet: ${bet}\n`;
  commit({ [file]: label('{ trust: assumed, by: ann }') }, 'ann sets assumed', ann);
  let from = head();
  commit({ [file]: label('{ trust: observed, by: ann }') }, 'bob raises ann\'s label', bob);
  assert.match(sinceWith(from)[0] ?? '', /recorded as set by "ann", but the commit was signed by bob@person/);
  from = head();
  commit({ [file]: label('observed') }, 'bob strips ann\'s name', bob);
  assert.match(sinceWith(from)[0] ?? '', /carried ann's name, and bob@person changed it without putting their own name on it/);
  from = head();
  commit({ [file]: label('{ trust: assumed, by: bob }') }, 'bob takes the label over in his own name', bob);
  assert.deepEqual(sinceWith(from), []);
});

test('the dates in a prediction have to match the commits that record them', () => {
  startOn('2026-11-14');
  const file = 'claims/a7.yaml';
  on('2026-11-14');
  commit({ [file]: street('', '', 'ann') }, 'ann bets', ann);
  let from = head();
  commit({ [file]: street(door({ made: '2020-01-01', type: 'forecast' })) }, 'a forecast "made" in 2020', ann);
  assert.ok(sinceWith(from).some((p) => /says it was made on 2020-01-01, but the commit that records it is dated 2026-11-14/.test(p)));

  commit({ 'claims/a8.yaml': street(door({ due: '2030-01-01', type: 'forecast', rest: acceptedBy('ann') }), '', 'ann') }, 'ann forecasts for 2030', ann);
  from = head();
  commit({ 'claims/a8.yaml': street(door({ due: '2030-01-01', type: 'forecast', rest: `${acceptedBy('ann')}        overdue: { by: bob, kind: person, date: 2030-01-02 }\n` }), '', 'ann') }, 'bob marks it overdue years early', bob);
  assert.ok(sinceWith(from).some((p) => /the overdue marker .* is dated 2030-01-02, but the commit that records it is dated 2026-11-14/.test(p)));
});

test('a claim cannot be reworded out from under an accepted test', () => {
  startOn('2026-11-14');
  const file = 'claims/a9.yaml';
  on('2026-11-14');
  commit({ [file]: street('', '', 'ann') }, 'ann bets', ann);
  commit({ [file]: street(door({ rest: acceptedBy('ann') })) }, 'ann predicts', ann);
  const from = head();
  commit({ [file]: street(door({ rest: acceptedBy('ann') })).replace(SHOPS, 'Some shops on the street open before nine.') }, 'ann softens the claim while the test is open', ann);
  assert.ok(sinceWith(from).some((p) => /"shops" was reworded or rewired while an accepted test of it was waiting/.test(p)));
});

/* ---------- Second round of attacks ---------- */

test('a commit cannot be dated before the one it builds on, or after now', () => {
  startOn('2026-11-14');
  const file = 'claims/b1.yaml';
  commit({ [file]: street('', '', 'ann') }, 'ann bets', ann);
  let from = head();
  // A forecast "made" in 2024, in a commit dated 2024, on top of a commit from 2026.
  on('2024-01-01');
  commit({ [file]: street(door({ type: 'forecast', made: '2024-01-01', due: '2026-12-01', rest: '        accepted: [{ by: ann, kind: person, date: 2024-01-01 }]\n' }), '', 'ann') }, 'a forecast in a commit dated 2024', ann);
  assert.ok(sinceWith(from).some((p) => /dated 2024-01-01, before the commit it builds on \(2026-11-14\)/.test(p)));

  startOn('2026-11-14');
  commit({ [file]: street('', '', 'ann') }, 'ann bets', ann);
  commit({ [file]: street(door({ type: 'forecast', due: '2030-01-01', rest: acceptedBy('ann') }), '', 'ann') }, 'ann forecasts for 2030', ann);
  from = head();
  on('2030-01-03');
  commit({ [file]: street(door({ type: 'forecast', due: '2030-01-01', rest: `${acceptedBy('ann')}        overdue: { by: bob, kind: person, date: 2030-01-03 }\n` }), '', 'ann') }, 'bob marks it overdue in a commit dated 2030', bob);
  // The command line passes the present time. Here it is a day after the repository was started.
  const now = Date.parse('2026-11-15T12:00:00Z') / 1000;
  assert.match(verifyRange(root, `${from}..HEAD`, three, { notAfter: now })[0]?.problems[0] ?? '', /dated 2030-01-03, which has not happened yet/);
});

test('a label under another name cannot be removed by deleting the bet', () => {
  startOn('2026-11-14');
  const file = 'claims/b2.yaml';
  const claim = (bet: string): string => `claims:\n  shops:\n    text: ${SHOPS}\n${bet}`;
  commit({ [file]: claim('    bet: { trust: observed, by: ann }\n') }, 'ann labels it observed', ann);
  let from = head();
  commit({ [file]: claim('') }, 'bob deletes the bet', bob);
  assert.match(sinceWith(from)[0] ?? '', /the trust label on "shops" carried ann's name, and bob@person removed it/);
  // Giving the claim support is not stripping a label: it stops being a bet.
  commit({ [file]: claim('    bet: { trust: observed, by: ann }\n') }, 'ann puts it back', ann);
  from = head();
  commit({ [file]: `${claim('    because: [bakery]\n')}  bakery:\n    text: The bakery opens at eight.\n    bet: { trust: assumed, by: bob }\n` }, 'bob puts a reason under it', bob);
  assert.deepEqual(sinceWith(from), []);
});

test('someone who vouches for a claim accepts the tests they set on it', () => {
  startOn('2026-11-14');
  const file = 'claims/b3.yaml';
  commit({ [file]: street('', '', 'ann') }, 'ann bets', ann);
  const from = head();
  commit({ [file]: street(door()) }, 'ann sets a test on her own bet and leaves her acceptance off', ann);
  assert.ok(sinceWith(from).some((p) => /ann vouches for "shops" and set .* without accepting it/.test(p)));
});

test('a new review carries the full fingerprint of the claim it judged', () => {
  startOn('2026-11-14');
  const file = 'claims/b4.yaml';
  const reviewed = (reviews: string): string => `claims:\n  shops:\n    text: ${SHOPS}\n    bet: assumed\n    reviews:\n${reviews}`;
  commit({ [file]: `claims:\n  shops:\n    text: ${SHOPS}\n    bet: assumed\n` }, 'a bet', ann);
  let from = head();
  commit({ [file]: reviewed('      - { by: bob, kind: person, verdict: confirm, rev: "52dc34af" }\n') }, 'bob confirms with an 8-digit fingerprint', bob);
  assert.match(sinceWith(from)[0] ?? '', /the review of "shops" by bob does not carry the fingerprint of the claim as it reads/);
  from = head();
  commit({ [file]: reviewed('      - { by: bob, kind: person, verdict: confirm }\n') }, 'bob confirms with none', bob);
  assert.ok(sinceWith(from).some((p) => /the review of "shops" by bob carries no fingerprint/.test(p)));
  from = head();
  commit({ [file]: reviewed(`      - { by: bob, kind: person, verdict: confirm, rev: ${claimRev({ text: SHOPS, because: [] })} }\n`) }, 'bob confirms properly', bob);
  assert.deepEqual(sinceWith(from), []);
});

/* ---------- Third round ---------- */

test('in a pull request, a commit that adds to the predictions cannot be dated before the newest commit on the base', () => {
  startOn('2025-01-01');
  const file = 'claims/c1.yaml';
  const old = commit({ [file]: street('', '', 'ann') }, 'main, a year ago', ann);
  on('2026-11-14');
  const tip = commit({ 'notes.md': 'later work\n' }, 'main today', ann);
  // A branch cut from last year's main, carrying a forecast "made" last year.
  run(['reset', '-q', '--hard', old]);
  on('2025-01-02');
  commit({ [file]: street(door({ type: 'forecast', made: '2025-01-02', due: '2026-12-01', rest: '        accepted: [{ by: ann, kind: person, date: 2025-01-02 }]\n' }), '', 'ann') }, 'a forecast dated a year ago', ann);
  const inPullRequest = verifyRange(root, `${tip}..HEAD`, three, { separate: true }).flatMap((c) => c.problems);
  assert.ok(inPullRequest.some((p) => /adds to the predictions but is dated 2025-01-02, before the newest commit on the base \(2026-11-14\)/.test(p)));
  // Work that touches no prediction can still sit on an old fork point.
  run(['reset', '-q', '--hard', old]);
  commit({ 'notes.md': 'an old branch\n' }, 'unrelated work on an old branch', ann);
  assert.deepEqual(verifyRange(root, `${tip}..HEAD`, three, { separate: true }).flatMap((c) => c.problems), []);
});

test('redefining a library term is seen as rewording the claims that pin it, in files the commit did not touch', () => {
  startOn('2026-11-14');
  const library = (definition: string): string => `terms:\n  shop: ${definition}\nclaims:\n  bakery:\n    text: The street has a bakery.\n    bet: assumed\n`;
  const text = 'Every {shop} on the street opens before nine.';
  const pinned = JSON.stringify([['shop', 'A bakery.']]);
  const argument = `title: T\nconclusion: a\nclaims:\n  a:\n    text: ${text}\n    bet: { trust: assumed, by: ann }\n${door({ rev: claimRev({ text, because: [], pinned }), rest: acceptedBy('ann') })}`;
  commit({ 'claims/terms.yaml': library('A bakery.'), 'arguments/x.yaml': argument.replace(/    predictions:[\s\S]*$/, '') }, 'ann bets, using a library term', ann);
  commit({ 'arguments/x.yaml': argument }, 'ann sets a test', ann);
  assert.deepEqual(sinceWith('HEAD~1'), []);
  const from = head();
  commit({ 'claims/terms.yaml': library('Any premises that sells anything.') }, 'ann widens the term in the library only', ann);
  assert.ok(sinceWith(from).some((p) => /"a" was reworded or rewired while an accepted test of it was waiting/.test(p)));
});

/* ---------- Who may change the list of trusted keys ---------- */

const olga = makeKey();
const spare = makeKey();
const LIST = `olga@person ${olga.listed} owner on her laptop\nann@person ${ann.listed} Ann's laptop\nmodel-x@ai ${bot.listed}\n`;
const members = parseSigners(LIST);
/** A repository of its own whose list names olga as its owner. */
const startList = (): void => {
  startOn('2026-11-14');
  commit({ allowed_signers: LIST }, 'the list as it starts', olga);
};
/** What verify says about the newest commit, judged by the list the repository started with. */
const newest = (list = members): string[] => verifyRange(root, 'HEAD~1..HEAD', list)[0]?.problems ?? [];
/** The owner puts the list back as it started. An owner may change any line, so this passes. */
const putBack = (): void => {
  commit({ allowed_signers: LIST }, 'the owner puts the list back', olga);
  assert.deepEqual(newest(), []);
};

test('an owner is a line whose label starts with the word owner', () => {
  assert.deepEqual(members.map(isOwner), [true, false, false]);
  const others = parseSigners(`a@person ${spare.listed} the owner's friend\nb@person ${spare.listed} ownership papers\nc@person ${spare.listed}\n`);
  assert.deepEqual(others.map(isOwner), [false, false, false]);
  // The word has to stand alone. A label that only begins with it says something else.
  const near = parseSigners(`a@person ${spare.listed} owner's old phone\nb@person ${spare.listed} owner-emeritus\nc@person ${spare.listed} owner: no longer\nd@person ${spare.listed} owner\n`);
  assert.deepEqual(near.map(isOwner), [false, false, false, true]);
});

test('anyone on the list can invite a new name with a new key', () => {
  startList();
  commit({ allowed_signers: `${LIST}carol@person ${spare.listed} invited by the model\n` }, 'the model invites carol', bot);
  assert.deepEqual(newest(), []);
});

test('only an owner can remove or change a line', () => {
  startList();
  commit({ allowed_signers: LIST.replace(/^ann@.*\n/m, '') }, 'the model removes ann', bot);
  assert.deepEqual(newest(), ['allowed_signers: the line for ann@person was removed by model-x@ai. Only an owner can change or remove a line.']);
  putBack();
  commit({ allowed_signers: LIST.replace("Ann's laptop", 'retired') }, 'the model relabels ann', bot);
  assert.deepEqual(newest(), ['allowed_signers: the line for ann@person was changed by model-x@ai. Only an owner can change or remove a line.']);
  putBack();
  commit({ allowed_signers: LIST.replace(ann.listed, spare.listed) }, "the model swaps ann's key for another", bot);
  assert.deepEqual(newest(), ['allowed_signers: the line for ann@person was changed by model-x@ai. Only an owner can change or remove a line.']);
  putBack();
  // Leaving is a removal too: a member asks an owner.
  commit({ allowed_signers: LIST.replace(/^model-x@.*\n/m, '') }, 'the model removes its own line', bot);
  assert.match(newest()[0] ?? '', /the line for model-x@ai was removed by model-x@ai/);
  putBack();
  commit({ allowed_signers: LIST.replace(/^ann@.*\n/m, '') }, 'the owner removes ann', olga);
  assert.deepEqual(newest(), []);
});

test('a listed name cannot be given a second key by anyone but an owner', () => {
  startList();
  const twoKeys = `${LIST}olga@person ${spare.listed} second laptop\n`;
  commit({ allowed_signers: twoKeys }, "the model adds a key under the owner's name", bot);
  assert.deepEqual(newest(), ['allowed_signers: model-x@ai added another key under the name "olga", which is already on the list. Only an owner can give a name a second key.']);
  // Why it is refused: were that line trusted, whoever holds the second key would sign as olga.
  commit({ 'claims/facts.yaml': claims(`    reviews:\n      - { by: olga, kind: person, verdict: confirm, rev: ${FACT} }\n`) }, 'a review as olga, signed with the second key', spare);
  assert.deepEqual(newest(parseSigners(twoKeys)), []);
  assert.deepEqual(newest(), ['signed with a key that is not on the list']);
  // The same name as the other kind is still the same name.
  putBack();
  commit({ allowed_signers: `${LIST}ann@ai ${spare.listed}\n` }, 'the model adds ann as an AI', bot);
  assert.match(newest()[0] ?? '', /added another key under the name "ann"/);
  // An owner can: one identity signing from two places.
  putBack();
  commit({ allowed_signers: twoKeys }, 'the owner adds her second laptop', olga);
  assert.deepEqual(newest(), []);
});

test('nobody but an owner can name an owner, or put a listed key under another name', () => {
  startList();
  commit({ allowed_signers: `${LIST}dave@person ${spare.listed} owner\n` }, 'the model adds dave as an owner', bot);
  assert.deepEqual(newest(), ['allowed_signers: model-x@ai added dave@person as an owner. Only an owner can name an owner.']);
  putBack();
  // The later of two lines with one key wins, so this would turn ann's commits into zed's.
  commit({ allowed_signers: `${LIST}zed@person ${ann.listed}\n` }, "the model lists ann's key again as zed", bot);
  assert.deepEqual(newest(), ['allowed_signers: model-x@ai added zed@person with a key that is already on the list as ann@person. Only an owner can put a key under another name.']);
});

test('a commit cannot make its own signer an owner', () => {
  startList();
  const crowned = LIST.replace(`model-x@ai ${bot.listed}`, `model-x@ai ${bot.listed} owner`).replace(/^ann@.*\n/m, '');
  commit({ allowed_signers: crowned }, 'the model marks itself owner and removes ann', bot);
  assert.deepEqual(newest().sort(), [
    'allowed_signers: the line for ann@person was removed by model-x@ai. Only an owner can change or remove a line.',
    'allowed_signers: the line for model-x@ai was changed by model-x@ai. Only an owner can change or remove a line.',
  ]);
});

test('an edited merge answers for what it does to the list', () => {
  startList();
  const { base, a, b } = fork({ allowed_signers: `${LIST}carol@person ${spare.listed}\n` }, { 'right.txt': 'right\n' });
  // The left side invited carol, which anyone listed may do. The merge then drops ann.
  run(['reset', '-q', '--hard', a]);
  run(['merge', '-q', '--no-commit', '--no-ff', b]);
  writeFileSync(join(root, 'allowed_signers'), `${LIST.replace(/^ann@.*\n/m, '')}carol@person ${spare.listed}\n`);
  run(['add', '-A']);
  const edited = run(['write-tree']);
  run(['merge', '--abort']);
  const id = mergeCommit([a, b], edited, 'Merge, dropping ann from the list', bot);
  const checks = verifyRange(root, `${base}..HEAD`, members);
  assert.deepEqual(checks.find((c) => c.commit === a)?.problems, []);
  assert.deepEqual(checks.find((c) => c.commit === id)?.problems, ['allowed_signers: the line for ann@person was removed by model-x@ai. Only an owner can change or remove a line.']);
});

test('a list that names no owner is not held to the rule', () => {
  startOn('2026-11-14');
  commit({ allowed_signers: `ann@person ${ann.listed} Ann's laptop\nmodel-x@ai ${bot.listed}\n` }, 'a list with no owner', ann);
  commit({ allowed_signers: `model-x@ai ${bot.listed}\n` }, 'the model removes ann', bot);
  assert.deepEqual(newest(signers), []);
});

/* ---------- Ways round the rule, found in review of pull request 18: each passed before, and is refused now ---------- */

/** A merge of `tip` with `other` whose list is `list`, signed with `key`. Returns what verify says about it. */
const mergeWithList = (tip: string, other: string, list: string, key: Key, trusted: ReturnType<typeof parseSigners>): string[] => {
  writeFileSync(join(root, 'allowed_signers'), list);
  run(['add', '-A']);
  const id = mergeCommit([tip, other], run(['write-tree']), 'Merge', key);
  return verifyRange(root, `${tip}..HEAD`, trusted).find((c) => c.commit === id)?.problems ?? [];
};

test('a member cannot remove a line by merging with a commit from before the line existed', () => {
  startOn('2026-11-14');
  const old = run(['rev-parse', 'HEAD']); // no list yet
  const tip = commit({ allowed_signers: LIST }, 'the list as it starts', olga);
  assert.match(mergeWithList(tip, old, LIST.replace(/^ann@.*\n/m, ''), bot, members)[0] ?? '', /the line for ann@person was removed/);
});

test('a member cannot remove the owner line that way, which would turn the rule off', () => {
  startOn('2026-11-14');
  const old = run(['rev-parse', 'HEAD']);
  const tip = commit({ allowed_signers: LIST }, 'the list as it starts', olga);
  assert.match(mergeWithList(tip, old, LIST.replace(/^olga@.*\n/m, ''), bot, members)[0] ?? '', /the line for olga@person was removed/);
});

test('a member cannot bring back a key the owner replaced', () => {
  startOn('2026-11-14');
  const old = commit({ allowed_signers: LIST }, 'the list as it starts', olga);
  const rotated = LIST.replace(ann.listed, spare.listed);
  const tip = commit({ allowed_signers: rotated }, "the owner replaces ann's lost key", olga);
  assert.match(mergeWithList(tip, old, LIST, bot, parseSigners(rotated))[0] ?? '', /the line for ann@person was changed/);
});

test('a merge that only combines what its two sides did to the list passes', () => {
  startList();
  // One side invites carol on the line after ann, the other has the owner take ann off. The two changes touch, so git
  // cannot combine them by itself and somebody has to.
  const annLine = `ann@person ${ann.listed} Ann's laptop\n`;
  const carolLine = `carol@person ${spare.listed}\n`;
  const { base, a } = fork({ allowed_signers: LIST.replace(annLine, annLine + carolLine) }, { 'right.txt': 'right\n' });
  const removed = commit({ allowed_signers: LIST.replace(annLine, '') }, 'the owner removes ann', olga);
  writeFileSync(join(root, 'allowed_signers'), LIST.replace(annLine, carolLine));
  run(['add', '-A']);
  const id = mergeCommit([a, removed], run(['write-tree']), 'Merge, keeping both changes', bot);
  const merge = verifyRange(root, `${base}..HEAD`, members).find((c) => c.commit === id);
  assert.equal(merge?.merge, 'edited');
  assert.deepEqual(merge?.problems, []);
  // Keeping ann after all is not combining: the owner's side took her off.
  writeFileSync(join(root, 'allowed_signers'), LIST.replace(annLine, annLine + carolLine));
  run(['add', '-A']);
  const kept = mergeCommit([a, removed], run(['write-tree']), 'Merge, keeping ann', bot);
  assert.deepEqual(verifyRange(root, `${base}..HEAD`, members).find((c) => c.commit === kept)?.problems, [
    'allowed_signers: model-x@ai added the name "ann", which was on the list before and was taken off. Only an owner can bring a name back.',
  ]);
});

test('a branch cut before a name was listed cannot give that name a second key', () => {
  startOn('2026-11-14');
  const pad = '#\n#\n#\n#\n#\n#\n';
  const first = `# top\n${pad}olga@person ${olga.listed} owner\nmodel-x@ai ${bot.listed}\n${pad}# bottom\n`;
  const cut = commit({ allowed_signers: first }, 'the list as it starts', olga);
  const withAnn = first.replace('# bottom\n', `ann@person ${ann.listed} Ann's laptop\n# bottom\n`);
  const main = commit({ allowed_signers: withAnn }, 'the owner adds ann', olga);
  run(['reset', '-q', '--hard', cut]);
  const branch = commit({ allowed_signers: first.replace('# top\n', `# top\nann@person ${spare.listed}\n`) }, 'the model invites someone called ann', bot);
  // GitHub's merge button: the two sides do not conflict, so the merge is clean and main ends up with two keys for ann.
  const merged = mergeCommit([main, branch], cleanTree(main, branch), 'Merge pull request');
  const trusted = parseSigners(withAnn);
  // As a pull request, judged against the list it will join: the branch's own commit is refused.
  const asPullRequest = verifyRange(root, `${main}..${branch}`, trusted).flatMap((c) => c.problems);
  assert.deepEqual(asPullRequest, ['allowed_signers: model-x@ai added another key under the name "ann", which is already on the list. Only an owner can give a name a second key.']);
  // And when the whole history is read, with no base to compare with, the merge that brought the line in is refused.
  const whole = verifyRange(root, 'HEAD', trusted);
  assert.equal(whole.find((c) => c.commit === merged)?.merge, 'clean');
  assert.match(whole.find((c) => c.commit === merged)?.problems[0] ?? '', /another key under the name "ann".*The line arrives with this merge, from [0-9a-f]{7}\./);
  assert.deepEqual(whole.find((c) => c.commit === branch)?.problems, []);
});

test('the same holds when the merge was edited, or made the other way round', () => {
  startOn('2026-11-14');
  const first = `olga@person ${olga.listed} owner\nmodel-x@ai ${bot.listed}\n`;
  const cut = commit({ allowed_signers: first }, 'the list as it starts', olga);
  const withAnn = `${first}ann@person ${ann.listed} Ann's laptop\n`;
  const main = commit({ allowed_signers: withAnn }, 'the owner adds ann', olga);
  run(['reset', '-q', '--hard', cut]);
  const branch = commit({ allowed_signers: `ann@person ${spare.listed}\n${first}` }, 'the model invites someone called ann', bot);
  const trusted = parseSigners(withAnn);
  const both = `ann@person ${spare.listed}\n${withAnn}`;
  for (const parents of [[main, branch], [branch, main]]) {
    writeFileSync(join(root, 'allowed_signers'), both);
    writeFileSync(join(root, 'extra.txt'), 'added in the merge\n');
    run(['add', '-A']);
    const id = mergeCommit(parents, run(['write-tree']), 'Merge, signed by a member', bot);
    const check = verifyRange(root, 'HEAD', trusted).find((c) => c.commit === id);
    assert.equal(check?.merge, 'edited');
    assert.match(check?.problems.join('\n') ?? '', /another key under the name "ann".*The line arrives with this merge/);
  }
  // An owner who signs the merge has settled the list, and answers for it.
  writeFileSync(join(root, 'allowed_signers'), both);
  run(['add', '-A']);
  const settled = mergeCommit([main, branch], run(['write-tree']), 'Merge, signed by the owner', olga);
  assert.deepEqual(verifyRange(root, 'HEAD', trusted).find((c) => c.commit === settled)?.problems, []);
});

test('a name that differs only in capitals is the same name', () => {
  startList();
  commit({ allowed_signers: `${LIST}Olga@person ${spare.listed}\n` }, 'the model invites someone called Olga', bot);
  assert.match(newest()[0] ?? '', /added another key under the name "Olga", which is already on the list/);
});

test('a second beginning, merged in, cannot carry a list of its own', () => {
  startList();
  const tip = run(['rev-parse', 'HEAD']);
  // A commit with no parent has nothing to be compared with, so the member writes any list into one...
  const who = `Tester <tester@example.com> ${clock++} +0000`;
  const blob = run(['hash-object', '-w', '--stdin'], `olga@person ${spare.listed} owner\n`);
  const tree = run(['mktree'], `100644 blob ${blob}\tallowed_signers\n`);
  const head = `tree ${tree}\nauthor ${who}\ncommitter ${who}\n`;
  const payload = `${head}\nA list of my own\n`;
  const orphan = run(['hash-object', '-t', 'commit', '-w', '--stdin'], `${head}gpgsig ${sshSignature(Buffer.from(payload), bot).split('\n').join('\n ')}\n\nA list of my own\n`);
  // ...and merges it in, keeping both lists.
  run(['reset', '-q', '--hard', tip]);
  writeFileSync(join(root, 'allowed_signers'), `${LIST}olga@person ${spare.listed} owner\n`);
  run(['add', '-A']);
  const id = mergeCommit([tip, orphan], run(['write-tree']), 'Merge an unrelated history', bot);
  const problems = verifyRange(root, `${tip}..HEAD`, members).find((c) => c.commit === id)?.problems ?? [];
  assert.match(problems.join('\n'), /model-x@ai added olga@person as an owner\. Only an owner can name an owner\. The line arrives with this merge/);
});

test('a name a member adds is plain, so it cannot be made to look like another', () => {
  startList();
  for (const name of ['Carol@person', 'ann​@person', 'аnn@person', 'carol@laptop']) {
    commit({ allowed_signers: `${LIST}${name} ${spare.listed}\n` }, 'the model invites a name that is not plain', bot);
    assert.match(newest()[0] ?? '', /A name added by anyone but an owner is plain/);
    putBack();
  }
  // A key nobody has listed before: the lines above stay in this history, and a key that was ever listed needs an owner.
  commit({ allowed_signers: `${LIST}carol-2.laptop@person ${makeKey().listed}\n` }, 'the model invites a plain name', bot);
  assert.deepEqual(newest(), []);
});

test('a clean merge that brings in an invitation of a new name passes', () => {
  startList();
  const { base, a, b } = fork({ allowed_signers: `${LIST}carol@person ${spare.listed}\n` }, { 'right.txt': 'right\n' });
  mergeCommit([b, a], cleanTree(b, a), 'Merge pull request');
  assert.deepEqual(verifyRange(root, `${base}..HEAD`, members).map((c) => c.problems), [[], [], []]);
});

test('a member cannot invite a removed name back, or a removed key under a new name', () => {
  startList();
  const without = LIST.replace(/^ann@.*\n/m, '');
  commit({ allowed_signers: without }, 'the owner removes ann', olga);
  const now = parseSigners(without);
  commit({ allowed_signers: `${without}ann@person ${spare.listed}\n` }, 'the model invites "ann" back with its own key', bot);
  assert.deepEqual(newest(now), ['allowed_signers: model-x@ai added the name "ann", which was on the list before and was taken off. Only an owner can bring a name back.']);
  commit({ allowed_signers: without }, 'the owner takes that line off again', olga);
  commit({ allowed_signers: `${without}zed@person ${ann.listed}\n` }, "the model lists ann's old key as zed", bot);
  assert.deepEqual(newest(now), ['allowed_signers: model-x@ai added zed@person with a key that was on the list before as ann@person. Only an owner can bring a key back.']);
  commit({ allowed_signers: without }, 'the owner takes that line off too', olga);
  commit({ allowed_signers: LIST }, 'the owner lets ann back in', olga);
  assert.deepEqual(newest(now), []);
});

test("a member cannot remove someone else's review, or strip their trust label, by merging with an old commit", () => {
  startOn('2026-11-14');
  const old = run(['rev-parse', 'HEAD']); // before the file existed
  const labelled = (reviews: string): string => `claims:\n  fact:\n    text: Output was 10 Mt in 2005.\n    bet: { trust: observed, by: ann }\n${reviews}`;
  const tip = commit({ 'claims/merged.yaml': labelled(`    reviews:\n      - { by: ann, kind: person, verdict: confirm, rev: ${FACT} }\n`) }, 'ann bets and reviews', ann);
  writeFileSync(join(root, 'claims/merged.yaml'), 'claims:\n  fact:\n    text: Output was 10 Mt in 2005.\n    bet: assumed\n');
  run(['add', '-A']);
  const id = mergeCommit([tip, old], run(['write-tree']), 'Merge, dropping what ann put on record', bot);
  const problems = verifyRange(root, `${tip}..HEAD`, signers).find((c) => c.commit === id)?.problems ?? [];
  assert.ok(problems.some((p) => /ann's review of "fact" was changed or removed by model-x@ai/.test(p)));
  assert.ok(problems.some((p) => /the trust label on "fact" carried ann's name, and model-x@ai changed it/.test(p)));
});

test("a merge with an old commit cannot bring back a review its author took back", () => {
  startOn('2026-11-14');
  const reviewed = claims(`    reviews:\n      - { by: ann, kind: person, verdict: confirm, rev: ${FACT} }\n`);
  const old = commit({ 'claims/back.yaml': reviewed }, 'ann reviews', ann);
  const tip = commit({ 'claims/back.yaml': claims('') }, 'ann takes her review back', ann);
  writeFileSync(join(root, 'claims/back.yaml'), reviewed);
  run(['add', '-A']);
  const id = mergeCommit([tip, old], run(['write-tree']), "Merge, restoring ann's review", bot);
  const problems = verifyRange(root, `${tip}..HEAD`, signers).find((c) => c.commit === id)?.problems ?? [];
  assert.deepEqual(problems, ['claims/back.yaml: a review of "fact" is recorded as by "ann", but the commit was signed by model-x@ai']);
});
