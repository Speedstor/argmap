import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Editor } from '../src/edit.ts';
import { findRoot } from '../src/workspace.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'argmap.mjs');
const ARGUMENT = 'argmap: 1\ntitle: Opening hours\nconclusion: open-late\nclaims:\n  open-late: { text: Of 40 shops on the street, 30 open after 18:00., bet: assumed }\n';

let dir: string;

function put(path: string, content: string): string {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

function argmap(cwd: string, ...args: string[]): { code: number | null; out: string } {
  const run = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { code: run.status, out: run.stdout + run.stderr };
}

beforeEach(() => {
  // macOS reaches its temporary folder through a link; compare real paths.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'argmap-workspace-')));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('a workspace with arguments and no claims folder is still found', () => {
  const path = put('copy/arguments/hours.yaml', ARGUMENT);
  const nested = put('copy/arguments/2026/hours.yaml', ARGUMENT);
  assert.equal(findRoot(path), join(dir, 'copy'));
  assert.equal(findRoot(nested), join(dir, 'copy'));
  assert.equal(findRoot(join(dir, 'copy')), join(dir, 'copy'));
});

test('a claims folder nearer the file wins over a workspace further up', () => {
  put('copy/arguments/hours.yaml', ARGUMENT);
  const inner = put('copy/samples/arguments/hours.yaml', ARGUMENT);
  put('copy/samples/claims/facts.yaml', 'claims:\n  fact: { text: A fact from 1771., bet: assumed }\n');
  assert.equal(findRoot(inner), join(dir, 'copy', 'samples'));
});

test('a new copy with no arguments and no claims is the top of its repository', () => {
  const copy = join(dir, 'copy');
  mkdirSync(join(copy, 'notes'), { recursive: true });
  execFileSync('git', ['init', '-q', copy]);
  assert.equal(findRoot(copy), copy);
  assert.equal(findRoot(join(copy, 'notes')), copy);
  assert.equal(findRoot(join(copy, 'arguments', 'not-written-yet.yaml')), copy);
});

test('a loose file outside any workspace is its own workspace', () => {
  const path = put('loose/hours.yaml', ARGUMENT);
  assert.equal(findRoot(path), join(dir, 'loose'));
});

test('a first library claim lands beside the arguments folder, not inside it', () => {
  const path = put('copy/arguments/hours.yaml', ARGUMENT);
  const result = new Editor(path)
    .addClaim({ id: 'street-counted', text: 'The street was counted on 3 March 2026.', trust: 'assumed' }, 'shops.yaml')
    .setSupport('open-late', [['street-counted']])
    .save({ by: 'tester', did: 'add', claim: 'street-counted' });
  assert.deepEqual(result.written.sort(), ['arguments/hours.yaml', 'claims/shops.yaml']);
  assert.ok(existsSync(join(dir, 'copy', 'claims', 'shops.yaml')));
  assert.ok(!existsSync(join(dir, 'copy', 'arguments', 'claims')));
});

test('init makes the arguments folder when a copy does not have one yet', () => {
  const made = argmap(dir, 'init', 'arguments/first.yaml');
  assert.equal(made.code, 0, made.out);
  assert.match(readFileSync(join(dir, 'arguments', 'first.yaml'), 'utf8'), /^argmap: 1/);
  const report = argmap(dir, 'report', 'arguments/first.yaml');
  assert.equal(report.code, 0, report.out);
  const again = argmap(dir, 'init', 'arguments/first.yaml');
  assert.equal(again.code, 2, again.out);
  assert.match(again.out, /already exists/);
});

test('an empty copy has a digest, and nothing due', () => {
  execFileSync('git', ['init', '-q', dir]);
  const digest = argmap(dir, 'digest', '-o', 'out');
  assert.equal(digest.code, 0, digest.out);
  assert.match(readFileSync(join(dir, 'out', 'README.md'), 'utf8'), /## Arguments\n\nNone yet\./);
  const due = argmap(dir, 'due', '--json');
  assert.equal(due.code, 0, due.out);
  assert.deepEqual(JSON.parse(due.out).due, []);
});
