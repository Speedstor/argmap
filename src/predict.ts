import { claimRev, reviewSummary } from './review.ts';
import { plainText } from './terms.ts';
import type { Argument, Claim, Issue, Prediction } from './types.ts';

/** At or above this chance of a yes when the claim is true, the claim is taken to imply the test. */
export const IMPLIES = 0.95;
/** A test is soft when a yes is less than this many times likelier with the claim true than with it false. */
export const SOFT_RATIO = 2;

/**
 * Who vouches for a claim: whoever set its trust label, and every reviewer whose
 * confirmation of the present wording stands. The role is read off the record;
 * a claim has no owner.
 */
export function vouchers(claim: Claim): string[] {
  const names = new Set<string>();
  if (claim.bet?.by) names.add(claim.bet.by);
  for (const review of reviewSummary(claim).current) if (review.verdict === 'confirm') names.add(review.by);
  return [...names];
}

/** Does this test the claim as it reads now? A test of an earlier wording is kept, and no longer counts. */
export function isCurrent(claim: Claim, prediction: Prediction, rev = claimRev(claim)): boolean {
  return prediction.rev === undefined || prediction.rev === rev;
}

/**
 * How hard a test is, in bits: how many times likelier a yes is with the claim
 * true than with it false, on a log scale. One bit means twice as likely.
 * The setter's own chance of a yes is left out, because it mixes in how far the
 * setter believes the claim.
 */
export function severity(prediction: Prediction): number | undefined {
  return prediction.ifFalse === undefined ? undefined : Math.log2(prediction.ifTrue / prediction.ifFalse);
}

/** The setter's belief in the claim, as implied by the three chances given. Undefined when they do not fit together. */
export function impliedCredence(prediction: Prediction): number | undefined {
  if (prediction.ifFalse === undefined) return undefined;
  const span = prediction.ifTrue - prediction.ifFalse;
  if (span <= 0) return undefined;
  const credence = (prediction.p - prediction.ifFalse) / span;
  return credence < -1e-9 || credence > 1 + 1e-9 ? undefined : Math.min(1, Math.max(0, credence));
}

/**
 * A failed test knocks a claim out when three things hold: it tested the
 * present wording, the claim was taken to imply a yes, and someone who vouches
 * for the claim agreed to that before the outcome. Anything less is evidence
 * against the claim, not a refutation.
 */
export function knocks(claim: Claim, prediction: Prediction, rev = claimRev(claim)): boolean {
  return prediction.outcome === 'no' && prediction.ifTrue >= IMPLIES && prediction.accepted.length > 0 && isCurrent(claim, prediction, rev);
}

/** An accepted test that is marked overdue and still open: the claim cannot stand until someone records what was found. */
export function blocks(claim: Claim, prediction: Prediction, rev = claimRev(claim)): boolean {
  return prediction.outcome === undefined && prediction.overdue !== undefined && prediction.accepted.length > 0 && isCurrent(claim, prediction, rev);
}

/** Claims the tests have settled: fallen because a test failed, or held back because one is overdue. */
export function testVerdicts(arg: Argument): { fallen: Set<string>; held: Set<string> } {
  const fallen = new Set<string>();
  const held = new Set<string>();
  for (const claim of arg.claims.values()) {
    if (claim.predictions.length === 0) continue;
    const rev = claimRev(claim);
    if (claim.predictions.some((p) => knocks(claim, p, rev))) fallen.add(claim.id);
    else if (claim.predictions.some((p) => blocks(claim, p, rev))) held.add(claim.id);
  }
  return { fallen, held };
}

/** What a claim has been through. This is the part of a record nobody can pad with easy predictions of their own choosing. */
export interface ClaimRecord {
  /** Tests of the present wording. */
  open: number;
  passed: number;
  failed: number;
  /** Of the passed tests, how many were set by someone whose rejection of the claim stands. */
  passedFromOpponents: number;
  /** The hardness of the passed tests, added up, in bits. */
  bitsSurvived: number;
  /** Tests set by someone who does not vouch for the claim, and how many of those a voucher accepted. */
  offered: number;
  offeredAccepted: number;
  /** Tests that failed under an earlier wording: how often the claim was reworded after failing. */
  failedEarlier: number;
}

