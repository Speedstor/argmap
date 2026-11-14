import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { analyze, evaluate, knockOut, load, plainText, segments } from '../src/index.ts';
import type { Argument } from '../src/index.ts';

function arg(source: string): Argument {
  const loaded = load(source);
  assert.ok(loaded.ok, JSON.stringify(loaded.issues, null, 2));
  return loaded.argument as Argument;
}

const codes = (source: string): string[] => load(source).issues.map((i) => i.code);

const CHAIN = `
conclusion: c
claims:
  c: { text: C, because: [p, q] }
  p: { text: P, because: [l1] }
  q: { text: Q, bet: observed }
  l1: { text: L1, bet: assumed }
`;

test('a chain of support stands, and falls when a bet under it fails', () => {
  const a = arg(CHAIN);
  assert.equal(evaluate(a).get('c'), 'stands');
  const { statuses, changes } = knockOut(a, new Set(), ['l1']);
  assert.equal(statuses.get('c'), 'falls');
  assert.deepEqual(changes.map((c) => c.id).sort(), ['c', 'l1', 'p']);
});

test('because accepts one id, a flat list, or alternative groups', () => {
  const a = arg(`
conclusion: c
claims:
  c: { text: C, because: [[x], [y, z]] }
  d: { text: D, because: x }
  x: { text: X, bet: assumed }
  y: { text: Y, bet: assumed }
  z: { text: Z, bet: assumed }
attacks: [[d, y]]
`);
  assert.deepEqual(a.claims.get('c')?.because, [['x'], ['y', 'z']]);
  assert.deepEqual(a.claims.get('d')?.because, [['x']]);
});

test('a second line of support keeps a claim standing', () => {
  const a = arg(`
conclusion: c
claims:
  c: { text: C, because: [[x], [y]] }
  x: { text: X, bet: assumed }
  y: { text: Y, bet: assumed }
`);
  assert.equal(evaluate(a, new Set(['x'])).get('c'), 'stands');
  assert.equal(evaluate(a, new Set(['x', 'y'])).get('c'), 'falls');
  assert.ok(analyze(a).bets.every((b) => !b.decisive));
});

test('a standing attacker defeats its target, and defeating the attacker restores it', () => {
  const a = arg(`
conclusion: c
claims:
  c: { text: C, bet: assumed }
  b: { text: B, bet: assumed }
  a: { text: A, bet: assumed }
attacks: [[b, c], [a, b]]
`);
  const s = evaluate(a);
  assert.equal(s.get('a'), 'stands');
  assert.equal(s.get('b'), 'falls');
  assert.equal(s.get('c'), 'stands');
  assert.equal(evaluate(a, new Set(['a'])).get('c'), 'falls');
});

test('a dispute leaves both sides contested until one is knocked out', () => {
  const a = arg(`
conclusion: c
claims:
  c: { text: C, because: [x] }
  x: { text: X, bet: assumed }
  y: { text: Y, bet: assumed }
disputes: [[x, y]]
`);
  const base = analyze(a);
  assert.equal(base.conclusion, 'contested');
  assert.deepEqual(base.cruxes.cruxes, [{ a: 'x', b: 'y', ifAPrevails: 'stands', ifBPrevails: 'falls' }]);
  assert.deepEqual(base.cruxes.tally, { stands: 1, falls: 1, contested: 0, total: 2 });
  assert.deepEqual(base.cruxes.standsOnlyIf, ['x']);
  assert.equal(base.sides.get('x'), 'for');
  assert.equal(base.sides.get('y'), 'against');
});

test('circular support is reported and never settles', () => {
  const loaded = load(`
conclusion: a
claims:
  a: { text: A, because: [b] }
  b: { text: B, because: [a] }
`);
  assert.ok(loaded.ok);
  assert.ok(loaded.issues.some((i) => i.code === 'circular-support'));
  assert.equal(evaluate(loaded.argument as Argument).get('a'), 'contested');
});

