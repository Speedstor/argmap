import type { Argument, Claim, Review } from './types.ts';

/** A short fingerprint of what a reviewer judged: the claim's wording and its support. */
export function claimRev(claim: Claim): string {
  const input = `${claim.text}\u0000${JSON.stringify(claim.because)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export type ReviewState = 'unreviewed' | 'confirmed' | 'rejected' | 'split';

export interface ReviewSummary {
  state: ReviewState;
  /** Reviews of the claim as it reads now. Each reviewer's latest one counts. */
  current: Review[];
  /** Reviews of an earlier wording. Kept for the record; they no longer count. */
  stale: Review[];
  confirms: number;
  rejects: number;
}

/**
 * Where a claim stands with its reviewers. Every reviewer counts the same,
 * person or AI. When they disagree the claim is "split" and waits for
 * adjudication; nothing here picks a winner.
 */
export function reviewSummary(claim: Claim): ReviewSummary {
  const rev = claimRev(claim);
  const stale: Review[] = [];
  const latest = new Map<string, Review>();
  for (const review of claim.reviews) {
    if (review.rev !== undefined && review.rev !== rev) stale.push(review);
    else latest.set(review.by, review);
  }
  const current = [...latest.values()];
  const confirms = current.filter((r) => r.verdict === 'confirm').length;
  const rejects = current.length - confirms;
  const state: ReviewState =
    current.length === 0 ? 'unreviewed' : rejects === 0 ? 'confirmed' : confirms === 0 ? 'rejected' : 'split';
  return { state, current, stale, confirms, rejects };
}

export function reviewSummaries(arg: Argument): Map<string, ReviewSummary> {
  const out = new Map<string, ReviewSummary>();
  for (const claim of arg.claims.values()) out.set(claim.id, reviewSummary(claim));
  return out;
}
