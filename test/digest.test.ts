import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildDigest } from '../src/digest.ts';
import { loadFile } from '../src/workspace.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const ARGUMENT = 'arguments/second-industrialization';
let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'argmap-digest-'));
  cpSync(FIXTURES, root, { recursive: true });
  // A second, tiny argument: two alternative lines of support, and a round by a name with no key.
  writeFileSync(
    join(root, 'arguments', 'tiny.yaml'),
    'argmap: 1\ntitle: Tiny\nconclusion: c\nclaims:\n  c: { text: C., because: [[p], [q, r]] }\n  p: { text: P in 1900., bet: observed, reviews: [{ by: aldrin, kind: person, verdict: confirm, note: Seen. }] }\n  q: { text: Q in 1901., bet: assumed, evidence: [{ kind: reference, says: S., source: "https://example.com/a" }] }\n  r: { text: R in 1902., bet: assumed }\nlog:\n  - { at: 2026-11-14, by: stranger, did: create, verdict: stands, bets: 3, sharp: 3 }\n',
  );
  writeFileSync(join(root, 'allowed_signers'), 'aldrin@person ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJOp/UAYTX6pE/zVydAdoiNfXCeFGgcmVWnykq7GTovu owner\n');
});

after(() => rmSync(root, { recursive: true, force: true }));

const page = (path: string): string => buildDigest(root).find((f) => f.path === path)?.content ?? '';

test('the digest is an index, the library, and one page per argument', () => {
  assert.deepEqual(buildDigest(root).map((f) => f.path), ['README.md', 'claims.md', `${ARGUMENT}.md`, 'arguments/tiny.md']);
});

test('the same files always give the same digest', () => {
  assert.deepEqual(buildDigest(root), buildDigest(root));
});

test('there are no links: claims are named by id, to be searched for', () => {
  for (const file of buildDigest(root)) assert.ok(!/\]\(/.test(file.content), `${file.path} has a Markdown link`);
});

test('every claim of an argument has its own section, with status, kind and text as written', () => {
  const arg = loadFile(join(root, `${ARGUMENT}.yaml`)).argument;
  assert.ok(arg);
  const text = page(`${ARGUMENT}.md`);
  for (const id of arg.claims.keys()) assert.match(text, new RegExp(`^### ${id}$`, 'm'), id);
  const section = text.slice(text.indexOf('### never-again'));
  assert.match(section, /^- status: contested\. /m);
  assert.match(section, /^- kind: supported$/m);
  // Pinned-term markers are kept, so the text can be pasted back into the file.
  assert.match(section, /^- text: After a \{collapse\}, humanity could never \{industrialize#full\} again\.$/m);
  assert.match(text, /^- library: defined in `claims\/energy-and-industry\.yaml`$/m);
});

test('the structure shows status and id, support indented, and opposition marked', () => {
  const text = page(`${ARGUMENT}.md`);
  const structure = text.slice(text.indexOf('## Structure'), text.indexOf('## Disputes'));
  assert.match(structure, /^- contested `never-again`$/m);
  assert.match(structure, /^  - stands `needed-easy-fuel`$/m);
  assert.match(structure, /^    - falls `early-industry-fossil-free` \(objection to the claim above\)$/m);
  assert.match(structure, /^      - contested `surface-coal-remains` \(in dispute with the claim above; bet: assumed\)$/m);
  const tiny = page('arguments/tiny.md');
  assert.ok(tiny.includes('- stands `c`\n  - line 1 of 2, any one line is enough:\n    - stands `p` (bet: observed)\n  - line 2 of 2, any one line is enough:\n    - stands `q` (bet: assumed)\n    - stands `r` (bet: assumed)\n'));
  assert.match(tiny, /^- rests on: line 1: `p`; line 2: `q` \+ `r`$/m);
  assert.match(tiny, /^1\. 2026-11-14 stranger create\. Left: stands, 3 of 3 bets sharp\.$/m);
});

test('what the engine computes is written out: disputes, exposure of each bet, next steps', () => {
  const text = page(`${ARGUMENT}.md`);
  assert.match(text, /^- disputes: 3 open\. Of the 8 ways to settle them the conclusion stands in 1, falls in 7, stays contested in 0$/m);
  assert.match(text, /^- `same-inputs` against `head-start`: if `same-inputs` prevails the conclusion stays contested; if `head-start` prevails it falls$/m);
  assert.match(text, /^\| `same-inputs` \| assumed \| contested \| for \| falls \| \d+ \| (yes|no) \| 0 \/ 0 \|$/m);
  assert.match(text, /^Can change the conclusion:$/m);
  assert.match(text, /^- settle \([^)]*\): `easy-coal-mined-out` against `surface-coal-remains`; /m);
  assert.match(text, /^- \[sense-clash\] /m);
});

test('claims are named by id in the reasons, reviews show only where there are any, and a source ends its field', () => {
  const big = page(`${ARGUMENT}.md`);
  assert.match(big, /^- status: contested\. Opposed by `surface-coal-remains`, which is not settled\.$/m);
  assert.ok(!big.includes('review: unreviewed'));
  const tiny = page('arguments/tiny.md');
  assert.match(tiny, /^- review: confirmed \(1 confirm, 0 reject\)\n  - confirm by aldrin \(person\): Seen\.$/m);
  assert.match(tiny, /^  - for, reference: S\. \| source: https:\/\/example\.com\/a$/m);
  assert.match(tiny, /^- status: stands\n- kind: bet, trust assumed, cost medium$/m);
});

test('the library page says where each shared claim is used and how it fares there', () => {
  const text = page('claims.md');
  assert.match(text, /^### coal-drove-takeoff$/m);
  assert.match(text, /^- used in: `arguments\/second-industrialization\.yaml` \(stands there\)$/m);
  assert.ok(!/^- status:/m.test(text), 'a library claim has no status of its own');
});

test('the index lists arguments, library ids and trusted keys with what each has on record', () => {
  const text = page('README.md');
  assert.match(text, /^- conclusion: `never-again` is contested$/m);
  assert.match(text, /^- hinges on: `easy-coal-mined-out` against `surface-coal-remains`; /m);
  assert.match(text, /^- start with: \w+ `[a-z0-9-]+`/m);
  assert.match(text, /^- `claims\/energy-and-industry\.yaml`: `coal-drove-takeoff`, /m);
  assert.match(text, /^- `aldrin` \(person\), owner: 1 review, 0 evidence records, 0 rounds$/m);
  assert.match(text, /^- `stranger` \(no key on the list\): 0 reviews, 0 evidence records, 1 round$/m);
});

test('an argument that does not load is reported, not dropped', () => {
  writeFileSync(join(root, 'arguments', 'broken.yaml'), 'argmap: 1\ntitle: Broken\nconclusion: missing\nclaims:\n  a: { text: A., bet: assumed }\n');
  try {
    assert.match(page('README.md'), /^### arguments\/broken\.yaml\n\n- digest: `arguments\/broken\.md`\n- does not load: \d+ errors?$/m);
    assert.match(page('arguments/broken.md'), /^## Errors$/m);
  } finally {
    rmSync(join(root, 'arguments', 'broken.yaml'));
  }
});
