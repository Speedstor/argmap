import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePrivateKey, publicLine, SignError, sshSign } from '../src/sign.ts';
import { claimRev } from '../src/index.ts';
import { checkSshSignature, parseSigners, verifyRange } from '../src/verify.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const helper = join(repo, 'bin/argmap-ssh-sign.mjs');

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

/** A fresh key in the file format ssh-keygen writes. Made here so no key is stored in the repository. */
function makeKeyFile(comment = 'test'): { text: string; listed: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  const seed = Buffer.from((privateKey.export({ format: 'jwk' }) as { d: string }).d, 'base64url');
  const check = Buffer.from([1, 2, 3, 4]);
  let secret = Buffer.concat([check, check, wire('ssh-ed25519', pub, Buffer.concat([seed, pub]), comment)]);
  for (let pad = 1; secret.length % 8 !== 0; pad++) secret = Buffer.concat([secret, Buffer.from([pad])]);
  const one = Buffer.alloc(4);
  one.writeUInt32BE(1);
  const blob = Buffer.concat([Buffer.from('openssh-key-v1\0'), wire('none', 'none', ''), one, wire(wire('ssh-ed25519', pub), secret)]);
  const body = (blob.toString('base64').match(/.{1,70}/g) ?? []).join('\n');
  return {
    text: `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`,
    listed: `ssh-ed25519 ${wire('ssh-ed25519', pub).toString('base64')}`,
  };
}

let root: string;
let keyPath: string;
const key = makeKeyFile();
const run = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

before(() => {
  root = mkdtempSync(join(tmpdir(), 'argmap-sign-'));
  keyPath = join(root, 'key');
  writeFileSync(keyPath, key.text);
  chmodSync(keyPath, 0o600);
  mkdirSync(join(root, 'work'));
  root = join(root, 'work');
  run('init', '-q', '-b', 'main');
  run('config', 'user.name', 'Tester');
  run('config', 'user.email', 'tester@example.com');
});

after(() => rmSync(join(root, '..'), { recursive: true, force: true }));

test('a private key file is read, and a signature made with it checks out with the public key alone', () => {
  const parsed = parsePrivateKey(key.text);
  assert.equal(publicLine(parsed), key.listed);
  assert.equal(parsed.comment, 'test');
  const payload = Buffer.from('tree 123\n\nmessage\n');
  const result = checkSshSignature(payload, sshSign(payload, parsed));
  assert.ok(result.ok);
  assert.equal(`ssh-ed25519 ${result.key}`, key.listed);
  assert.equal(checkSshSignature(Buffer.from('tree 124\n\nmessage\n'), sshSign(payload, parsed)).ok, false);
});

test('unusable key files are refused with a reason', () => {
  assert.throws(() => parsePrivateKey('ssh-ed25519 AAAA'), SignError);
  assert.throws(() => parsePrivateKey(key.text.replace(/\n.{20}/, '\n')), SignError);
});

test('git signs a commit through the helper, and verify attributes it', () => {
  run('config', 'gpg.format', 'ssh');
  run('config', 'gpg.ssh.program', helper);
  run('config', 'user.signingkey', keyPath);
  run('config', 'commit.gpgsign', 'true');
  mkdirSync(join(root, 'claims'));
  writeFileSync(
    join(root, 'claims/facts.yaml'),
    `claims:\n  fact:\n    text: Output was 10 Mt in 2005.\n    bet: assumed\n    reviews:\n      - { by: project-key, kind: ai, verdict: confirm, rev: ${claimRev({ text: 'Output was 10 Mt in 2005.', because: [] })} }\n`,
  );
  run('add', '-A');
  run('commit', '-q', '-m', 'a signed review');
  assert.match(run('cat-file', 'commit', 'HEAD'), /gpgsig -----BEGIN SSH SIGNATURE-----/);

  const good = verifyRange(root, 'HEAD', parseSigners(`project-key@ai ${key.listed} the test key\n`));
  assert.equal(good[0]?.signer?.principal, 'project-key@ai');
  assert.deepEqual(good[0]?.problems, []);
  const wrongName = verifyRange(root, 'HEAD', parseSigners(`someone-else@ai ${key.listed}\n`));
  assert.match(wrongName[0]?.problems[0] ?? '', /recorded as by "project-key", but the commit was signed by someone-else@ai/);
});

test('the helper only signs, and says so', () => {
  const result = spawnSync(process.execPath, [helper, '-Y', 'verify', '-n', 'git'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only signs/);
});