export function claimRecord(claim: Claim): ClaimRecord {
  const rev = claimRev(claim);
  const backers = new Set(vouchers(claim));
  const rejecters = new Set(
    reviewSummary(claim)
      .current.filter((r) => r.verdict === 'reject')
      .map((r) => r.by),
  );
  const record: ClaimRecord = { open: 0, passed: 0, failed: 0, passedFromOpponents: 0, bitsSurvived: 0, offered: 0, offeredAccepted: 0, failedEarlier: 0 };
  for (const p of claim.predictions) {
    if (!isCurrent(claim, p, rev)) {
      if (p.outcome === 'no') record.failedEarlier++;
      continue;
    }
    if (!backers.has(p.by)) {
      record.offered++;
      if (p.accepted.length > 0) record.offeredAccepted++;
    }
    if (p.outcome === undefined) record.open++;
    else if (p.outcome === 'yes') {
      record.passed++;
      record.bitsSurvived += severity(p) ?? 0;
      if (rejecters.has(p.by)) record.passedFromOpponents++;
    } else if (p.outcome === 'no') record.failed++;
  }
  return record;
}

/** Words that make a claim about many cases, so that one case cannot settle it. */
const MANY = /(?<![\p{L}-])(most|mostly|usually|often|typically|generally|largely|mainly|many|few|several|sometimes|rarely|on average|tend to|tends to)(?![\p{L}-])/iu;

const short = (text: string): string => (text.length > 90 ? `${text.slice(0, 87)}...` : text);

/** What the tests on each claim say, as warnings. None of these changes a status; the engine does that from the same records. */
export function predictionIssues(arg: Argument): Issue[] {
  const issues: Issue[] = [];
  const warn = (code: string, message: string, id: string): void => {
    issues.push({ severity: 'warning', code, message, claims: [id] });
  };
  for (const claim of arg.claims.values()) {
    if (claim.predictions.length === 0) continue;
    const rev = claimRev(claim);
    const backers = vouchers(claim);
    claim.predictions.forEach((p, i) => {
      if (!isCurrent(claim, p, rev)) return;
      const name = `"${claim.id}", test ${i + 1} ("${short(p.says)}")`;
      if (knocks(claim, p, rev)) {
        warn('test-failed', `${name} failed${p.found !== undefined ? `: ${p.found} of ${p.sample}, with ${p.needs} needed` : ''}. The claim was vouched to pass it, so it has fallen. Reword it to what was found, or let it fall.`, claim.id);
      } else if (p.outcome === 'no') {
        warn(
          'test-against',
          `${name} failed. It counts as evidence against the claim and not as a refutation, because ${p.accepted.length === 0 ? 'nobody who vouches for the claim accepted the test' : `the claim was not taken to imply it (if_true is ${p.ifTrue})`}.`,
          claim.id,
        );
      }
      if (blocks(claim, p, rev)) warn('test-overdue', `${name} was due on ${p.due} and has no outcome. The claim cannot stand until someone records what was found.`, claim.id);
      if (p.outcome !== undefined) return;
      if (p.ifTrue >= IMPLIES && p.accepted.length === 0) {
        warn(
          'test-unvouched',
          backers.length === 0
            ? `${name}: nobody vouches for "${claim.id}", so no test can knock it out. Whoever stands behind it should confirm it in a review, or be named on its trust label.`
            : `${name} is waiting for ${backers.join(' or ')} to accept it. Until then a failure counts only as evidence against.`,
          claim.id,
        );
      }
      const bits = severity(p);
      if (bits === undefined) {
        warn('test-soft', `${name} does not say how likely a yes would be if the claim were false (if_false), so nobody can tell how hard a test it is.`, claim.id);
      } else if (p.ifTrue / (p.ifFalse as number) < SOFT_RATIO) {
        warn('test-soft', `${name} is a soft test: a yes is almost as likely with the claim false (${p.ifFalse}) as with it true (${p.ifTrue}), so passing it shows little.`, claim.id);
      }
      if (p.ifFalse !== undefined && (p.p < Math.min(p.ifFalse, p.ifTrue) - 1e-9 || p.p > Math.max(p.ifFalse, p.ifTrue) + 1e-9)) {
        warn('test-inconsistent', `${name}: the chance of a yes (${p.p}) must lie between the chance if the claim is false (${p.ifFalse}) and if it is true (${p.ifTrue}).`, claim.id);
      }
      const credence = impliedCredence(p);
      const trust = claim.bet?.trust;
      if (credence !== undefined && credence < 0.5 && (trust === 'observed' || trust === 'corroborated') && backers.includes(p.by)) {
        warn(
          'credence-label',
          `${name}: ${p.by} labels "${claim.id}" ${trust}, but these numbers imply a belief of about ${Math.round(credence * 100)}% that it is true. Lower the trust, or revisit the numbers.`,
          claim.id,
        );
      }
      if ((p.sample ?? 1) === 1 && MANY.test(plainText(claim.text))) {
        warn('test-one-case', `${name} looks at one case, but "${claim.id}" is about many. Fix a sample and how many must agree before looking.`, claim.id);
      }
    });
  }
  return issues;
}
