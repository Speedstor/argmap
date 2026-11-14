import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, claimRev, lintClaim, load, nextSteps, resolution, reviewSummary, toYaml } from '../src/index.ts';
import type { Argument, Claim } from '../src/index.ts';

const LIBRARY = [
  {
    name: 'claims/facts.yaml',
    source: `
terms:
  shared: A word the library pins.
  unused: A word nothing in the argument pins.
claims:
  fact: { text: "A {shared} fact from 1771.", bet: corroborated }
  objection: { text: An objection recorded against the fact in 1800., bet: assumed }
  unrelated: { text: Nothing uses this., bet: assumed }
disputes: [[fact, objection]]
`,
  },
];

const MAIN = `
conclusion: c
claims:
  c: { text: The conclusion., because: [fact] }
`;

function ok(source: string, library = LIBRARY): Argument {
  const loaded = load(source, library);
  assert.ok(loaded.ok, JSON.stringify(loaded.issues, null, 2));
  return loaded.argument as Argument;
}

test('an argument pulls in the library claims it rests on, and the objections recorded against them', () => {
  const arg = ok(MAIN);
  assert.deepEqual([...arg.claims.keys()], ['c', 'fact', 'objection']);
  assert.equal(arg.claims.get('fact')?.origin, 'claims/facts.yaml');
  assert.deepEqual([...arg.terms.keys()], ['shared']);
  assert.deepEqual(arg.disputes, [['fact', 'objection']]);
  assert.equal(analyze(arg).conclusion, 'contested');
});

test('the same id in the argument and the library is an error', () => {
  const loaded = load(`${MAIN}  fact: { text: Mine., bet: assumed }\n`, LIBRARY);
  assert.ok(!loaded.ok);
  assert.ok(loaded.issues.some((i) => i.code === 'duplicate-claim'));
});

test('a bundled argument is self-contained and evaluates the same', () => {
  const arg = ok(MAIN);
  const again = load(toYaml(arg));
  assert.ok(again.ok, JSON.stringify(again.issues, null, 2));
  assert.deepEqual([...(again.argument as Argument).claims.keys()], [...arg.claims.keys()]);
  assert.equal(analyze(again.argument as Argument).conclusion, 'contested');
});

function claimWith(reviews: string): Claim {
  const arg = ok(`conclusion: c\nclaims:\n  c:\n    text: A claim from 1900.\n    bet: assumed\n    reviews:\n${reviews}`, []);
  return arg.claims.get('c') as Claim;
}

test('people and AI reviewers count the same, and disagreement is a split', () => {
  assert.equal(claimWith('      - { by: ann, verdict: confirm }\n').reviews[0]?.kind, 'person');
  assert.equal(reviewSummary(claimWith('      - { by: ann, kind: person, verdict: confirm }\n')).state, 'confirmed');
  assert.equal(reviewSummary(claimWith('      - { by: model, kind: ai, verdict: reject }\n')).state, 'rejected');
  const split = reviewSummary(claimWith('      - { by: ann, kind: person, verdict: confirm }\n      - { by: model, kind: ai, verdict: reject }\n'));
  assert.equal(split.state, 'split');
  assert.equal(split.confirms, 1);
  assert.equal(split.rejects, 1);
});

test("a reviewer's newest review replaces their earlier one", () => {
  const s = reviewSummary(claimWith('      - { by: ann, verdict: reject }\n      - { by: ann, verdict: confirm }\n'));
  assert.equal(s.state, 'confirmed');
  assert.equal(s.current.length, 1);
});

test('a review of an older wording is stale and does not count', () => {
  const claim = claimWith('      - { by: ann, verdict: confirm, rev: "00000000" }\n');
  const s = reviewSummary(claim);
  assert.equal(s.state, 'unreviewed');
  assert.equal(s.stale.length, 1);
  const fresh = claimWith(`      - { by: ann, verdict: confirm, rev: "${claimRev(claim)}" }\n`);
  assert.equal(reviewSummary(fresh).state, 'confirmed');
});

test('hand-wavy bets are flagged and specific ones are not', () => {
  const arg = ok(
    `conclusion: c
claims:
  c: { text: C., because: [vague, sharp, bundled] }
  vague: { text: Most of the shallow coal has largely gone., bet: assumed }
  sharp: { text: Surface mines work seams within 80 m of the surface., bet: assumed }
  bundled: { text: "Output fell after 1913, and nobody replaced it.", bet: assumed }
`,
    [],
  );
  const codes = (id: string): string[] => lintClaim(arg.claims.get(id) as Claim).map((f) => f.code);
  assert.deepEqual(codes('vague'), ['vague-words', 'no-anchor']);
  assert.deepEqual(codes('sharp'), []);
  assert.deepEqual(codes('bundled'), ['compound']);
  const res = resolution(arg);
  assert.equal(res.bets, 3);
  assert.equal(res.sharp, 1);
});

test('next steps put decisive work first, in order of kind', () => {
  const arg = ok(
    `conclusion: c
claims:
  c: { text: C., because: [split, rejected, vague, unchecked, checked] }
  split:
    text: A claim about 1900.
    bet: corroborated
    reviews: [{ by: ann, verdict: confirm }, { by: model, kind: ai, verdict: reject }]
  rejected:
    text: A claim about 1901.
    bet: corroborated
    reviews: [{ by: model, kind: ai, verdict: reject }]
  vague: { text: Most things mostly work., bet: assumed }
  unchecked: { text: A claim about 1902., bet: assumed }
  checked:
    text: A claim about 1903.
    bet: observed
    evidence: [{ kind: account, says: I saw it., witness: me, first_hand: true }]
`,
    [],
  );
  const steps = nextSteps(arg, analyze(arg));
  assert.deepEqual(
    steps.filter((s) => s.decisive).map((s) => `${s.kind} ${s.claims[0]}`),
    ['adjudicate split', 'answer rejected', 'refine vague', 'check unchecked', 'review checked'],
  );
  assert.deepEqual(steps.at(-1), { kind: 'review', claims: ['c'], decisive: false, why: 'Nobody has checked that "c" follows from its support.' });
});
