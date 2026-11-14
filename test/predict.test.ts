import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Editor, EditError } from '../src/edit.ts';
import { analyze, claimRecord, claimRev, impliedCredence, load, nextSteps, severity } from '../src/index.ts';
import type { Argument, Prediction } from '../src/index.ts';
import { allPredictions, bucketOf, dueOn, records } from '../src/record.ts';

// An invented question: can a small team reuse popular open-source code without asking each author?
const base = (licencePresent: string, extra = ''): string => `conclusion: reuse
claims:
  reuse:
    text: A small team can reuse code from popular public repositories without asking each author.
    because: [licence-present, licence-permits]
  licence-present:
${licencePresent}
  licence-permits:
    text: The licence found on 8 in 10 such repositories allows reuse in closed products.
    bet: assumed
${extra}`;

const TEXT = 'At least 9 in 10 public repositories with over 1,000 stars carry a licence file.';
const REV = claimRev({ text: TEXT, because: [] });
const test60 = (rest: string, head = 'if_true: 0.97\n        if_false: 0.15', rev = REV): string => `    text: ${TEXT}
    bet: { trust: assumed, by: ann }
    predictions:
      - says: Of 60 such repositories drawn at random, at least 51 have a licence file.
        how: A repository counts when a LICENSE or COPYING file is at its top level.
        type: lookup
        p: 0.8
        ${head}
        sample: 60
        needs: 51
        by: ann
        made: 2026-11-14
        due: 2026-11-28
        rev: ${rev}
${rest}`;

const failed = `        outcome: no
        found: 47
        resolved: 2026-11-20
        resolved_by: model-x
        resolved_kind: ai
        source: https://example.org/sample-of-60.csv
`;
const accepted = `        accepted: [{ by: ann, kind: person, date: 2026-11-14 }]
`;

function read(source: string): { arg: Argument; codes: string[]; messages: string[] } {
  const loaded = load(source);
  const errors = loaded.issues.filter((i) => i.severity === 'error').map((i) => i.message);
  assert.deepEqual(errors, []);
  return { arg: loaded.argument as Argument, codes: loaded.issues.map((i) => i.code), messages: loaded.issues.map((i) => i.message) };
}
const errorsOf = (source: string): string[] =>
  load(source)
    .issues.filter((i) => i.severity === 'error')
    .map((i) => i.message);

test('an open test changes nothing', () => {
  const { arg } = read(base(test60(accepted)));
  assert.equal(analyze(arg).conclusion, 'stands');
});

test('a failed test knocks the claim out when it was vouched to pass it', () => {
  const { arg, codes } = read(base(test60(accepted + failed)));
  const a = analyze(arg);
  assert.equal(a.statuses.get('licence-present'), 'falls');
  assert.equal(a.conclusion, 'falls');
  assert.ok(codes.includes('test-failed'));
  const step = nextSteps(arg, a)[0];
  assert.equal(`${step?.kind} ${step?.claims[0]}`, 'answer licence-present');
  assert.match(step?.why ?? '', /47 of 60, with 51 needed/);
});

test('a failed test nobody vouching for the claim accepted is evidence against, and knocks nothing out', () => {
  const { arg, codes } = read(base(test60(failed)));
  assert.equal(analyze(arg).conclusion, 'stands');
  assert.ok(codes.includes('test-against'));
  assert.ok(!codes.includes('test-failed'));
});

test('a failed test the claim did not imply is evidence against', () => {
  const { arg, messages } = read(base(test60(accepted + failed, 'if_true: 0.8\n        if_false: 0.15')));
  assert.equal(analyze(arg).conclusion, 'stands');
  assert.ok(messages.some((m) => /not taken to imply it \(if_true is 0.8\)/.test(m)));
});

test('rewording a claim clears the knock-out, and the failure stays on its record', () => {
  const source = base(test60(accepted + failed, undefined, '0'.repeat(32)));
  const { arg } = read(source);
  assert.equal(analyze(arg).conclusion, 'stands');
  const record = claimRecord(arg.claims.get('licence-present') as NonNullable<ReturnType<Argument['claims']['get']>>);
  assert.equal(record.failedEarlier, 1);
  assert.equal(record.failed, 0);
});

