import { evidenceIssues } from './evidence.ts';
import { structureIssues } from './graph.ts';
import { parseArgument } from './parse.ts';
import type { LibrarySource } from './parse.ts';
import { termIssues } from './terms.ts';
import type { Argument, Issue } from './types.ts';

export * from './types.ts';
export { parseArgument, parseFile, assemble, prettyLabel } from './parse.ts';
export type { LibrarySource, RawFile } from './parse.ts';
export { claimRev, reviewSummary, reviewSummaries } from './review.ts';
export type { ReviewState, ReviewSummary } from './review.ts';
export { lintClaim, resolution } from './lint.ts';
export type { Flag, Resolution } from './lint.ts';
export { nextSteps } from './next.ts';
export type { Step, StepKind } from './next.ts';
export { toYaml, evidenceToYaml } from './serialize.ts';
export { evidenceIssues, independentSources } from './evidence.ts';
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

/** Read an argument file, with any library files it may draw claims from, and run every check on it. */
export function load(source: string, library: LibrarySource[] = []): Loaded {
  const { argument, issues } = parseArgument(source, library);
  const all = [...issues];
  if (argument) {
    all.push(...termIssues(argument));
    if (!all.some((i) => i.severity === 'error')) all.push(...structureIssues(argument), ...evidenceIssues(argument));
  }
  const ok = argument !== undefined && !all.some((i) => i.severity === 'error');
  return argument ? { argument, issues: all, ok } : { issues: all, ok };
}
