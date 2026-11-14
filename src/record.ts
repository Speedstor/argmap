import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { parseFile, pinClaims } from './parse.ts';
import { isCurrent, severity } from './predict.ts';
import type { Prediction, ReviewerKind } from './types.ts';
import { argumentFiles, libraryFiles } from './workspace.ts';

/** One prediction, with where it is recorded. Each is counted once, in the file that defines its claim. */
export interface Entry {
  file: string;
  claim: string;
  /** Its number on the claim, counted from 1. */
  n: number;
  prediction: Prediction;
  /** False when the claim has been reworded since. */
  current: boolean;
}

/** Every prediction in the workspace: all argument files and the claims library. */
export function allPredictions(root: string): Entry[] {
  const out: Entry[] = [];
  const read = (path: string): ReturnType<typeof parseFile> => parseFile(readFileSync(path, 'utf8'), relative(root, path).split(sep).join('/'));
  const library = libraryFiles(root).map(read);
  // A claim's fingerprint takes in the definitions of the terms it pins, wherever they are defined.
  const shared = new Map(library.flatMap((file) => [...file.terms]));
  for (const raw of [...argumentFiles(root).map(read), ...library]) {
    const file = raw.name;
    pinClaims(raw.claims.values(), new Map([...shared, ...raw.terms]));
    for (const claim of raw.claims.values()) {
      claim.predictions.forEach((prediction, i) => out.push({ file, claim: claim.id, n: i + 1, prediction, current: isCurrent(claim, prediction) }));
    }
  }
  return out;
}

/** A score is not shown on fewer resolved predictions than this, and the calibration table needs twice as many. */
export const MIN_SCORED = 10;

const DAY = 24 * 60 * 60 * 1000;
const days = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / DAY);

export const BUCKETS = ['Lookups', 'Forecasts resolved within 30 days', 'Forecasts, 30 days to a year', 'Forecasts, over a year'] as const;
export type BucketName = (typeof BUCKETS)[number];

/**
 * Which part of a record a prediction belongs to. Skill at finding answers that
 * already exist says little about skill at long-range bets, so the two are
 * never pooled. A forecast is placed by how long it actually took to resolve,
 * or while it is open, by how long it was given.
 */
export function bucketOf(p: Prediction): BucketName {
  if (p.type === 'lookup') return BUCKETS[0];
  const horizon = days(p.made, p.resolved ?? p.due);
  return horizon < 30 ? BUCKETS[1] : horizon <= 365 ? BUCKETS[2] : BUCKETS[3];
}

export interface CalibrationRow {
  /** The chances this row covers, e.g. "60% to 80%". */
  range: string;
  count: number;
  /** The average chance given, and the share that came out yes. */
  said: number;
  cameTrue: number;
}

export interface Bucket {
  name: BucketName;
  /** Resolved yes or no. */
  scored: number;
  open: number;
  /** Mean squared gap between the chance given and what happened. 0 is perfect; always saying 50% gets 0.25. */
  brier?: number;
  /** The Brier score if every open and every withdrawn prediction went against the setter. Abandoning or withdrawing one does not hide it. */
  worst?: number;
  calibration?: CalibrationRow[];
}

export interface NameRecord {
  name: string;
  kind: ReviewerKind;
  set: number;
  buckets: Bucket[];
  withdrawn: number;
  /** Marked overdue by someone and still without an outcome. */
  overdue: number;
  /** Of this name's resolved predictions: recorded by the setter, by someone else, and confirmed by a second name. */
  resolvedBySelf: number;
  resolvedByOthers: number;
  confirmed: number;
  /** Of those confirmed, how many by a person. */
  confirmedByPerson: number;
  /** The average hardness of the tests set, in bits, over those that give if_false; and how many do not. */
  bits?: number;
  noIfFalse: number;
}

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;

function scoreBucket(name: BucketName, list: Prediction[]): Bucket {
  const scored = list.filter((p) => p.outcome === 'yes' || p.outcome === 'no');
  const open = list.filter((p) => p.outcome === undefined);
  const pending = list.filter((p) => p.outcome === undefined || p.outcome === 'void');
  const bucket: Bucket = { name, scored: scored.length, open: open.length };
  if (scored.length < MIN_SCORED) return bucket;
  const hit = (p: Prediction): number => (p.outcome === 'yes' ? 1 : 0);
  const errors = scored.map((p) => (p.p - hit(p)) ** 2);
  bucket.brier = mean(errors);
  if (pending.length > 0) bucket.worst = mean([...errors, ...pending.map((p) => Math.max(p.p, 1 - p.p) ** 2)]);
  if (scored.length >= MIN_SCORED * 2) {
    bucket.calibration = [];
    for (let low = 0; low < 100; low += 20) {
      const rows = scored.filter((p) => p.p * 100 >= low && (p.p * 100 < low + 20 || low === 80));
      if (rows.length === 0) continue;
      bucket.calibration.push({ range: `${low}% to ${low + 20}%`, count: rows.length, said: mean(rows.map((p) => p.p)), cameTrue: mean(rows.map(hit)) });
    }
  }
  return bucket;
}