test('an accepted test marked overdue holds the claim back until it is resolved', () => {
  const overdue = '        overdue: { by: model-x, kind: ai, date: 2026-12-05 }\n';
  const held = read(base(test60(accepted + overdue)));
  const a = analyze(held.arg);
  assert.equal(a.statuses.get('licence-present'), 'contested');
  assert.equal(a.conclusion, 'contested');
  assert.ok(held.codes.includes('test-overdue'));
  assert.equal(nextSteps(held.arg, a)[0]?.kind, 'resolve');
  // A marker on a test nobody accepted holds nothing back: otherwise anyone could stall a claim.
  assert.equal(analyze(read(base(test60(overdue))).arg).conclusion, 'stands');
});

test('a passed test changes no status and adds to what the claim has survived', () => {
  const passed = `        outcome: yes\n        found: 55\n        resolved: 2026-11-20\n        resolved_by: model-x\n        resolved_kind: ai\n        source: https://example.org/sample-of-60.csv\n`;
  const { arg } = read(base(test60(accepted + passed)));
  assert.equal(analyze(arg).conclusion, 'stands');
  const record = claimRecord(arg.claims.get('licence-present') as NonNullable<ReturnType<Argument['claims']['get']>>);
  assert.equal(record.passed, 1);
  // Ann set the test on a claim she vouches for, so its hardness is her own figure and is kept apart from figures typed by others.
  assert.ok(Math.abs(record.bitsOwn - Math.log2(0.97 / 0.15)) < 1e-9);
  assert.deepEqual([record.bitsOthers, record.passedFromOthers, record.passedNoRisk], [0, 0, 0]);
});

test('a pass counts only where a failure would have knocked the claim out', () => {
  const passed = `        outcome: yes\n        found: 55\n        resolved: 2026-11-20\n        resolved_by: model-x\n        resolved_kind: ai\n        source: https://example.org/sample-of-60.csv\n`;
  const record = (source: string): ReturnType<typeof claimRecord> => claimRecord(read(source).arg.claims.get('licence-present') as NonNullable<ReturnType<Argument['claims']['get']>>);
  // Nobody accepted it, or the claim was not taken to imply it: a failure would have cost nothing, so the pass shows nothing.
  for (const free of [base(test60(passed)), base(test60(accepted + passed, 'if_true: 0.94\n        if_false: 0.15'))]) {
    const r = record(free);
    assert.deepEqual([r.passed, r.passedNoRisk, r.bitsOwn + r.bitsOthers], [0, 1, 0]);
  }
});

test('withdrawing an accepted test is counted on the claim', () => {
  const withdrawn = `        outcome: void\n        resolved: 2026-11-20\n        resolved_by: ann\n        note: The list of repositories was taken down.\n`;
  const { arg, codes } = read(base(test60(accepted + withdrawn)));
  assert.equal(analyze(arg).conclusion, 'stands');
  assert.ok(codes.includes('test-withdrawn'));
  assert.equal(claimRecord(arg.claims.get('licence-present') as NonNullable<ReturnType<Argument['claims']['get']>>).withdrawn, 1);
});

test('a pending test follows its claim through a reword', () => {
  const overdue = '        overdue: { by: model-x, kind: ai, date: 2026-12-05 }\n';
  const { arg, codes } = read(base(test60(accepted + overdue, undefined, '0'.repeat(32))));
  assert.equal(analyze(arg).statuses.get('licence-present'), 'contested');
  assert.ok(codes.includes('test-overdue'));
});

test('a prediction needs its fingerprint and real dates, and is recorded once', () => {
  assert.match(errorsOf(base(test60('').replace(/        rev: .*\n/, '')))[0] ?? '', /needs "rev"/);
  assert.match(errorsOf(base(test60('').replace('made: 2026-11-14', 'made: soon')))[0] ?? '', /must be dates written as YYYY-MM-DD/);
  assert.match(errorsOf(base(test60('').replace('due: 2026-11-28', 'due: 2026-11-01')))[0] ?? '', /due on or after made/);
  assert.match(errorsOf(base(test60('        overdue: { by: model-x, kind: ai }\n')))[0] ?? '', /an overdue marker needs its date/);
  assert.match(errorsOf(base(test60('        overdue: { by: model-x, kind: ai, date: 2026-11-20 }\n')))[0] ?? '', /after the due date/);
  assert.match(errorsOf(base(test60(failed.replace('        resolved: 2026-11-20\n', ''))))[0] ?? '', /needs "resolved"/);
  const twice = base(test60('')).replace(/(      - says: [\s\S]*?rev: \w+\n)/, '$1$1');
  assert.match(errorsOf(twice)[0] ?? '', /is the same prediction as an earlier one/);
});

