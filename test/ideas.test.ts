import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { addIdea, createNotepad, ideasFor, IdeasError, parseNotepad, readNotepads } from '../src/ideas.ts';
import { load } from '../src/index.ts';
import type { Argument } from '../src/index.ts';

let root: string;
const run = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

const ARG = load(`conclusion: c
claims:
  c: { text: C., because: [p] }
  p: { text: P in 1900., bet: assumed }
`).argument as Argument;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'argmap-ideas-'));
  run('init', '-q', '-b', 'main');
  run('config', 'user.name', 'Tester');
  run('config', 'user.email', 'tester@example.com');
  run('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'x\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'start');
});

after(() => rmSync(root, { recursive: true, force: true }));

test('a notepad is plain text: list items and paragraphs are notes', () => {
  const pad = parseNotepad(
    'ideas/demo.md',
    `# Notepad: A demo

Intro text is not a note.

## Notes

- What about peat? [[p]] (ann, 2026-11-14)
- A note that
  wraps onto two lines.

A bare paragraph is a note too.

## Related ideas

* Tidal mills could matter (model-x, 2026-11-15)
`,
  );
  assert.equal(pad?.title, 'A demo');
  assert.deepEqual(pad?.ideas, [
    { text: 'What about peat? [[p]]', related: false, mentions: ['p'], by: 'ann', date: '2026-11-14' },
    { text: 'A note that wraps onto two lines.', related: false, mentions: [] },
    { text: 'A bare paragraph is a note too.', related: false, mentions: [] },
    { text: 'Tidal mills could matter', related: true, mentions: [], by: 'model-x', date: '2026-11-15' },
  ]);
  assert.equal(parseNotepad('ideas/claims/p.md', '# p\n\n## Notes\n\n- Loose.\n')?.ideas[0]?.mentions[0], 'p');
});

test('there is no notepad until one is asked for', () => {
  assert.deepEqual(readNotepads(root), []);
  assert.throws(() => addIdea(root, 'argument', 'demo', 'Too early.', { by: 'ann' }), IdeasError);
});

test('notes are committed to the ideas branch without touching the checked-out branch', () => {
  createNotepad(root, 'argument', 'demo', 'A demo', 'ann');
  addIdea(root, 'argument', 'demo', 'What about peat? [[p]]', { by: 'ann' });
  addIdea(root, 'argument', 'demo', 'Tidal mills could matter.', { by: 'model-x', related: true });
  addIdea(root, 'argument', 'demo', 'A general thought.', { by: 'ann' });
  createNotepad(root, 'claim', 'p', 'p', 'ann');
  addIdea(root, 'claim', 'p', 'Only about p.', { by: 'ann' });

  assert.equal(run('branch', '--show-current'), 'main');
  assert.equal(run('status', '--porcelain'), '');
  assert.deepEqual(readdirSync(root).filter((n) => n !== '.git'), ['README.md']);
  assert.equal(run('rev-list', '--count', 'ideas'), '6');
  // The ideas branch starts empty: it holds notepads and nothing from main.
  assert.deepEqual(run('ls-tree', '-r', '--name-only', 'ideas').split('\n'), ['ideas/claims/p.md', 'ideas/demo.md']);

  const text = run('show', 'ideas:ideas/demo.md');
  assert.ok(text.indexOf('What about peat?') < text.indexOf('A general thought.'));
  assert.ok(text.indexOf('A general thought.') < text.indexOf('## Related ideas'));
  assert.ok(text.indexOf('## Related ideas') < text.indexOf('Tidal mills'));
  assert.throws(() => createNotepad(root, 'argument', 'demo', 'Again', 'ann'), /already a notepad/);
});

test('an argument sees its own notepad and the notepads of its claims', () => {
  const ideas = ideasFor(root, 'demo', ARG);
  assert.deepEqual(ideas.notepads.map((n) => n.path).sort(), ['ideas/claims/p.md', 'ideas/demo.md']);
  assert.deepEqual(ideas.byClaim['p']?.map((i) => i.text), ['Only about p.', 'What about peat? [[p]]']);
  assert.deepEqual(ideas.general.map((i) => i.text), ['A general thought.']);
  assert.deepEqual(ideas.related.map((i) => i.text), ['Tidal mills could matter.']);
  assert.equal(ideasFor(root, 'other', ARG).notepads.length, 1, 'another argument using claim p still sees the notepad for p');
});
