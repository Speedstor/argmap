import type { Analysis } from './analyze.ts';
import { resolution } from './lint.ts';
import { reviewSummaries } from './review.ts';
import type { Argument } from './types.ts';

export type StepKind = 'adjudicate' | 'answer' | 'refine' | 'check' | 'settle' | 'review';

export interface Step {
  kind: StepKind;
  /** The claim to work on. For "settle", the two sides of the dispute. */
  claims: string[];
  /** True when the outcome of this step can change the conclusion by itself. */
  decisive: boolean;
  why: string;
}

const ORDER: StepKind[] = ['adjudicate', 'answer', 'refine', 'check', 'settle', 'review'];

/**
 * What to do next, most valuable first. Steps on claims that can change the
 * conclusion come before the rest; within that, disagreements between
 * reviewers, then rejections, then hand-wavy bets, then unchecked ones, then
 * open disputes, then claims nobody has reviewed.
 */
export function nextSteps(arg: Argument, analysis: Analysis): Step[] {
  const reviews = reviewSummaries(arg);
  const { flags } = resolution(arg);
  const steps: (Step & { rank: number })[] = [];
  const label = (id: string): string => arg.claims.get(id)?.label ?? id;
  const push = (step: Step, rank: number): void => {
    steps.push({ ...step, rank });
  };

  analysis.bets.forEach((bet, rank) => {
    const claim = arg.claims.get(bet.id);
    const review = reviews.get(bet.id);
    if (!claim || !review) return;
    const base = { claims: [bet.id], decisive: bet.decisive };
    const found = flags.get(bet.id) ?? [];
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
