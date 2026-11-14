import { attackersOf } from './graph.ts';
import { blocks, knocks, testVerdicts } from './predict.ts';
import type { Argument, Status } from './types.ts';

export type Statuses = Map<string, Status>;

/**
 * Label every claim as standing, fallen or contested.
 *
 * A bet stands unless it is knocked out or defeated. A supported claim stands
 * when one whole line of support stands and every attacker has fallen. A claim
 * falls when an attacker stands or when every line of support has a fallen
 * member. Anything that cannot be settled either way is contested: two claims
 * that attack each other, a circle of support, or whatever depends on those.
 *
 * This is the grounded labelling from abstract argumentation, extended with
 * support. It starts with everything contested and only ever settles a claim
 * when the rules force it, so the result does not depend on the order of claims.
 */
export function evaluate(arg: Argument, knocked: ReadonlySet<string> = new Set()): Statuses {
  const attackers = attackersOf(arg);
  // A failed test the claim was vouched to pass knocks it out, the same way a person knocking it out does.
  // An accepted test that is overdue holds the claim back: it may fall, and it may not stand.
  const { fallen, held } = testVerdicts(arg);
  const status: Statuses = new Map();
  for (const id of arg.claims.keys()) status.set(id, knocked.has(id) || fallen.has(id) ? 'falls' : 'contested');

  let changed = true;
  while (changed) {
    changed = false;
    for (const claim of arg.claims.values()) {
      if (status.get(claim.id) !== 'contested') continue;
      const against = attackers.get(claim.id) ?? [];
      const defeated = against.some((a) => status.get(a) === 'stands');
      const unopposed = against.every((a) => status.get(a) === 'falls');
      const leaf = claim.because.length === 0;
      const supported = leaf || claim.because.some((group) => group.every((m) => status.get(m) === 'stands'));
      const unsupported = !leaf && claim.because.every((group) => group.some((m) => status.get(m) === 'falls'));
      if (defeated || unsupported) {
        status.set(claim.id, 'falls');
        changed = true;
      } else if (supported && unopposed && !held.has(claim.id)) {
        status.set(claim.id, 'stands');
        changed = true;
      }
    }
  }
  return status;
}

/** One sentence on why a claim has the status it has. */
export function reason(arg: Argument, statuses: Statuses, knocked: ReadonlySet<string>, id: string): string {
  const claim = arg.claims.get(id);
  const status = statuses.get(id);
  if (!claim || !status) return '';
  const against = attackersOf(arg).get(id) ?? [];
  const list = (ids: string[]): string => ids.map((x) => `"${arg.claims.get(x)?.label ?? x}"`).join(', ');

  if (knocked.has(id)) return 'You knocked this out.';
  const failed = claim.predictions.find((p) => knocks(claim, p));
  if (failed) return `Failed a test it was vouched to pass: "${failed.says}"${failed.found !== undefined ? ` (${failed.found} of ${failed.sample}, with ${failed.needs} needed)` : ''}.`;
  if (status === 'falls') {
    const winners = against.filter((a) => statuses.get(a) === 'stands');
    if (winners.length > 0) return `Defeated by ${list(winners)}, which stands.`;
    const missing = claim.because.map((group) => group.find((m) => statuses.get(m) === 'falls')).filter((m): m is string => !!m);
    return `No line of support is left: ${list([...new Set(missing)])} fell.`;
  }
  if (status === 'contested') {
    const open = against.filter((a) => statuses.get(a) === 'contested');
    const shaky = [...new Set(claim.because.flat().filter((m) => statuses.get(m) === 'contested'))];
    const parts: string[] = [];
    const late = claim.predictions.find((p) => blocks(claim, p));
    if (late) parts.push(`a test of it was due on ${late.due} and has no outcome`);
    const unsettled = (ids: string[]): string => `${list(ids)}, which ${ids.length > 1 ? 'are' : 'is'} not settled`;
    if (open.length > 0) parts.push(`opposed by ${unsettled(open)}`);
    if (shaky.length > 0) parts.push(`rests on ${unsettled(shaky)}`);
    return parts.length > 0 ? `Contested: ${parts.join('; ')}.` : 'Contested.';
  }
  if (claim.because.length === 0) {
    const fallen = against.length > 0 ? ' Every objection to it has fallen.' : '';
    return `Held as a bet (${claim.bet?.trust ?? 'assumed'}).${fallen}`;
  }
  const line = claim.because.find((group) => group.every((m) => statuses.get(m) === 'stands')) ?? [];
  const spare = claim.because.filter((group) => group.every((m) => statuses.get(m) === 'stands')).length - 1;
  return `Supported by ${list(line)}${spare > 0 ? `, with ${spare} other line${spare > 1 ? 's' : ''} of support standing` : ''}.`;
}