test('the outcome of a sampled test follows from the count', () => {
  assert.match(errorsOf(base(test60(failed.replace('outcome: no', 'outcome: yes'))))[0] ?? '', /found 47 of 60 with 51 needed makes the outcome no, not yes/);
  assert.match(errorsOf(base(test60(failed.replace('        found: 47\n', ''))))[0] ?? '', /needs "found"/);
  assert.match(errorsOf(base(test60(failed.replace(/        source: .*\n/, ''))))[0] ?? '', /needs a "source"/);
  assert.match(errorsOf(base(test60('').replace('p: 0.8', 'p: 1.2')))[0] ?? '', /above 0 and below 1/);
  assert.match(errorsOf(base(test60('').replace('needs: 51', 'needs: 61')))[0] ?? '', /needs between 1 and sample/);
});

test('hardness comes from if_true and if_false, and the setter\'s own number is left out of it', () => {
  const p = { p: 0.8, ifTrue: 1, ifFalse: 0.25 } as Prediction;
  assert.equal(severity(p), 2);
  assert.equal(severity({ ...p, p: 0.3 } as Prediction), 2);
  assert.ok(Math.abs((impliedCredence(p) as number) - 0.55 / 0.75) < 1e-9);
  assert.equal(impliedCredence({ p: 0.9, ifTrue: 0.8, ifFalse: 0.2 } as Prediction), undefined);
});

test('soft, inconsistent and one-case tests are flagged', () => {
  const soft = read(base(test60(accepted, 'if_true: 0.9\n        if_false: 0.6')));
  assert.ok(soft.codes.includes('test-soft'));
  const silent = read(base(test60(accepted).replace('        if_true: 0.97\n        if_false: 0.15\n', '')));
  assert.ok(silent.messages.some((m) => /does not say how likely a yes would be if the claim were false/.test(m)));
  const odd = read(base(test60(accepted, 'if_true: 0.7\n        if_false: 0.15')));
  assert.ok(odd.codes.includes('test-inconsistent'));
  const doubt = read(base(test60(accepted, 'if_true: 0.97\n        if_false: 0.7').replace('trust: assumed', 'trust: corroborated')));
  assert.ok(doubt.messages.some((m) => /imply a belief of about 37%/.test(m)));
  const one = read(`conclusion: c
claims:
  c:
    text: Buses on the number 9 route usually arrive within five minutes of the timetable.
    bet: { trust: assumed, by: ann }
    predictions:
      - says: The 08:10 bus on 2 December arrives by 08:15.
        how: Read the arrival time from the operator's live board.
        type: forecast
        p: 0.7
        if_false: 0.3
        by: ann
        made: 2026-11-14
        due: 2026-12-02
        rev: ${claimRev({ text: 'Buses on the number 9 route usually arrive within five minutes of the timetable.', because: [] })}
        accepted: [{ by: ann }]
`);
  assert.ok(one.codes.includes('test-one-case'));
});

test('a test set by someone who does not vouch for the claim waits to be accepted', () => {
  const { arg, messages } = read(base(test60('').replace('by: ann\n        made', 'by: model-x\n        kind: ai\n        made')));
  assert.ok(messages.some((m) => /is waiting for ann to accept it/.test(m)));
  const step = nextSteps(arg, analyze(arg)).find((s) => s.claims[0] === 'licence-present');
  assert.equal(step?.kind, 'accept');
  const record = claimRecord(arg.claims.get('licence-present') as NonNullable<ReturnType<Argument['claims']['get']>>);
  assert.deepEqual([record.offered, record.offeredAccepted], [1, 0]);
});

