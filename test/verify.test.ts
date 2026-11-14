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
