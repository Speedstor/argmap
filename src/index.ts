import { structureIssues } from './graph.ts';
import { parseArgument } from './parse.ts';
import { termIssues } from './terms.ts';
import type { Argument, Issue } from './types.ts';

export * from './types.ts';
export { parseArgument, prettyLabel } from './parse.ts';
export { evaluate, reason } from './evaluate.ts';
export type { Statuses } from './evaluate.ts';
export { analyze, knockOut, betReports, cruxSummary } from './analyze.ts';
export type { Analysis, BetReport, Change, Crux, CruxSummary } from './analyze.ts';
export { sides, structureIssues, supportersClosure, attackersOf } from './graph.ts';
export type { Side } from './graph.ts';
export { segments, plainText, termKeys, termIssues } from './terms.ts';
export type { Segment } from './terms.ts';

export interface Loaded {
  /** Present whenever the file could be read, even if it has errors. */
  argument?: Argument;
  issues: Issue[];
  /** True when there are no errors, so the argument can be evaluated. */
  ok: boolean;
}

/** Read an argument file and run every check on it. */
export function load(source: string): Loaded {
  const { argument, issues } = parseArgument(source);
  const all = [...issues];
  if (argument) {
    all.push(...termIssues(argument));
    if (!all.some((i) => i.severity === 'error')) all.push(...structureIssues(argument));
  }
  const ok = argument !== undefined && !all.some((i) => i.severity === 'error');
  return argument ? { argument, issues: all, ok } : { issues: all, ok };
}
