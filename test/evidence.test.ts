import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, independentSources, load, nextSteps, toYaml } from '../src/index.ts';
import type { Argument, Claim } from '../src/index.ts';

function loadOk(body: string): { arg: Argument; codes: string[] } {
  const loaded = load(`conclusion: c\nclaims:\n  c:\n    text: Output reached 10 Mt in 2005.\n${body}`);
  assert.ok(loaded.ok, JSON.stringify(loaded.issues, null, 2));
  return { arg: loaded.argument as Argument, codes: loaded.issues.map((i) => i.code) };
}

const STAT = '      - { kind: statistic, says: Output was 10 Mt., value: 10, unit: Mt, period: "2005", source: "https://a.example/report" }\n';
const PAPER = '      - { kind: paper, says: A survey found the same., source: "doi:10.1/x", peer_reviewed: true }\n';

test('evidence is read with its kind-specific fields', () => {
  const { arg } = loadOk(`    bet: assumed\n    evidence:\n${STAT}      - { kind: account, stance: against, says: The plant was idle., witness: A. Worker, first_hand: true }\n`);
  const [stat, account] = (arg.claims.get('c') as Claim).evidence;
  assert.deepEqual(stat, { kind: 'statistic', stance: 'for', says: 'Output was 10 Mt.', source: 'https://a.example/report', unit: 'Mt', period: '2005', value: 10 });
  assert.equal(account?.stance, 'against');
  assert.equal(account?.firstHand, true);
});

test('a bad evidence record is an error', () => {
  assert.ok(load('conclusion: c\nclaims:\n  c: { text: C., bet: assumed, evidence: [{ kind: rumour, says: x }] }').issues.some((i) => i.code === 'evidence-shape'));
  assert.ok(load('conclusion: c\nclaims:\n  c: { text: C., bet: assumed, evidence: [{ kind: paper }] }').issues.some((i) => i.code === 'evidence-shape'));
});

// The labels below carry a name. A label above assumed with no name on it reads as assumed, which is tested elsewhere.
test('trust stays typed, and a label the evidence does not back is flagged', () => {
  assert.deepEqual(loadOk('    bet: { trust: corroborated, by: ann }\n').codes, ['trust-unbacked']);
  assert.deepEqual(loadOk(`    bet: { trust: corroborated, by: ann }\n    evidence:\n${STAT}`).codes, ['trust-unbacked']);
  assert.deepEqual(loadOk(`    bet: { trust: corroborated, by: ann }\n    evidence:\n${STAT}${PAPER}`).codes, []);
  assert.deepEqual(loadOk('    bet: { trust: track-record, by: ann }\n').codes, ['trust-unbacked']);
  assert.deepEqual(loadOk(`    bet: { trust: track-record, by: ann }\n    evidence:\n${STAT}`).codes, []);
  assert.deepEqual(loadOk(`    bet: { trust: observed, by: ann }\n    evidence:\n${STAT}`).codes, ['trust-unbacked']);
  assert.deepEqual(loadOk('    bet: { trust: observed, by: ann }\n    evidence:\n      - { kind: account, says: I counted them., witness: me, first_hand: true }\n').codes, []);
  // Evidence never raises the label by itself: plenty of evidence, still "assumed", no complaint.
  assert.deepEqual(loadOk(`    bet: assumed\n    evidence:\n${STAT}${PAPER}`).codes, []);
});

test('two records that share an origin count as one source', () => {
  const shared = STAT.replace(' }', ', origin: the 2005 census }') + PAPER.replace(' }', ', origin: the 2005 census }');
  const { arg, codes } = loadOk(`    bet: { trust: corroborated, by: ann }\n    evidence:\n${shared}`);
  assert.equal(independentSources(arg.claims.get('c') as Claim), 1);
  assert.deepEqual(codes, ['trust-unbacked']);
});

test('evidence against a trusted bet is flagged, and unsourced evidence too', () => {
  const against = '      - { kind: paper, stance: against, says: A later study found 4 Mt., source: "doi:10.1/y" }\n';
  assert.deepEqual(loadOk(`    bet: { trust: corroborated, by: ann }\n    evidence:\n${STAT}${PAPER}${against}`).codes, ['evidence-against']);
  assert.deepEqual(loadOk('    bet: assumed\n    evidence:\n      - { kind: paper, says: Somebody showed it. }\n').codes, ['evidence-unsourced']);
});

test('an unbacked label becomes a step to check, and evidence survives bundling', () => {
  const { arg } = loadOk(`    bet: { trust: corroborated, by: ann }\n    evidence:\n${STAT}`);
  const step = nextSteps(arg, analyze(arg))[0];
  assert.equal(step?.kind, 'check');
  assert.match(step?.why ?? '', /only one independent source/);
  const again = load(toYaml(arg));
  assert.deepEqual((again.argument as Argument).claims.get('c')?.evidence, (arg.claims.get('c') as Claim).evidence);
});
