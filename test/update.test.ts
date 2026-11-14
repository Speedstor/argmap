import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'update-from-upstream.sh');
let dir: string;
let upstream: string;
let copy: string;

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

function commit(cwd: string, file: string, content: string, message: string): void {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
}

function setUp(cwd: string): void {
  git(cwd, 'config', 'user.name', 'Tester');
  git(cwd, 'config', 'user.email', 'tester@example.com');
  git(cwd, 'config', 'commit.gpgsign', 'false');
}

/** Run the update in the copy, the way a person or the workflow would. */
function update(env: Record<string, string> = {}): { code: number | null; out: string } {
  const run = spawnSync('bash', [SCRIPT, upstream, 'main'], { cwd: copy, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: run.status, out: run.stdout + run.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'argmap-update-'));
  upstream = join(dir, 'upstream');
  copy = join(dir, 'copy');
  mkdirSync(upstream);
  execFileSync('git', ['init', '-q', '-b', 'main', upstream]);
  setUp(upstream);
  commit(upstream, 'tool.txt', 'v1\n', 'tool v1');
  // A private copy starts as a clone of the public repository.
  execFileSync('git', ['clone', '-q', upstream, copy]);
  setUp(copy);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('nothing to do when the copy already has everything upstream has', () => {
  commit(copy, 'arguments/private.yaml', 'mine\n', 'a private argument');
  const head = git(copy, 'rev-parse', 'HEAD');
  const run = update();
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /Already up to date/);
  assert.equal(git(copy, 'rev-parse', 'HEAD'), head);
});

test('an update merges in beside private work and keeps both', () => {
  commit(copy, 'arguments/private.yaml', 'mine\n', 'a private argument');
  commit(upstream, 'tool.txt', 'v2\n', 'tool v2');
  const run = update();
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /Merged 1 commit\(s\)/);
  assert.equal(git(copy, 'show', 'HEAD:tool.txt'), 'v2');
  assert.equal(git(copy, 'show', 'HEAD:arguments/private.yaml'), 'mine');
  assert.equal(git(copy, 'log', '-1', '--format=%P').split(' ').length, 2);
  assert.equal(git(copy, 'status', '--porcelain'), '');
});

test('a conflict changes nothing and names the file', () => {
  commit(copy, 'tool.txt', 'changed here\n', 'a local change to a tool file');
  commit(upstream, 'tool.txt', 'v2\n', 'tool v2');
  const head = git(copy, 'rev-parse', 'HEAD');
  const run = update();
  assert.equal(run.code, 2, run.out);
  assert.match(run.out, /conflicts with changes made in this copy/);
  assert.match(run.out, /^ {2}tool\.txt$/m);
  assert.equal(git(copy, 'rev-parse', 'HEAD'), head);
  assert.equal(git(copy, 'status', '--porcelain'), '');
  assert.ok(!existsSync(join(copy, '.git', 'MERGE_HEAD')));
});

test('an update that changes a workflow file stops unless it is allowed', () => {
  commit(upstream, '.github/workflows/ci.yml', 'name: CI\n', 'add a workflow');
  const head = git(copy, 'rev-parse', 'HEAD');
  const stopped = update();
  assert.equal(stopped.code, 3, stopped.out);
  assert.match(stopped.out, /^ {2}\.github\/workflows\/ci\.yml$/m);
  assert.equal(git(copy, 'rev-parse', 'HEAD'), head);
  const allowed = update({ ALLOW_WORKFLOW_CHANGES: '1' });
  assert.equal(allowed.code, 0, allowed.out);
  assert.equal(git(copy, 'show', 'HEAD:.github/workflows/ci.yml'), 'name: CI');
});

test('a repository that is not a copy of upstream is refused', () => {
  const other = join(dir, 'other');
  mkdirSync(other);
  execFileSync('git', ['init', '-q', '-b', 'main', other]);
  setUp(other);
  commit(other, 'x.txt', 'x\n', 'unrelated');
  const run = spawnSync('bash', [SCRIPT, upstream, 'main'], { cwd: other, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /shares no history/);
});
