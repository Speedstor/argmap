import { evaluate, reason } from './evaluate.ts';
import type { Statuses } from './evaluate.ts';
import { sides } from './graph.ts';
import type { Side } from './graph.ts';
import type { Argument, Cost, Status, Trust } from './types.ts';

const SHAKINESS: Record<Trust, number> = { observed: 1, corroborated: 2, 'track-record': 3, assumed: 4 };
const COST_WEIGHT: Record<Cost, number> = { low: 1, medium: 2, high: 3 };

export interface Change {
  id: string;
  from: Status;
  to: Status;
}

export interface BetReport {
  id: string;
  trust: Trust;
  cost: Cost;
  side: Side;
  /** The bet's own status right now. */
  status: Status;
  /** What the conclusion becomes if this bet alone fails. */
  conclusionIfFails: Status;
  /** True when this bet failing is enough, by itself, to change the conclusion. */
  decisive: boolean;
  /** Other claims whose status changes when this bet fails. */
  alsoChanges: number;
}

export interface Crux {
  a: string;
  b: string;
  /** Conclusion if `a` wins the dispute (that is, `b` no longer counts against it), and the reverse. */
  ifAPrevails: Status;
  ifBPrevails: Status;
}

export interface CruxSummary {
  cruxes: Crux[];
  /** How the conclusion comes out across every way of settling the open disputes. Absent when there are too many to enumerate. */
  tally?: Record<Status, number> & { total: number };
  /** Sides that win in every settlement where the conclusion stands. Empty if it never stands. */
  standsOnlyIf: string[];
}

export interface Analysis {
  statuses: Statuses;
  conclusion: Status;
  sides: Map<string, Side>;
  bets: BetReport[];
  cruxes: CruxSummary;
}

/** What changes when the given claims are knocked out on top of those already knocked. */
export function knockOut(
  arg: Argument,
  knocked: ReadonlySet<string>,
  ids: readonly string[],
): { statuses: Statuses; changes: Change[] } {
  const before = evaluate(arg, knocked);
  const after = evaluate(arg, new Set([...knocked, ...ids]));
  const changes: Change[] = [];
  for (const [id, from] of before) {
    const to = after.get(id) as Status;
    if (to !== from) changes.push({ id, from, to });
  }
  return { statuses: after, changes };
}

/** Bets ordered by exposure: decisive first, then shakiest, then costliest, then widest reach. */
export function betReports(arg: Argument, knocked: ReadonlySet<string>, base: Statuses, side: Map<string, Side>): BetReport[] {
  const conclusionNow = base.get(arg.conclusion) as Status;
  const reports: BetReport[] = [];
  for (const claim of arg.claims.values()) {
    if (!claim.bet) continue;
    const { statuses, changes } = knockOut(arg, knocked, [claim.id]);
    const conclusionIfFails = statuses.get(arg.conclusion) as Status;
    reports.push({
      id: claim.id,
      trust: claim.bet.trust,
      cost: claim.bet.cost,
      side: side.get(claim.id) ?? 'none',
      status: base.get(claim.id) as Status,
      conclusionIfFails,
      decisive: !knocked.has(claim.id) && conclusionIfFails !== conclusionNow,
      alsoChanges: changes.filter((c) => c.id !== claim.id && c.id !== arg.conclusion).length,
    });
  }
  return reports.sort(
    (x, y) =>
      Number(y.decisive) - Number(x.decisive) ||
      SHAKINESS[y.trust] - SHAKINESS[x.trust] ||
      COST_WEIGHT[y.cost] - COST_WEIGHT[x.cost] ||
      y.alsoChanges - x.alsoChanges,
  );
}

/**
 * Settle disputes: each outcome is [winner, loser]. The loser's attack on the
 * winner is dropped, so the dispute becomes a one-way attack. The loser is not
 * removed: if the winner later falls for another reason, nothing is left
 * opposing the loser and it stands again.
 */
export function settle(arg: Argument, outcomes: readonly (readonly [string, string])[]): Argument {
  if (outcomes.length === 0) return arg;
  const dropped = new Set(outcomes.map(([winner, loser]) => `${loser}\u0000${winner}`));
  const settled = (a: string, b: string): boolean => outcomes.some(([w, l]) => (w === a && l === b) || (w === b && l === a));
  return {
    ...arg,
    attacks: arg.attacks.filter((x) => !dropped.has(`${x.from}\u0000${x.to}`)),
    disputes: arg.disputes.filter(([a, b]) => !settled(a, b)),
  };
}

const MAX_ENUMERATED_CRUXES = 10;

/**
 * The open disputes the conclusion hinges on, and how it comes out
 * under each way of settling them.
 */
export function cruxSummary(arg: Argument, knocked: ReadonlySet<string>, base: Statuses): CruxSummary {
  const open = arg.disputes.filter(([a, b]) => base.get(a) === 'contested' && base.get(b) === 'contested');
  const conclusionWith = (outcomes: [string, string][]): Status =>
    evaluate(settle(arg, outcomes), knocked).get(arg.conclusion) as Status;

  const cruxes: Crux[] = open.map(([a, b]) => ({
    a,
    b,
    ifAPrevails: conclusionWith([[a, b]]),
    ifBPrevails: conclusionWith([[b, a]]),
  }));
  const summary: CruxSummary = { cruxes, standsOnlyIf: [] };
  if (open.length === 0 || open.length > MAX_ENUMERATED_CRUXES) return summary;

  const tally = { stands: 0, falls: 0, contested: 0, total: 1 << open.length };
  let common: Set<string> | undefined;
  for (let mask = 0; mask < tally.total; mask++) {
    const winners: string[] = [];
    const outcomes: [string, string][] = [];
    open.forEach(([a, b], i) => {
      const aWins = (mask & (1 << i)) === 0;
      winners.push(aWins ? a : b);
      outcomes.push(aWins ? [a, b] : [b, a]);
    });
    const outcome = conclusionWith(outcomes);
    tally[outcome]++;
    if (outcome === 'stands') {
      const current: Set<string> = common ?? new Set(winners);
      common = new Set(winners.filter((w) => current.has(w)));
    }
  }
  summary.tally = tally;
  summary.standsOnlyIf = common ? [...common] : [];
  return summary;
}

/** Everything the report and the viewer need, for a given set of knocked-out claims. */
export function analyze(arg: Argument, knocked: ReadonlySet<string> = new Set()): Analysis {
  const statuses = evaluate(arg, knocked);
  const side = sides(arg);
  return {
    statuses,
    conclusion: statuses.get(arg.conclusion) as Status,
    sides: side,
    bets: betReports(arg, knocked, statuses, side),
    cruxes: cruxSummary(arg, knocked, statuses),
  };
}

export { reason };