test('shape errors are reported, not thrown', () => {
  assert.ok(codes('just a string').includes('shape'));
  assert.ok(codes('claims: {}').includes('claims-missing'));
  assert.ok(codes('conclusion: c\nclaims:\n  c: { text: C, because: [nope] }').includes('unknown-claim'));
  assert.ok(codes('conclusion: c\nclaims:\n  c: { text: C, because: [x], bet: assumed }\n  x: X').includes('bet-on-derived'));
  assert.ok(codes('conclusion: c\nclaims:\n  c: { text: C, bet: certain }').includes('bet-trust'));
  assert.ok(codes('conclusion: c\nclaims:\n  c: { text: C, bet: assumed }\n  c: { text: again }').includes('yaml'));
});

test('an unlabelled leaf is treated as assumed, with a warning', () => {
  const loaded = load('conclusion: c\nclaims:\n  c: A bare claim.');
  assert.ok(loaded.ok);
  assert.ok(loaded.issues.some((i) => i.code === 'bet-unlabelled'));
  assert.equal(loaded.argument?.claims.get('c')?.bet?.trust, 'assumed');
});

test('a claim with no bearing on the conclusion is flagged', () => {
  assert.ok(codes('conclusion: c\nclaims:\n  c: { text: C, bet: assumed }\n  d: { text: D, bet: assumed }').includes('orphan'));
});

test('pinned terms render and are checked', () => {
  assert.equal(plainText('A {bank#river|riverbank} and an {easy-fuel}.'), 'A riverbank and an easy fuel.');
  assert.deepEqual(
    segments('{a} b').map((s) => s.kind),
    ['term', 'text'],
  );
  assert.ok(codes('conclusion: c\nclaims:\n  c: { text: "A {ghost}.", bet: assumed }').includes('term-undefined'));
});

const NOTHING = `
conclusion: c
terms:
  nothing#none: The absence of anything at all.
  nothing#little: Having very little.
claims:
  c: { text: "A ham sandwich beats bliss, and {nothing#none} beats that.", because: [p1, p2] }
  p1: { text: "{nothing#none|Nothing} is better than eternal bliss.", bet: assumed }
  p2: { text: "A ham sandwich is better than {nothing#little|nothing}.", bet: assumed }
`;

test('the ham sandwich argument is caught as a change of sense', () => {
  const loaded = load(NOTHING);
  assert.ok(loaded.ok);
  const shift = loaded.issues.find((i) => i.code === 'sense-shift');
  assert.ok(shift, 'expected a sense-shift warning');
  assert.deepEqual(shift.claims, ['c', 'p2']);
});

test('an unpinned use of a defined word is flagged', () => {
  const source = NOTHING.replace('{nothing#little|nothing}', 'nothing');
  assert.ok(codes(source).includes('term-unpinned'));
});

test('opponents who use a word in different senses are flagged', () => {
  const source = `
conclusion: c
terms:
  free#cost: Costs no money.
  free#liberty: Not under anyone's control.
claims:
  c: { text: "Software should be {free#liberty}.", bet: assumed }
  o: { text: "Nothing good is {free#cost}.", bet: assumed }
attacks: [[o, c]]
`;
  assert.ok(codes(source).includes('sense-clash'));
});

test('the civilization argument loads and hinges on three disputes', () => {
  const read = (path: string): string => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8');
  const library = [{ name: 'claims/energy-and-industry.yaml', source: read('claims/energy-and-industry.yaml') }];
  const loaded = load(read('arguments/second-industrialization.yaml'), library);
  assert.ok(loaded.ok, JSON.stringify(loaded.issues, null, 2));
  const codes = loaded.issues.map((i) => i.code);
  assert.deepEqual(
    codes.filter((c) => c !== 'trust-unbacked'),
    ['sense-clash'],
  );
  // The fixture labels bets without attaching the evidence, and says so.
  assert.equal(codes.filter((c) => c === 'trust-unbacked').length, 8);
  const a = analyze(loaded.argument as Argument);
  assert.equal(a.conclusion, 'contested');
  assert.equal(a.cruxes.cruxes.length, 3);
  assert.deepEqual(a.cruxes.tally, { stands: 1, falls: 7, contested: 0, total: 8 });
  assert.deepEqual(a.cruxes.standsOnlyIf.sort(), ['easy-coal-mined-out', 'no-substitute', 'same-inputs']);
  assert.equal(a.statuses.get('early-industry-fossil-free'), 'falls');
  const won = evaluate(loaded.argument as Argument, new Set(['surface-coal-remains', 'slow-green-path', 'head-start']));
  assert.equal(won.get('never-again'), 'stands');
});
