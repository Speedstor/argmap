import type { Argument, Claim, Issue } from './types.ts';

/** How many independent sources stand behind a claim. Records that share an origin, or a source, count once. */
export function independentSources(claim: Claim): number {
  const seen = new Set<string>();
  let anonymous = 0;
  for (const e of claim.evidence) {
    if (e.stance !== 'for') continue;
    const key = (e.origin ?? e.source ?? '').trim().toLowerCase();
    if (key === '') anonymous++;
    else seen.add(key);
  }
  // Evidence with no source or origin cannot be told apart, so together it counts once.
  return seen.size + (anonymous > 0 ? 1 : 0);
}

/**
 * Where a bet's typed trust label and its attached evidence disagree. The label
 * is never computed from the evidence, because a rule that sets the label is a
 * rule that can be gamed. These warnings only point out the gap for a reviewer.
 */
export function evidenceIssues(arg: Argument): Issue[] {
  const issues: Issue[] = [];
  const warn = (code: string, message: string, id: string): void => {
    issues.push({ severity: 'warning', code, message, claims: [id] });
  };
  for (const claim of arg.claims.values()) {
    for (const e of claim.evidence) {
      if (e.kind === 'account' ? !e.witness && !e.source : !e.source) {
        warn(
          'evidence-unsourced',
          `"${claim.id}" has ${e.kind === 'account' ? 'an account with no witness named' : `a ${e.kind} with no source`}, so nobody can look it up.`,
          claim.id,
        );
      }
    }
    if (!claim.bet) continue;
    const trust = claim.bet.trust;
    const supporting = claim.evidence.filter((e) => e.stance === 'for');
    const independent = independentSources(claim);
    if (trust === 'corroborated' && independent < 2) {
      warn(
        'trust-unbacked',
        `"${claim.id}" is labelled corroborated, which means independent sources agree, but ${independent === 0 ? 'no evidence is' : 'only one independent source is'} attached. Attach the sources or lower the trust.`,
        claim.id,
      );
    } else if (trust === 'observed' && !supporting.some((e) => e.kind === 'account' && e.firstHand === true)) {
      warn(
        'trust-unbacked',
        `"${claim.id}" is labelled observed, but no first-hand account is attached. Record who saw it, or lower the trust.`,
        claim.id,
      );
    } else if (trust === 'track-record' && supporting.length === 0) {
      warn(
        'trust-unbacked',
        `"${claim.id}" is labelled track-record, but no evidence is attached. Attach the source it relies on, or mark it assumed.`,
        claim.id,
      );
    }
    const against = claim.evidence.filter((e) => e.stance === 'against');
    if (against.length > 0 && trust !== 'assumed') {
      warn(
        'evidence-against',
        `"${claim.id}" is labelled ${trust} but has evidence against it: ${against.map((e) => e.says).join(' ')} Say why it still holds, or lower the trust.`,
        claim.id,
      );
    }
  }
  return issues;
}
