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
  return prediction.rev === rev;
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
 * Could a failure of this test knock its claim out? Only when the claim was
 * taken to imply a yes, and someone who vouches for the claim agreed to that
 * before the outcome. A pass counts for the claim only where this holds: a
 * test that could not have hurt shows nothing by passing.
 */
export function couldKnock(prediction: Prediction): boolean {
  return prediction.ifTrue >= IMPLIES && prediction.accepted.length > 0;
}

/** A failed test knocks the claim out when it could (see couldKnock) and it tested the present wording. Anything less is evidence against. */
export function knocks(claim: Claim, prediction: Prediction, rev = claimRev(claim)): boolean {
  return prediction.outcome === 'no' && couldKnock(prediction) && isCurrent(claim, prediction, rev);
}

/**
 * An accepted test that is marked overdue and still open: the claim cannot
 * stand until someone records what was found. This holds whatever the claim's
 * wording is now, so rewording is not a way out of a test that is pending.
 */
export function blocks(_claim: Claim, prediction: Prediction): boolean {
  return prediction.outcome === undefined && prediction.overdue?.date !== undefined && prediction.overdue.date > prediction.due && prediction.accepted.length > 0;
}

/** Claims the tests have settled: fallen because a test failed, or held back because one is overdue. */
export function testVerdicts(arg: Argument): { fallen: Set<string>; held: Set<string> } {
  const fallen = new Set<string>();
  const held = new Set<string>();
  for (const claim of arg.claims.values()) {
    if (claim.predictions.length === 0) continue;
    const rev = claimRev(claim);
    if (claim.predictions.some((p) => knocks(claim, p, rev))) fallen.add(claim.id);
    else if (claim.predictions.some((p) => blocks(claim, p))) held.add(claim.id);
  }
  return { fallen, held };
}

/**
 * What a claim has been through. A pass is counted only where a failure would
 * have knocked the claim out, and the hardness of a test is kept apart by who
 * typed it: the claim's own vouchers, or someone else.
 */
export interface ClaimRecord {
  /** Tests of the present wording that are waiting for an outcome. */
  open: number;
  /** Passed tests that would have knocked the claim out had they failed. */
  passed: number;
  /** Of those, how many were set by someone who was not vouching for the claim. */
  passedFromOthers: number;
  /** Passed tests that could not have knocked the claim out. They show nothing, and are counted so that is visible. */
  passedNoRisk: number;
  failed: number;
  /** The hardness of the passed tests, in bits, as typed by the claim's own vouchers, and as typed by others. */
  bitsOwn: number;
  bitsOthers: number;
  /** Tests set by someone who was not vouching for the claim, and how many of those a voucher accepted. */
  offered: number;
  offeredAccepted: number;
  /** Tests withdrawn after someone who vouches for the claim had accepted them. */
  withdrawn: number;
  /** Tests that failed under an earlier wording: how often the claim was reworded after failing. */
  failedEarlier: number;
}