/**
 * What each name has on record, by name. Nothing here is rolled into a single
 * number, and nothing sets a trust label. There is no skill score: any score
 * worked out from questions the setter picked can be padded with sure things,
 * a yes and a no in equal number.
 */
export function records(entries: Entry[]): NameRecord[] {
  const byName = new Map<string, Prediction[]>();
  for (const { prediction } of entries) byName.set(prediction.by, [...(byName.get(prediction.by) ?? []), prediction]);
  const out: NameRecord[] = [];
  for (const [name, list] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    const resolved = list.filter((p) => p.outcome === 'yes' || p.outcome === 'no');
    const hard = list.map(severity).filter((b): b is number => b !== undefined);
    const record: NameRecord = {
      name,
      kind: (list[list.length - 1] as Prediction).kind,
      set: list.length,
      buckets: BUCKETS.map((bucket) => scoreBucket(bucket, list.filter((p) => bucketOf(p) === bucket))),
      withdrawn: list.filter((p) => p.outcome === 'void').length,
      overdue: list.filter((p) => p.outcome === undefined && p.overdue).length,
      resolvedBySelf: resolved.filter((p) => p.resolvedBy === name).length,
      resolvedByOthers: resolved.filter((p) => p.resolvedBy !== name).length,
      confirmed: resolved.filter((p) => p.confirmed.length > 0).length,
      confirmedByPerson: resolved.filter((p) => p.confirmed.some((c) => c.kind === 'person')).length,
      noIfFalse: list.length - hard.length,
    };
    if (hard.length > 0) record.bits = mean(hard);
    out.push(record);
  }
  return out;
}

const round = (n: number): string => n.toFixed(2);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function formatRecord(record: NameRecord): string {
  const out: string[] = [
    `${record.name} (${record.kind === 'ai' ? 'AI' : 'person'}): ${plural(record.set, 'prediction')} set`,
    '  These are questions the setter chose. A good score can come from choosing easy ones, so read it next to how hard the tests were.',
  ];
  for (const b of record.buckets) {
    if (b.scored + b.open === 0) {
      out.push(`  ${b.name}: no record.`);
      continue;
    }
    out.push(`  ${b.name}: ${b.scored} resolved, ${b.open} open.`);
    if (b.brier === undefined) {
      out.push(`      Too few to score: a score needs ${MIN_SCORED} resolved.`);
      continue;
    }
    out.push(`      Brier score ${round(b.brier)}. 0 is perfect, and always saying 50% gets 0.25.`);
    if (b.worst !== undefined) out.push(`      If every open or withdrawn prediction went against them: Brier score ${round(b.worst)}.`);
    if (b.calibration) {
      out.push('      Calibration (chance given: how often it came out yes):');
      for (const row of b.calibration) out.push(`        ${row.range}: said ${Math.round(row.said * 100)}%, came out yes ${Math.round(row.cameTrue * 100)}% of ${row.count}`);
    }
  }
  const resolved = record.resolvedBySelf + record.resolvedByOthers;
  if (resolved > 0) {
    out.push(
      `  Outcomes recorded by themselves: ${record.resolvedBySelf}. By someone else: ${record.resolvedByOthers}. Confirmed by a second name: ${record.confirmed}${record.confirmed > 0 ? ` (${record.confirmedByPerson} by a person)` : ''}.`,
    );
  }
  out.push(`  Withdrawn: ${record.withdrawn}. Marked overdue and still open: ${record.overdue}.`);
  out.push(
    record.bits === undefined
      ? '  Hardness of the tests set: unknown, because none gives if_false.'
      : `  Hardness of the tests set: ${record.bits.toFixed(1)} bits on average${record.noIfFalse > 0 ? `; ${record.noIfFalse} give no if_false` : ''}. One bit means a yes is twice as likely with the claim true as with it false.`,
  );
  return out.join('\n');
}

export interface Due {
  entry: Entry;
  /** Days past the due date on the day asked about. Zero on the day itself. */
  late: number;
}

/** Open predictions on a given day: those that have come due, most overdue first, and those still to come, soonest first. */
export function dueOn(entries: Entry[], on: string): { due: Due[]; upcoming: Entry[] } {
  const open = entries.filter((e) => e.prediction.outcome === undefined);
  return {
    due: open
      .filter((e) => e.prediction.due <= on)
      .map((entry) => ({ entry, late: days(entry.prediction.due, on) }))
      .sort((a, b) => b.late - a.late),
    upcoming: open.filter((e) => e.prediction.due > on).sort((a, b) => a.prediction.due.localeCompare(b.prediction.due)),
  };
}