test('the editor records a test, its acceptance and its outcome, each once', () => {
  const root = mkdtempSync(join(tmpdir(), 'argmap-predict-'));
  try {
    mkdirSync(join(root, 'arguments'));
    mkdirSync(join(root, 'claims'));
    const path = join(root, 'arguments', 'reuse.yaml');
    writeFileSync(
      path,
      `argmap: 1\ntitle: Reuse\n${base('    text: At least 9 in 10 public repositories with over 1,000 stars carry a licence file.\n    bet: { trust: assumed, by: ann }')}`,
    );
    const due = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
    const make = { says: 'Of 60 such repositories drawn at random, at least 51 have a licence file.', how: 'Top-level LICENSE or COPYING file.', type: 'lookup' as const, p: 0.8, ifFalse: 0.15, sample: 60, needs: 51, due };
    // Ann vouches for the bet, so setting a test on it accepts it. The model does not, so its test waits.
    new Editor(path).predict('licence-present', { ...make, by: 'ann', kind: 'person' }).save({ by: 'ann', did: 'predict', claim: 'licence-present' });
    new Editor(path).predict('licence-present', { ...make, says: 'Of 60 more, at least 54 have one.', needs: 54, by: 'model-x', kind: 'ai' }).save({ by: 'model-x', did: 'predict', claim: 'licence-present' });
    let claim = load(readFileSync(path, 'utf8')).argument?.claims.get('licence-present');
    assert.deepEqual(claim?.predictions.map((p) => p.accepted.map((a) => a.by)), [['ann'], []]);
    assert.ok(claim?.predictions.every((p) => p.rev !== undefined && p.ifTrue === 1));

    assert.throws(() => new Editor(path).accept('licence-present', 2, { by: 'model-x', kind: 'ai' }), /does not vouch for "licence-present"/);
    // While an accepted test is waiting, the claim cannot be reworded out from under it, and only its setter can withdraw it.
    assert.throws(() => new Editor(path).reword('licence-present', 'Some repositories carry a licence file.'), /accepted test waiting for its outcome \(test 1\)/);
    assert.throws(() => new Editor(path).resolve('licence-present', 1, { outcome: 'void', note: 'Changed my mind.', by: 'model-x', kind: 'ai' }), /Only ann, who set that prediction, can withdraw it/);
    assert.throws(() => new Editor(path).markOverdue('licence-present', 1, { by: 'model-x', kind: 'ai' }), /not overdue/);
    assert.throws(() => new Editor(path).resolve('licence-present', 1, { outcome: 'yes', found: 47, source: 'x', by: 'model-x', kind: 'ai' }), /is a no, not a yes/);
    assert.throws(() => new Editor(path).resolve('licence-present', 1, { found: 47, by: 'model-x', kind: 'ai' }), /needs a source/);
    assert.throws(() => new Editor(path).predict('licence-present', { ...make, due: '2020-01-01', by: 'ann', kind: 'person' }), /already past/);

    const result = new Editor(path)
      .resolve('licence-present', 1, { found: 47, source: 'https://example.org/sample-of-60.csv', by: 'model-x', kind: 'ai' })
      .save({ by: 'model-x', did: 'resolve', claim: 'licence-present' });
    assert.equal(result.conclusion, 'falls');
    assert.throws(() => new Editor(path).resolve('licence-present', 1, { found: 55, source: 'x', by: 'ann', kind: 'person' }), /already has an outcome/);
    assert.throws(() => new Editor(path).accept('licence-present', 1, { by: 'ann', kind: 'person' }), /already has an outcome/);
    assert.throws(() => new Editor(path).confirmOutcome('licence-present', 1, { by: 'model-x', kind: 'ai' }), /cannot also confirm/);
    new Editor(path).confirmOutcome('licence-present', 1, { by: 'ann', kind: 'person' }).save({ by: 'ann', did: 'confirm', claim: 'licence-present' });

    // Rewording to what was found clears the knock-out; the failed test stays where it was.
    const reworded = new Editor(path).reword('licence-present', 'About 8 in 10 public repositories with over 1,000 stars carry a licence file.').save({ by: 'ann', did: 'reword', claim: 'licence-present' });
    assert.equal(reworded.conclusion, 'stands');
    claim = load(readFileSync(path, 'utf8')).argument?.claims.get('licence-present');
    assert.equal(claim?.predictions[0]?.outcome, 'no');
    assert.equal(claim?.predictions[0]?.confirmed[0]?.by, 'ann');

    const entries = allPredictions(root);
    assert.deepEqual(entries.map((e) => [e.file, e.claim, e.n, e.current]), [
      ['arguments/reuse.yaml', 'licence-present', 1, false],
      ['arguments/reuse.yaml', 'licence-present', 2, false],
    ]);
    const { due: now, upcoming } = dueOn(entries, due);
    assert.deepEqual([now.length, now[0]?.late, upcoming.length], [1, 0, 0]);
    assert.ok(new Editor(path) instanceof Editor && EditError !== undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const made = (i: number, p: number, outcome: 'yes' | 'no' | undefined, more: Partial<Prediction> = {}): { file: string; claim: string; n: number; prediction: Prediction; current: boolean } => ({
  file: 'arguments/x.yaml',
  claim: 'c',
  n: i,
  current: true,
  prediction: {
    says: `case ${i}`,
    how: 'look',
    type: 'lookup',
    p,
    ifTrue: 1,
    ifFalse: 0.5,
    by: 'ann',
    kind: 'person',
    made: '2026-01-01',
    due: '2026-01-10',
    accepted: [],
    confirmed: [],
    ...(outcome ? { outcome, resolved: '2026-01-05', resolvedBy: i % 2 === 0 ? 'ann' : 'model-x', resolvedKind: 'person' as const, source: 's' } : {}),
    ...more,
  },
});

test('a record is scored per kind of prediction, and at its worst', () => {
  // Ten lookups at 90%, nine of which came out yes: well calibrated, and no better than always saying 90%.
  const safe = Array.from({ length: 10 }, (_, i) => made(i, 0.9, i === 0 ? 'no' : 'yes'));
  const [ann] = records([...safe, made(10, 0.9, undefined), made(11, 0.6, 'yes', { type: 'forecast', made: '2026-01-01', resolved: '2026-06-01' })]);
  const lookups = ann?.buckets[0];
  assert.deepEqual([lookups?.scored, lookups?.open], [10, 1]);
  assert.ok(Math.abs((lookups?.brier as number) - 0.09) < 1e-9);
  // The open one, counted as if it went against her: (0.09 * 10 + 0.81) / 11.
  assert.ok(Math.abs((lookups?.worst as number) - 1.71 / 11) < 1e-9);
  // One forecast is too few to score, and it is not pooled with the lookups.
  const forecasts = ann?.buckets[2];
  assert.deepEqual([forecasts?.name, forecasts?.scored, forecasts?.brier], ['Forecasts, 30 days to a year', 1, undefined]);
  assert.deepEqual([ann?.resolvedBySelf, ann?.resolvedByOthers, ann?.set], [5, 6, 12]);
  assert.equal(ann?.bits, 1);

  // A withdrawn prediction is not scored, and counts against its setter in the worst case like an open one.
  const [withdrew] = records([...safe, { ...made(10, 0.9, undefined), prediction: { ...made(10, 0.9, undefined).prediction, outcome: 'void' as const, note: 'why' } }]);
  assert.deepEqual([withdrew?.buckets[0]?.scored, withdrew?.withdrawn], [10, 1]);
  assert.ok(Math.abs((withdrew?.buckets[0]?.worst as number) - 1.71 / 11) < 1e-9);
  assert.equal(bucketOf(made(1, 0.5, undefined, { type: 'forecast', made: '2026-01-01', due: '2027-06-01' }).prediction), 'Forecasts, over a year');
});

test('the fingerprint tells apart two wordings that the old short one confused', async () => {
  const { createHash } = await import('node:crypto');
  const { sha256Hex } = await import('../src/sha256.ts');
  for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), `é☃ ${'x'.repeat(1000)}`]) {
    assert.equal(sha256Hex(text), createHash('sha256').update(text).digest('hex'));
  }
  const { legacyRev, reviewSummary } = await import('../src/index.ts');
  // Found by the reviewer in 300,000 tries: one 8-digit fingerprint, two claims.
  const one = { text: 'Some shops on this  road  are open  before 9am.', because: [] };
  const two = { text: 'Each  shop  along this  road opens before 6am .', because: [] };
  assert.equal(legacyRev(one), legacyRev(two));
  assert.notEqual(claimRev(one), claimRev(two));
  assert.equal(claimRev(one).length, 32);
  // A review recorded before the change, with the short fingerprint, still counts for the wording it judged.
  const claim = { id: 'c', label: 'c', origin: '', evidence: [], predictions: [], ...one, reviews: [{ by: 'ann', kind: 'person' as const, verdict: 'confirm' as const, rev: legacyRev(one) }] };
  assert.equal(reviewSummary(claim).state, 'confirmed');
  assert.equal(reviewSummary({ ...claim, text: 'Reworded.' }).state, 'unreviewed');
});

test('redefining a pinned term makes earlier tests and reviews stale', async () => {
  const { reviewSummary } = await import('../src/index.ts');
  const text = 'Every {shop} on the street opens before nine.';
  const file = (definition: string, rev: string): string => `conclusion: a
terms:
  shop: ${definition}
claims:
  a:
    text: ${text}
    bet: { trust: observed, by: ann }
    predictions:
      - says: The bakery opens before nine.
        how: Read the sign on the door.
        type: lookup
        p: 0.9
        if_false: 0.3
        by: ann
        made: 2026-11-14
        due: 2026-11-28
        rev: ${rev}
        accepted: [{ by: ann, kind: person, date: 2026-11-14 }]
        outcome: yes
        resolved: 2026-11-20
        resolved_by: ann
        source: https://example.org/door
    reviews:
      - { by: bob, kind: person, verdict: confirm, rev: ${rev} }
`;
  const narrow = read(file('A bakery.', 'x')).arg.claims.get('a') as NonNullable<ReturnType<Argument['claims']['get']>>;
  const rev = claimRev(narrow);
  // The definition is part of the fingerprint, so it differs from the fingerprint of the bare text.
  assert.notEqual(rev, claimRev({ text, because: [] }));
  const before = read(file('A bakery.', rev)).arg.claims.get('a') as typeof narrow;
  assert.deepEqual([claimRecord(before).passed, reviewSummary(before).state], [1, 'confirmed']);
  // Widen what "shop" means, and the same sentence is a different claim: the passed test and the confirmation no longer count.
  const after = read(file('Any premises that sells anything, including bars and night markets.', rev)).arg.claims.get('a') as typeof narrow;
  assert.deepEqual([claimRecord(after).passed, reviewSummary(after).state], [0, 'unreviewed']);
});

test('a test set by someone who vouches for the claim is the claim\'s own, whoever accepted it', () => {
  // Two vouch for the claim: ann by the label, model-x by a standing confirmation. model-x sets a sure thing and ann accepts it.
  const source = base(
    `${test60(`${accepted}        outcome: yes\n        found: 60\n        resolved: 2026-11-20\n        resolved_by: model-x\n        resolved_kind: ai\n        source: https://example.org/s\n`, 'if_false: 0.01').replace('by: ann\n        made', 'by: model-x\n        kind: ai\n        made')}    reviews:\n      - { by: model-x, kind: ai, verdict: confirm, rev: ${REV} }\n`,
  );
  const record = claimRecord(read(source).arg.claims.get('licence-present') as NonNullable<ReturnType<Argument['claims']['get']>>);
  assert.deepEqual([record.passed, record.passedFromOthers, record.bitsOthers, record.offered], [1, 0, 0, 0]);
  assert.ok(record.bitsOwn > 6);
});

test('a claim that has only passed its own side\'s tests is flagged until someone else tests it', () => {
  const passed = `        outcome: yes\n        found: 55\n        resolved: 2026-11-20\n        resolved_by: model-x\n        resolved_kind: ai\n        source: https://example.org/sample-of-60.csv\n`;
  const byModel = (source: string): string => source.replace('by: ann\n        made', 'by: model-x\n        kind: ai\n        made');
  // Ann vouches for the claim, set the test and it passed: nobody outside has tried to knock the claim out.
  const own = read(base(test60(accepted + passed)));
  assert.ok(own.messages.some((m) => /"licence-present" has passed 1 test that could have knocked it out, and its own side set it \(ann\)/.test(m)));
  // The warning points and nothing more.
  assert.equal(analyze(own.arg).conclusion, 'stands');
  // The same test set by someone who does not vouch for the claim, and accepted by Ann.
  assert.ok(!read(base(byModel(test60(accepted + passed)))).codes.includes('test-own-only'));
  // A pass that could not have knocked the claim out is not a pass to speak of.
  assert.ok(!read(base(test60(accepted + passed, 'if_true: 0.8\n        if_false: 0.15'))).codes.includes('test-own-only'));
  // An open test says nothing yet.
  assert.ok(!read(base(test60(accepted))).codes.includes('test-own-only'));
  // A second test, from someone who does not vouch for the claim, on what the first leaves out.
  const second = (rest: string): string => `      - says: Of 60 further such repositories, at least 51 carry a licence that a standard list of licences names.
        how: A licence counts when its text matches an entry on the SPDX list.
        type: lookup
        p: 0.6
        if_true: 0.97
        if_false: 0.3
        sample: 60
        needs: 51
        by: model-x
        kind: ai
        made: 2026-11-21
        due: 2026-12-05
        rev: ${REV}
${rest}`;
  // Offered and not yet accepted, it could not knock the claim out, so the warning stays.
  assert.ok(read(base(test60(accepted + passed) + second(''))).codes.includes('test-own-only'));
  // Accepted and waiting for its outcome, it is the outside test the warning asks for.
  const acceptedLater = `        accepted: [{ by: ann, kind: person, date: 2026-11-21 }]\n`;
  assert.ok(!read(base(test60(accepted + passed) + second(acceptedLater))).codes.includes('test-own-only'));
  // Once it passes, the claim has survived a test from outside.
  const passedLater = `        outcome: yes\n        found: 53\n        resolved: 2026-11-30\n        resolved_by: model-x\n        resolved_kind: ai\n        source: https://example.org/second-sample.csv\n`;
  assert.ok(!read(base(test60(accepted + passed) + second(acceptedLater + passedLater))).codes.includes('test-own-only'));
  // Two vouch for the claim, one set the test and the other accepted it: still the claim's own side.
  const two = read(
    base(`${byModel(test60(accepted + passed))}    reviews:\n      - { by: model-x, kind: ai, verdict: confirm, rev: ${REV} }\n`),
  );
  assert.ok(two.messages.some((m) => /has passed 1 test that could have knocked it out, and its own side set it \(model-x\)/.test(m)));
});

test('a label above assumed with nobody\'s name behind it reads as assumed', async () => {
  const { readsAs } = await import('../src/index.ts');
  const bet = (label: string, reviews = ''): Argument => read(`conclusion: c\nclaims:\n  c:\n    text: Output reached 10 Mt in 2005.\n    bet: ${label}\n${reviews}`).arg;
  const claim = (arg: Argument): NonNullable<ReturnType<Argument['claims']['get']>> => arg.claims.get('c') as NonNullable<ReturnType<Argument['claims']['get']>>;
  const unnamed = bet('corroborated');
  assert.equal(readsAs(claim(unnamed)), 'assumed');
  // The label as typed stays in the file and in the report, next to what it reads as.
  assert.deepEqual([analyze(unnamed).bets[0]?.trust, analyze(unnamed).bets[0]?.labelled], ['assumed', 'corroborated']);
  assert.ok(load('conclusion: c\nclaims:\n  c: { text: Output reached 10 Mt in 2005., bet: corroborated }').issues.some((i) => i.code === 'trust-unvouched'));
  // A name on the label, or a standing confirmation, is someone standing behind it.
  assert.equal(readsAs(claim(bet('{ trust: corroborated, by: ann }'))), 'corroborated');
  assert.equal(readsAs(claim(bet('corroborated', '    reviews:\n      - { by: bob, verdict: confirm }\n'))), 'corroborated');
  assert.equal(readsAs(claim(bet('corroborated', '    reviews:\n      - { by: bob, verdict: reject }\n'))), 'assumed');
  assert.equal(readsAs(claim(bet('assumed'))), 'assumed');
});
