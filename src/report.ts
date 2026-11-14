import { analyze, knockOut } from './analyze.ts';
import { reason } from './evaluate.ts';
import { resolution } from './lint.ts';
import { nextSteps } from './next.ts';
import { claimRecord, testability, vouchers } from './predict.ts';
import type { Step } from './next.ts';
import { reviewSummaries } from './review.ts';
import { plainText } from './terms.ts';
import type { Loaded } from './index.ts';
import type { Argument, Issue, Status } from './types.ts';

const MARK: Record<Status, string> = { stands: '✓', falls: '✗', contested: '?' };

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line !== '' && line.length + 1 + word.length > width - indent.length) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines.map((l) => indent + l).join('\n');
}

export function formatIssues(issues: Issue[]): string {
  if (issues.length === 0) return 'No problems found.';
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const out: string[] = [];
  for (const [name, list] of [
    ['Errors', errors],
    ['Warnings', warnings],
  ] as const) {
    if (list.length === 0) continue;
    out.push(`${name} (${list.length})`);
    for (const issue of list) out.push(wrap(`${issue.message} [${issue.code}]`, 88, '    ').replace(/^ {4}/, '  - '));
  }
  return out.join('\n');
}

function label(arg: Argument, id: string): string {
  return arg.claims.get(id)?.label ?? id;
}

export function formatReport(loaded: Loaded, knocked: ReadonlySet<string> = new Set()): string {
  const arg = loaded.argument;
  if (!arg || !loaded.ok) return formatIssues(loaded.issues);
  const a = analyze(arg, knocked);
  const out: string[] = [];
  const conclusion = arg.claims.get(arg.conclusion);

  out.push(arg.title, '='.repeat(Math.min(arg.title.length, 88)), '');
  out.push(`Conclusion: ${a.conclusion.toUpperCase()}`);
  out.push(wrap(plainText(conclusion?.text ?? ''), 88, '  '));
  out.push(wrap(reason(arg, a.statuses, knocked, arg.conclusion), 88, '  '));
  if (knocked.size > 0) out.push(`  Knocked out: ${[...knocked].join(', ')}`);
  out.push('');

  if (a.cruxes.cruxes.length > 0) {
    out.push(`Open disputes (${a.cruxes.cruxes.length})`);
    for (const c of a.cruxes.cruxes) {
      out.push(`  ${label(arg, c.a)}  vs  ${label(arg, c.b)}`);
      out.push(`      if "${label(arg, c.a)}" prevails: conclusion ${c.ifAPrevails}`);
      out.push(`      if "${label(arg, c.b)}" prevails: conclusion ${c.ifBPrevails}`);
    }
    const t = a.cruxes.tally;
    if (t) {
      out.push(
        `  Across all ${t.total} ways of settling them: stands in ${t.stands}, falls in ${t.falls}, still contested in ${t.contested}.`,
      );
      if (a.cruxes.standsOnlyIf.length > 0) {
        out.push(`  It stands only if these prevail: ${a.cruxes.standsOnlyIf.map((id) => label(arg, id)).join(', ')}.`);
      }
    }
    out.push('');
  }

  out.push(`Bets (${a.bets.length}), most exposed first`);
  const width = Math.max(...a.bets.map((b) => b.id.length), 4);
  for (const b of a.bets) {
    const flag = b.decisive ? `conclusion → ${b.conclusionIfFails}` : 'conclusion unchanged';
    out.push(
      `  ${MARK[b.status]} ${b.id.padEnd(width)}  ${b.trust.padEnd(12)}  ${b.side.padEnd(7)}  if it fails: ${flag}${
        b.alsoChanges > 0 ? `, ${b.alsoChanges} other claim${b.alsoChanges > 1 ? 's change' : ' changes'}` : ''
      }`,
    );
  }
  out.push('');

  const res = resolution(arg);
  const reviews = reviewSummaries(arg);
  const count = (state: string): number => [...reviews.values()].filter((r) => r.state === state).length;
  out.push(`Resolution: ${res.sharp} of ${res.bets} bets are specific enough to check.`);
  const withEvidence = [...arg.claims.values()].filter((c) => c.evidence.length > 0);
  const unbacked = loaded.issues.filter((i) => i.code === 'trust-unbacked').length;
  out.push(
    `Evidence: ${withEvidence.reduce((n, c) => n + c.evidence.length, 0)} records on ${withEvidence.length} claims. ${unbacked} trust label${unbacked === 1 ? ' is' : 's are'} not backed by the evidence attached.`,
  );
  const tests = testability(arg);
  out.push(`Tests: ${tests.tested} of ${tests.bets} bets have a test of their present wording. ${tests.passed} passed, ${tests.failed} failed, ${tests.open} open.`);
  if (tests.unvouched > 0) out.push(`       ${tests.unvouched} of the bets have nobody vouching for them, so no test can knock them out.`);
  out.push(
    `Reviews: ${count('confirmed')} confirmed, ${count('rejected')} rejected, ${count('split')} split, ${count('unreviewed')} unreviewed.`,
    '',
  );

  out.push(formatSteps(nextSteps(arg, a), 5), '');

  out.push('Claims');
  for (const claim of arg.claims.values()) {
    if (claim.bet) continue;
    out.push(`  ${MARK[a.statuses.get(claim.id) as Status]} ${claim.id}`);
    out.push(wrap(reason(arg, a.statuses, knocked, claim.id), 88, '      '));
  }
  out.push('');

  const warnings = loaded.issues.filter((i) => i.severity === 'warning');
  if (warnings.length > 0) out.push(formatIssues(warnings), '');
  out.push('✓ stands   ✗ falls   ? contested.  None of these means "true": they follow from the bets as written.');
  return out.join('\n');
}

