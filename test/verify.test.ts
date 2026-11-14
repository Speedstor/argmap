import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { parseSigners, verifyRange } from '../src/verify.ts';

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

const ann = makeKey();
const bot = makeKey();
const stranger = makeKey();
const signers = parseSigners(`# trusted keys
ann@person ${ann.listed} Ann's laptop
model-x@ai namespaces="git" ${bot.listed}
ca@person cert-authority ${stranger.listed}
`);

before(() => {
  root = mkdtempSync(join(tmpdir(), 'argmap-verify-'));
  run(['init', '-q', '-b', 'main']);
  // The merge tests ask git to merge, which needs a name to write down.
  run(['config', 'user.name', 'Tester']);
  run(['config', 'user.email', 'tester@example.com']);
  run(['config', 'commit.gpgsign', 'false']);
});

after(() => rmSync(root, { recursive: true, force: true }));

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
    commit({ 'claims/facts.yaml': claims('    reviews:\n      - { by: ann, kind: person, verdict: confirm }\n') }, 'ann reviews', ann),
    commit(
      { 'claims/facts.yaml': claims('    reviews:\n      - { by: ann, kind: person, verdict: confirm }\n      - { by: model-x, kind: ai, verdict: reject }\n') },
      'the model reviews',
      bot,
    ),
    commit(
      {
        'claims/facts.yaml': claims(
          '    reviews:\n      - { by: ann, kind: person, verdict: confirm }\n      - { by: model-x, kind: ai, verdict: reject }\n      - { by: ann, kind: person, verdict: reject, note: forged }\n',
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
  assert.deepEqual(checks[4]?.problems, []);
  assert.deepEqual(checks[5]?.problems, ['not signed']);
  assert.deepEqual(checks[6]?.problems, ['signed with a key that is not on the list']);
});

test('a reviewer cannot pass as the other kind', () => {
  commit({ 'claims/facts.yaml': claims('    reviews:\n      - { by: model-x, kind: person, verdict: confirm }\n') }, 'the model poses as a person', bot);
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
  const review = (by: string, kind: string): string => `      - { by: ${by}, kind: ${kind}, verdict: confirm }\n`;
  const { base, a, b } = fork(
    { 'claims/merge-a.yaml': claims(`    reviews:\n${review('ann', 'person')}`).replace('fact:', 'fact-a:') },
    { 'claims/merge-b.yaml': claims(`    reviews:\n${review('model-x', 'ai')}`).replace('fact:', 'fact-b:') },
  );
  run(['reset', '-q', '--hard', a]);
  run(['merge', '-q', '--no-commit', '--no-ff', b]);
  // The model merges, and writes a review as ann while doing it.
  writeFileSync(
    join(root, 'claims/merge-b.yaml'),
    claims(`    reviews:\n${review('model-x', 'ai')}      - { by: ann, kind: person, verdict: reject, note: forged }\n`).replace('fact:', 'fact-b:'),
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

const licences = (rest: string, vouchedBy = 'ann'): string => `claims:
  licences:
    text: At least 9 in 10 public repositories with over 1,000 stars carry a licence file.
    bet: { trust: assumed, by: ${vouchedBy} }
${rest}`;

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
${rest}`;

const annAccepts = '        accepted: [{ by: ann, kind: person, date: 2026-11-14 }]\n';
const outcomeBy = (by: string, kind: string, found = 47): string =>
  `        outcome: ${found >= 51 ? 'yes' : 'no'}\n        found: ${found}\n        resolved: 2026-11-20\n        resolved_by: ${by}\n        resolved_kind: ${kind}\n        source: https://example.org/sample-of-60.csv\n`;

/** Problems of every commit after `from`, oldest first. */
const since = (from: string, options: { separate?: boolean } = {}): string[][] => verifyRange(root, `${from}..HEAD`, signers, options).map((c) => c.problems);
const head = (): string => run(['rev-parse', 'HEAD']);

test('a prediction, then its acceptance and outcome in later commits, each in the signer\'s name, pass', () => {
  const from = head();
  const file = 'claims/p1.yaml';
  commit({ [file]: licences('') }, 'ann makes a bet', ann);
  commit({ [file]: licences(guess(annAccepts)) }, 'ann predicts', ann);
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
  const file = 'claims/p2.yaml';
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
  const file = 'claims/p3.yaml';
  commit({ [file]: licences('') }, 'ann makes a bet', ann);
  commit({ [file]: licences(guess(annAccepts)) }, 'ann predicts', ann);
  let from = head();
  commit({ [file]: licences(guess(annAccepts + outcomeBy('ann', 'person'))) }, 'the model records an outcome as ann', bot);
  assert.match(since(from)[0]?.[0] ?? '', /the outcome of the prediction .* is recorded as by "ann", but the commit was signed by model-x@ai/);
  from = head();
  commit({ [file]: licences(guess(annAccepts + outcomeBy('ann', 'person', 55))) }, 'the outcome turns into a yes', ann);
  assert.match(since(from)[0]?.[0] ?? '', /the outcome of .* was changed or removed. An outcome is recorded once/);
});

test('only someone who vouches for a claim can accept a test of it, and only before the outcome', () => {
  const file = 'claims/p4.yaml';
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
  commit({ 'claims/p6.yaml': licences(guess(outcomeBy('model-x', 'ai'))) }, 'the model records a failure', bot);
  from = head();
  commit({ 'claims/p6.yaml': licences(guess(annAccepts + outcomeBy('model-x', 'ai'))) }, 'ann accepts after the fact', ann);
  assert.match(since(from)[0]?.[0] ?? '', /was accepted when its outcome was already known/);
});