export function claimRecord(claim: Claim): ClaimRecord {
  const rev = claimRev(claim);
  const record: ClaimRecord = { open: 0, passed: 0, passedFromOthers: 0, passedNoRisk: 0, failed: 0, bitsOwn: 0, bitsOthers: 0, offered: 0, offeredAccepted: 0, withdrawn: 0, failedEarlier: 0 };
  for (const p of claim.predictions) {
    if (p.outcome === 'void' && p.accepted.length > 0) record.withdrawn++;
    if (!isCurrent(claim, p, rev)) {
      if (p.outcome === 'no') record.failedEarlier++;
      continue;
    }
    // Whether the setter was vouching is read off the acceptances, which are fixed, and not off who vouches today.
    const own = p.accepted.some((a) => a.by === p.by);
    if (!own) {
      record.offered++;
      if (p.accepted.length > 0) record.offeredAccepted++;
    }
    if (p.outcome === undefined) record.open++;
    else if (p.outcome === 'no') record.failed++;
    else if (p.outcome === 'yes' && !couldKnock(p)) record.passedNoRisk++;
    else if (p.outcome === 'yes') {
      record.passed++;
      const bits = severity(p) ?? 0;
      if (own) record.bitsOwn += bits;
      else {
        record.bitsOthers += bits;
        record.passedFromOthers++;
      }
    }
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
      const name = `"${claim.id}", test ${i + 1} ("${short(p.says)}")`;
      if (!isCurrent(claim, p, rev)) {
        // A pending test follows the claim through a reword.
        if (blocks(claim, p)) warn('test-overdue', `${name} was due on ${p.due} and has no outcome. The claim was reworded since, and still cannot stand until someone records what was found.`, claim.id);
        return;
      }
      if (knocks(claim, p, rev)) {
        warn('test-failed', `${name} failed${p.found !== undefined ? `: ${p.found} of ${p.sample}, with ${p.needs} needed` : ''}. The claim was vouched to pass it, so it has fallen. Reword it to what was found, or let it fall.`, claim.id);
      } else if (p.outcome === 'no') {
        warn(
          'test-against',
          `${name} failed. It counts as evidence against the claim and not as a refutation, because ${p.accepted.length === 0 ? 'nobody who vouches for the claim accepted the test' : `the claim was not taken to imply it (if_true is ${p.ifTrue})`}.`,
          claim.id,
        );
      }
      if (p.outcome === 'void' && p.accepted.length > 0) warn('test-withdrawn', `${name} was withdrawn after ${p.accepted.map((a) => a.by).join(' and ')} had accepted it${p.note ? `: ${p.note}` : ''}. It is counted on the claim's record and on ${p.by}'s.`, claim.id);
      if (blocks(claim, p)) warn('test-overdue', `${name} was due on ${p.due} and has no outcome. The claim cannot stand until someone records what was found.`, claim.id);
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

/** How far the bets have been put to a test: of the bets, how many have a test of their present wording, and how those stand. */
export interface Testability {
  bets: number;
  /** Bets nobody vouches for. No test can knock these out, so a test of one shows little until someone puts a name to it. */
  unvouched: number;
  tested: number;
  open: number;
  passed: number;
  failed: number;
}

export function testability(arg: Argument): Testability {
  const out: Testability = { bets: 0, unvouched: 0, tested: 0, open: 0, passed: 0, failed: 0 };
  for (const claim of arg.claims.values()) {
    const rev = claimRev(claim);
    const current = claim.predictions.filter((p) => isCurrent(claim, p, rev));
    if (claim.bet) {
      out.bets++;
      if (vouchers(claim).length === 0) out.unvouched++;
      if (current.length > 0) out.tested++;
    }
    for (const p of current) {
      if (p.outcome === undefined) out.open++;
      else if (p.outcome === 'yes') out.passed++;
      else if (p.outcome === 'no') out.failed++;
    }
  }
  return out;
}

/** One line on a test, for a report or a digest. */
export function describeTest(claim: Claim, p: Prediction, n: number): string {
  const state = p.outcome === 'yes' ? (couldKnock(p) ? 'passed' : 'passed, though a failure could not have knocked the claim out') : p.outcome === 'no' ? (knocks(claim, p) ? 'failed, and knocked the claim out' : 'failed, counted as evidence against') : p.outcome === 'void' ? 'withdrawn' : blocks(claim, p) ? 'overdue, holding the claim back' : p.overdue ? 'overdue' : 'open';
  const bits = severity(p);
  const parts = [
    `test ${n}, ${p.type}, ${state}${isCurrent(claim, p) ? '' : ' (on an earlier wording)'}: ${p.says}`,
    `set by ${p.by} (${p.kind}) on ${p.made} at ${Math.round(p.p * 100)}%`,
    bits === undefined ? 'hardness not given' : `hardness ${bits.toFixed(1)} bits (if true ${p.ifTrue}, if false ${p.ifFalse})`,
    p.sample !== undefined ? `sample ${p.sample}, needs ${p.needs}${p.found !== undefined ? `, found ${p.found}` : ''}` : '',
    p.accepted.length > 0 ? `accepted by ${p.accepted.map((a) => a.by).join(', ')}` : 'accepted by nobody who vouches for the claim',
    p.outcome === undefined ? `due ${p.due}` : `recorded by ${p.resolvedBy}${p.resolved ? ` on ${p.resolved}` : ''}`,
    p.confirmed.length > 0 ? `confirmed by ${p.confirmed.map((c) => c.by).join(', ')}` : '',
    p.source ? `source: ${p.source}` : '',
    p.note ? `note: ${p.note}` : '',
  ];
  return parts.filter((x) => x !== '').join(' | ');
}
