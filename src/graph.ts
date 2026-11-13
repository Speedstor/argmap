import type { Argument, Issue } from './types.ts';

/** Every claim that `id` rests on, directly or through other claims. */
export function supportersClosure(arg: Argument, id: string): string[] {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const claim = arg.claims.get(current);
    if (!claim) continue;
    for (const group of claim.because) {
      for (const member of group) {
        if (member !== id && !seen.has(member)) {
          seen.add(member);
          stack.push(member);
        }
      }
    }
  }
  return [...seen];
}

export function attackersOf(arg: Argument): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const { from, to } of arg.attacks) {
    const list = map.get(to) ?? [];
    list.push(from);
    map.set(to, list);
  }
  return map;
}

export type Side = 'for' | 'against' | 'both' | 'none';

/**
 * Which way each claim pushes on the conclusion. Support keeps the direction;
 * an attack flips it. A claim reachable both ways is "both"; one with no path is "none".
 */
export function sides(arg: Argument): Map<string, Side> {
  const attackers = attackersOf(arg);
  const reached = new Map<string, Set<0 | 1>>();
  const queue: [string, 0 | 1][] = [];
  if (arg.claims.has(arg.conclusion)) queue.push([arg.conclusion, 0]);
  while (queue.length > 0) {
    const [id, parity] = queue.shift() as [string, 0 | 1];
    const set = reached.get(id) ?? new Set<0 | 1>();
    if (set.has(parity)) continue;
    set.add(parity);
    reached.set(id, set);
    const claim = arg.claims.get(id);
    if (!claim) continue;
    for (const group of claim.because) for (const member of group) queue.push([member, parity]);
    for (const attacker of attackers.get(id) ?? []) queue.push([attacker, parity === 0 ? 1 : 0]);
  }
  const out = new Map<string, Side>();
  for (const id of arg.claims.keys()) {
    const set = reached.get(id);
    if (!set) out.set(id, 'none');
    else if (set.size === 2) out.set(id, 'both');
    else out.set(id, set.has(0) ? 'for' : 'against');
  }
  return out;
}

/** Circular support and claims with no bearing on the conclusion. */
export function structureIssues(arg: Argument): Issue[] {
  const issues: Issue[] = [];

  // Circular support: the second horn of Agrippa's trilemma.
  const state = new Map<string, 'open' | 'done'>();
  const reported = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): void => {
    state.set(id, 'open');
    path.push(id);
    const claim = arg.claims.get(id);
    for (const group of claim?.because ?? []) {
      for (const member of group) {
        if (!arg.claims.has(member)) continue;
        const s = state.get(member);
        if (s === 'open') {
          const cycle = path.slice(path.indexOf(member));
          const key = [...cycle].sort().join('\u0000');
          if (!reported.has(key)) {
            reported.add(key);
            issues.push({
              severity: 'warning',
              code: 'circular-support',
              message: `Circular support: ${[...cycle, member].join(' → ')}. Each of these rests on the others, so none of them is grounded in a bet.`,
              claims: cycle,
            });
          }
        } else if (s === undefined) {
          visit(member);
        }
      }
    }
    path.pop();
    state.set(id, 'done');
  };
  for (const id of arg.claims.keys()) if (!state.has(id)) visit(id);

  if (arg.conclusion !== '') {
    const side = sides(arg);
    for (const id of arg.claims.keys()) {
      if (side.get(id) === 'none') {
        issues.push({
          severity: 'warning',
          code: 'orphan',
          message: `"${id}" neither supports nor opposes anything that leads to the conclusion.`,
          claims: [id],
        });
      }
    }
  }
  return issues;
}