const STEP_WORD: Record<Step['kind'], string> = {
  adjudicate: 'ADJUDICATE',
  answer: 'ANSWER',
  resolve: 'RESOLVE',
  accept: 'ACCEPT',
  predict: 'PREDICT',
  refine: 'REFINE',
  check: 'CHECK',
  settle: 'SETTLE',
  review: 'REVIEW',
};

export function formatSteps(steps: Step[], limit: number): string {
  if (steps.length === 0) return 'Next steps: nothing outstanding.';
  const out = [`Next steps (${Math.min(limit, steps.length)} of ${steps.length})`];
  steps.slice(0, limit).forEach((step, i) => {
    out.push(`  ${i + 1}. ${STEP_WORD[step.kind]} ${step.claims.join(' / ')}${step.decisive ? '  (can change the conclusion)' : ''}`);
    out.push(wrap(step.why, 88, '       '));
  });
  return out.join('\n');
}

export function formatKnock(arg: Argument, knocked: ReadonlySet<string>, ids: string[]): string {
  const { statuses, changes } = knockOut(arg, knocked, ids);
  const out: string[] = [`Knocking out: ${ids.join(', ')}`, ''];
  const before = changes.find((c) => c.id === arg.conclusion);
  out.push(
    before
      ? `Conclusion: ${before.from} → ${before.to}`
      : `Conclusion: ${statuses.get(arg.conclusion)} (unchanged)`,
    '',
  );
  const others = changes.filter((c) => c.id !== arg.conclusion && !ids.includes(c.id));
  if (others.length === 0) {
    out.push('Nothing else changes.');
  } else {
    out.push(`Also changes (${others.length})`);
    for (const c of others) out.push(`  ${c.id}: ${c.from} → ${c.to}`);
  }
  return out.join('\n');
}

/** A plain-data version of the analysis, for other programs. */
export function toJson(loaded: Loaded, knocked: ReadonlySet<string> = new Set()): unknown {
  const arg = loaded.argument;
  if (!arg || !loaded.ok) return { ok: false, issues: loaded.issues };
  const a = analyze(arg, knocked);
  const res = resolution(arg);
  const reviews = reviewSummaries(arg);
  return {
    ok: true,
    title: arg.title,
    conclusion: { id: arg.conclusion, status: a.conclusion },
    claims: [...arg.claims.values()].map((c) => ({
      id: c.id,
      text: plainText(c.text),
      status: a.statuses.get(c.id),
      side: a.sides.get(c.id),
      because: c.because,
      bet: c.bet,
      origin: c.origin === '' ? 'argument' : c.origin,
      evidence: c.evidence,
      predictions: c.predictions,
      ...(c.predictions.length > 0 ? { tests: claimRecord(c), vouchers: vouchers(c) } : {}),
      review: reviews.get(c.id)?.state,
      reviews: c.reviews,
      reason: reason(arg, a.statuses, knocked, c.id),
    })),
    bets: a.bets,
    cruxes: a.cruxes,
    resolution: { bets: res.bets, sharp: res.sharp, flags: Object.fromEntries(res.flags) },
    tests: testability(arg),
    nextSteps: nextSteps(arg, a),
    log: arg.log,
    issues: loaded.issues,
  };
}
