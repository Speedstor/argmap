import type { Analysis } from './analyze.ts';
import { evidenceIssues } from './evidence.ts';
import { resolution } from './lint.ts';
import { blocks, isCurrent, knocks, vouchers } from './predict.ts';
import { reviewSummaries } from './review.ts';
import type { Argument } from './types.ts';

export type StepKind = 'adjudicate' | 'answer' | 'resolve' | 'accept' | 'refine' | 'predict' | 'check' | 'settle' | 'review';

export interface Step {
  kind: StepKind;
  /** The claim to work on. For "settle", the two sides of the dispute. */
  claims: string[];
  /** True when the outcome of this step can change the conclusion by itself. */
  decisive: boolean;
  why: string;
}

const ORDER: StepKind[] = ['adjudicate', 'answer', 'resolve', 'accept', 'refine', 'predict', 'check', 'settle', 'review'];

/**
 * What to do next, most valuable first. Steps on claims that can change the
 * conclusion come before the rest; within that, disagreements between
 * reviewers, then rejections and failed tests, then tests waiting for an
 * outcome or for someone to accept them, then hand-wavy bets, then bets with
 * no test, then unchecked ones, then open disputes, then claims nobody has
 * reviewed.
 */
export function nextSteps(arg: Argument, analysis: Analysis): Step[] {
  const reviews = reviewSummaries(arg);
  const { flags } = resolution(arg);
  const unbacked = new Map<string, string>();
  for (const issue of evidenceIssues(arg)) {
    const id = issue.claims[0];
    if (id && (issue.code === 'trust-unbacked' || issue.code === 'evidence-against') && !unbacked.has(id)) unbacked.set(id, issue.message);
  }
  const steps: (Step & { rank: number })[] = [];
  const label = (id: string): string => arg.claims.get(id)?.label ?? id;
  const push = (step: Step, rank: number): void => {
    steps.push({ ...step, rank });
  };

  // Tests: a failure to answer, an outcome to record, or a test waiting to be accepted. Returns true when it named a step.
  const testStep = (id: string, decisive: boolean, rank: number): boolean => {
    const claim = arg.claims.get(id);
    if (!claim) return false;
    const current = claim.predictions.filter((p) => isCurrent(claim, p));
    const base = { claims: [id] };
    const failed = current.find((p) => knocks(claim, p));
    if (failed) {
      const count = failed.found !== undefined ? ` (${failed.found} of ${failed.sample}, with ${failed.needs} needed)` : '';
      push({ ...base, kind: 'answer', decisive: true, why: `"${label(id)}" failed a test it was vouched to pass${count}, so it has fallen. Reword it to what was found, or let it fall and repair what rested on it.` }, rank);
      return true;
    }
    const against = current.find((p) => p.outcome === 'no');
    if (against) {
      push({ ...base, kind: 'answer', decisive, why: `A test of "${label(id)}" failed: "${against.says}" It counts as evidence against. Say why the claim still holds, or reword it.` }, rank);
      return true;
    }
    const late = claim.predictions.find((p) => blocks(claim, p));
    if (late) {
      push({ ...base, kind: 'resolve', decisive: true, why: `A test of "${label(id)}" was due on ${late.due} and has no outcome, so the claim cannot stand. Record what was found.` }, rank);
      return true;
    }
    const open = current.filter((p) => p.outcome === undefined);
    const waiting = open.find((p) => p.accepted.length === 0);
    const backers = vouchers(claim);
    if (waiting && backers.length > 0) {
      push({ ...base, kind: 'accept', decisive, why: `${waiting.by} set a test of "${label(id)}": "${waiting.says}" Until ${backers.join(' or ')} accepts it, a failure cannot knock the claim out.` }, rank);
      return true;
    }
    const next = open[0];
    if (next) {
      push({ ...base, kind: 'resolve', decisive, why: `A test of "${label(id)}" is open, due ${next.due}: "${next.says}" Check it and record what was found.` }, rank);
      return true;
    }
    return false;
  };

  analysis.bets.forEach((bet, rank) => {
    const claim = arg.claims.get(bet.id);
    const review = reviews.get(bet.id);
    if (!claim || !review) return;
    const base = { claims: [bet.id], decisive: bet.decisive };
    const found = flags.get(bet.id) ?? [];
    if (review.state !== 'split' && review.state !== 'rejected' && testStep(bet.id, bet.decisive, rank)) return;
    const tested = claim.predictions.some((p) => isCurrent(claim, p));
    if (review.state === 'split') {
      push(
        {
          ...base,
          kind: 'adjudicate',
          why: `Reviewers disagree on "${label(bet.id)}": ${review.confirms} confirm, ${review.rejects} reject. It needs a decision.`,
        },
        rank,
      );
    } else if (review.state === 'rejected') {
      const who = review.current.map((r) => r.by).join(', ');
      push({ ...base, kind: 'answer', why: `"${label(bet.id)}" was rejected by ${who}. Revise it, replace it, or knock it out.` }, rank);
    } else if (found.length > 0) {
      push({ ...base, kind: 'refine', why: `"${label(bet.id)}" is hand-wavy. ${found.map((f) => f.message).join(' ')}` }, rank);
    } else if (unbacked.has(bet.id)) {
      push({ ...base, kind: 'check', why: unbacked.get(bet.id) as string }, rank);
    } else if (!tested && (bet.trust === 'assumed' || bet.trust === 'track-record')) {
      push(
        {
          ...base,
          kind: 'predict',
          why: `"${label(bet.id)}" is specific but has never been tested. Before you look anything up, record what you expect to find and how sure you are. Then check.`,
        },
        rank,
      );
    } else if (bet.trust === 'assumed' || bet.trust === 'track-record') {
      push(
        {
          ...base,
          kind: 'check',
          why:
            bet.trust === 'assumed'
              ? `"${label(bet.id)}" is specific but unchecked. Find a source or test, then raise its trust.`
              : `"${label(bet.id)}" rests on a track record. Look for an independent source.`,
        },
        rank,
      );
    } else if (review.state === 'unreviewed') {
      push({ ...base, kind: 'review', why: `Nobody has reviewed "${label(bet.id)}".` }, rank);
    }
  });

  const now = analysis.conclusion;
  analysis.cruxes.cruxes.forEach((crux, rank) => {
    push(
      {
        kind: 'settle',
        claims: [crux.a, crux.b],
        decisive: crux.ifAPrevails !== now || crux.ifBPrevails !== now,
        why: `"${label(crux.a)}" and "${label(crux.b)}" are in open dispute. Find evidence that favours one, or sharpen both until they stop conflicting.`,
      },
      rank,
    );
  });

  // Supported claims: is the step from support to claim sound?
  let rank = 0;
  for (const claim of arg.claims.values()) {
    if (claim.bet) continue;
    const review = reviews.get(claim.id);
    if (!review) continue;
    const base = { claims: [claim.id], decisive: false };
    if (review.state !== 'split' && review.state !== 'rejected' && testStep(claim.id, false, rank)) {
      rank++;
      continue;
    }
    if (review.state === 'split') {
      push({ ...base, kind: 'adjudicate', why: `Reviewers disagree on whether "${label(claim.id)}" follows from its support.` }, rank);
    } else if (review.state === 'rejected') {
      push(
        { ...base, kind: 'answer', why: `A reviewer says "${label(claim.id)}" does not follow from its support. Look for a missing premise.` },
        rank,
      );
    } else if (review.state === 'unreviewed') {
      push({ ...base, kind: 'review', why: `Nobody has checked that "${label(claim.id)}" follows from its support.` }, rank);
    }
    rank++;
  }

  return steps
    .sort(
      (a, b) =>
        Number(b.decisive) - Number(a.decisive) || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.rank - b.rank,
    )
    .map(({ rank: _rank, ...step }) => step);
}
