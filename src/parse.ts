import { parse as parseYaml } from 'yaml';
import { termKeys } from './terms.ts';
import { COST_LEVELS, EVIDENCE_KINDS, OUTCOMES, PREDICTION_TYPES, REVIEWER_KINDS, STANCES, TRUST_LEVELS, VERDICTS } from './types.ts';
import type { Argument, Attack, Bet, Claim, Cost, Evidence, EvidenceKind, Issue, LogEntry, Outcome, Prediction, PredictionType, Review, ReviewerKind, Signed, Stance, Status, Term, Trust, Verdict } from './types.ts';

export interface ParseResult {
  /** Present unless the file is too broken to read at all. */
  argument?: Argument;
  issues: Issue[];
}

/** A library file: more claims, terms and opposition that arguments can draw on. */
export interface LibrarySource {
  name: string;
  source: string;
}

/** One file as written, before it is combined with any library. */
export interface RawFile {
  name: string;
  title?: string;
  conclusion?: string;
  terms: Map<string, Term>;
  claims: Map<string, Claim>;
  attacks: [string, string][];
  disputes: [string, string][];
  log: LogEntry[];
  issues: Issue[];
  /** True when the file could not be read as a mapping at all. */
  unreadable: boolean;
}

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function err(code: string, message: string, claims: string[] = []): Issue {
  return { severity: 'error', code, message, claims };
}

function warn(code: string, message: string, claims: string[] = []): Issue {
  return { severity: 'warning', code, message, claims };
}

function asId(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'number') return String(v);
  return undefined;
}

function asText(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return undefined;
}

export function prettyLabel(id: string): string {
  return id.replace(/[-_]+/g, ' ');
}

/** `because` accepts one id, a flat list (one group), or a list of lists (alternative groups). */
function parseBecause(raw: unknown, id: string, issues: Issue[]): string[][] {
  if (raw === undefined || raw === null) return [];
  const single = asId(raw);
  if (single !== undefined) return [[single]];
  if (!Array.isArray(raw)) {
    issues.push(err('because-shape', `"${id}": because must be a claim id, a list of ids, or a list of lists.`, [id]));
    return [];
  }
  if (raw.length === 0) return [];
  const nested = raw.filter(Array.isArray).length;
  if (nested !== 0 && nested !== raw.length) {
    issues.push(
      err(
        'because-shape',
        `"${id}": because mixes ids and lists. Use a flat list for one line of support, or a list of lists for alternatives.`,
        [id],
      ),
    );
    return [];
  }
  const groups: unknown[][] = nested === 0 ? [raw] : (raw as unknown[][]);
  const out: string[][] = [];
  for (const group of groups) {
    const ids: string[] = [];
    for (const member of group) {
      const m = asId(member);
      if (m === undefined) {
        issues.push(err('because-shape', `"${id}": every entry in because must be a claim id.`, [id]));
      } else if (!ids.includes(m)) {
        ids.push(m);
      }
    }
    if (ids.length > 0) out.push(ids);
  }
  return out;
}

function parseBet(raw: unknown, id: string, issues: Issue[]): Bet | undefined {
  if (raw === undefined || raw === null) return undefined;
  let trustRaw: unknown;
  let costRaw: unknown;
  let note: string | undefined;
  let by: string | undefined;
  if (typeof raw === 'string') {
    trustRaw = raw;
  } else if (isDict(raw)) {
    trustRaw = raw['trust'];
    costRaw = raw['cost'];
    note = asText(raw['note']);
    by = asText(raw['by']);
  } else {
    issues.push(err('bet-shape', `"${id}": bet must be a trust level or a mapping with trust, cost and note.`, [id]));
    return undefined;
  }
  let trust: Trust = 'assumed';
  if ((TRUST_LEVELS as readonly unknown[]).includes(trustRaw)) {
    trust = trustRaw as Trust;
  } else {
    issues.push(
      err('bet-trust', `"${id}": trust must be one of ${TRUST_LEVELS.join(', ')} (got ${JSON.stringify(trustRaw)}).`, [id]),
    );
  }
  let cost: Cost = 'medium';
  if (costRaw !== undefined) {
    if ((COST_LEVELS as readonly unknown[]).includes(costRaw)) {
      cost = costRaw as Cost;
    } else {
      issues.push(err('bet-cost', `"${id}": cost must be one of ${COST_LEVELS.join(', ')}.`, [id]));
    }
  }
  const bet: Bet = { trust, cost, explicit: true };
  if (note) bet.note = note;
  if (by) bet.by = by;
  return bet;
}

function parseSigned(raw: unknown): Signed | undefined {
  if (!isDict(raw)) return undefined;
  const by = asText(raw['by']);
  const kind = raw['kind'] ?? 'person';
  if (!by || !(REVIEWER_KINDS as readonly unknown[]).includes(kind)) return undefined;
  const out: Signed = { by, kind: kind as ReviewerKind };
  const date = asText(raw['date']);
  if (date) out.date = date;
  return out;
}

const isDay = (text: string | undefined): text is string => text !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text));
const isChance = (v: unknown, allowOne: boolean): v is number => typeof v === 'number' && v > 0 && (allowOne ? v <= 1 : v < 1);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function parsePredictions(raw: unknown, id: string, issues: Issue[]): Prediction[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push(err('prediction-shape', `"${id}": predictions must be a list.`, [id]));
    return [];
  }
  const out: Prediction[] = [];
  raw.forEach((entry, i) => {
    const bad = (message: string): void => {
      issues.push(err('prediction-shape', `"${id}", prediction ${i + 1}: ${message}`, [id]));
    };
    if (!isDict(entry)) return bad('must be a mapping.');
    const says = asText(entry['says']);
    const how = asText(entry['how']);
    const by = asText(entry['by']);
    const made = asText(entry['made']);
    const due = asText(entry['due']);
    if (!says || !how) return bad('needs "says" (what will be found) and "how" (how a yes is told from a no).');
    if (!by || !made || !due) return bad('needs "by", "made" and "due".');
    if (!isDay(made) || !isDay(due) || due < made) return bad('made and due must be dates written as YYYY-MM-DD, with due on or after made.');
    const rev = asText(entry['rev']);
    if (!rev) return bad('needs "rev", the fingerprint of the claim wording it tests. The tools write it; "argmap predict" is the way to add a prediction.');
    const type = entry['type'];
    if (!(PREDICTION_TYPES as readonly unknown[]).includes(type)) return bad(`type must be ${PREDICTION_TYPES.join(' or ')}.`);
    const kind = entry['kind'] ?? 'person';
    if (!(REVIEWER_KINDS as readonly unknown[]).includes(kind)) return bad(`kind must be ${REVIEWER_KINDS.join(' or ')}.`);
    const p = entry['p'];
    if (!isChance(p, false)) return bad('p, the chance of a yes, must be a number above 0 and below 1.');
    const ifTrue = entry['if_true'] ?? 1;
    if (!isChance(ifTrue, true)) return bad('if_true must be a number above 0 and at most 1.');
    const ifFalse = entry['if_false'];
    if (ifFalse !== undefined && !isChance(ifFalse, false)) return bad('if_false must be a number above 0 and below 1.');
    const item: Prediction = { says, how, type: type as PredictionType, p, ifTrue, by, kind: kind as ReviewerKind, made, due, rev, accepted: [], confirmed: [] };
    if (ifFalse !== undefined) item.ifFalse = ifFalse;
    const sample = entry['sample'];
    const needs = entry['needs'];
    if (sample !== undefined || needs !== undefined) {
      if (!isCount(sample) || !isCount(needs) || sample < 1 || needs < 1 || needs > sample) {
        return bad('sample and needs go together: whole numbers, with needs between 1 and sample.');
      }
      item.sample = sample;
      item.needs = needs;
    }
    for (const key of ['accepted', 'confirmed'] as const) {
      const list = entry[key];
      if (list === undefined || list === null) continue;
      if (!Array.isArray(list)) return bad(`${key} must be a list of { by, kind, date }.`);
      for (const one of list) {
        const signed = parseSigned(one);
        if (!signed) return bad(`each entry in ${key} needs "by", and a kind of ${REVIEWER_KINDS.join(' or ')}.`);
        item[key].push(signed);
      }
    }
    if (entry['overdue'] !== undefined && entry['overdue'] !== null) {
      const overdue = parseSigned(entry['overdue']);
      if (!overdue) return bad('overdue must be { by, kind, date }.');
      if (!isDay(overdue.date) || overdue.date <= due) return bad(`an overdue marker needs its date, written as YYYY-MM-DD and after the due date (${due}).`);
      item.overdue = overdue;
    }
    const outcome = entry['outcome'];
    if (outcome !== undefined && outcome !== null) {
      // YAML reads a bare yes or no as true or false.
      const word = outcome === true ? 'yes' : outcome === false ? 'no' : outcome;
      if (!(OUTCOMES as readonly unknown[]).includes(word)) return bad(`outcome must be ${OUTCOMES.join(', ')}.`);
      item.outcome = word as Outcome;
      const resolvedBy = asText(entry['resolved_by']);
      if (!resolvedBy) return bad('an outcome needs "resolved_by".');
      item.resolvedBy = resolvedBy;
      const resolvedKind = entry['resolved_kind'] ?? 'person';
      if (!(REVIEWER_KINDS as readonly unknown[]).includes(resolvedKind)) return bad(`resolved_kind must be ${REVIEWER_KINDS.join(' or ')}.`);
      item.resolvedKind = resolvedKind as ReviewerKind;
      const resolved = asText(entry['resolved']);
      const source = asText(entry['source']);
      const note = asText(entry['note']);
      if (!isDay(resolved) || resolved < made) return bad('an outcome needs "resolved", the day it was recorded, written as YYYY-MM-DD and not before the prediction was made.');
      item.resolved = resolved;
      if (source) item.source = source;
      if (note) item.note = note;
      const found = entry['found'];
      if (found !== undefined) {
        if (!isCount(found) || item.sample === undefined || found > item.sample) return bad('found is the number of cases that agreed, so it needs a sample and cannot exceed it.');
        item.found = found;
      }
      if (item.sample !== undefined && item.outcome !== 'void') {
        if (item.found === undefined) return bad('this prediction has a sample, so its outcome needs "found": how many cases agreed.');
        const derived = item.found >= (item.needs as number) ? 'yes' : 'no';
        if (derived !== item.outcome) return bad(`found ${item.found} of ${item.sample} with ${item.needs} needed makes the outcome ${derived}, not ${item.outcome}.`);
      }
      if (item.outcome !== 'void' && !item.source) return bad('an outcome of yes or no needs a "source" that others can open.');
      if (item.outcome === 'void' && !item.note) return bad('a void outcome needs a "note" saying why the prediction was withdrawn.');
    }
    // The same prediction written twice would be scored twice.
    const same = (x: Prediction): boolean => x.says === item.says && x.by === item.by && x.made === item.made && x.due === item.due && x.p === item.p;
    if (out.some(same)) return bad('is the same prediction as an earlier one on this claim. Each prediction is recorded once.');
    out.push(item);
  });
  return out;
}

function parseReviews(raw: unknown, id: string, issues: Issue[]): Review[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push(err('review-shape', `"${id}": reviews must be a list.`, [id]));
    return [];
  }
  const out: Review[] = [];
  for (const entry of raw) {
    if (!isDict(entry)) {
      issues.push(err('review-shape', `"${id}": each review must be a mapping with by and verdict.`, [id]));
      continue;
    }
    const by = asText(entry['by']);
    const verdict = entry['verdict'];
    if (!by || !(VERDICTS as readonly unknown[]).includes(verdict)) {
      issues.push(err('review-shape', `"${id}": a review needs "by" and a verdict of ${VERDICTS.join(' or ')}.`, [id]));
      continue;
    }
    const kindRaw = entry['kind'];
    if (kindRaw !== undefined && !(REVIEWER_KINDS as readonly unknown[]).includes(kindRaw)) {
      issues.push(err('review-shape', `"${id}": a reviewer's kind must be ${REVIEWER_KINDS.join(' or ')}.`, [id]));
      continue;
    }
    const review: Review = { by, kind: (kindRaw as ReviewerKind | undefined) ?? 'person', verdict: verdict as Verdict };
    const note = asText(entry['note']);
    const date = asText(entry['date']);
    const rev = asText(entry['rev']);
    if (note) review.note = note;
    if (date) review.date = date;
    if (rev) review.rev = rev;
    out.push(review);
  }
  return out;
}

function parseEvidence(raw: unknown, id: string, issues: Issue[]): Evidence[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push(err('evidence-shape', `"${id}": evidence must be a list.`, [id]));
    return [];
  }
  const out: Evidence[] = [];
  for (const entry of raw) {
    if (!isDict(entry)) {
      issues.push(err('evidence-shape', `"${id}": each piece of evidence must be a mapping with kind and says.`, [id]));
      continue;
    }
    const kind = entry['kind'];
    const says = asText(entry['says']);
    const stance = entry['stance'] ?? 'for';
    if (!(EVIDENCE_KINDS as readonly unknown[]).includes(kind) || !says) {
      issues.push(err('evidence-shape', `"${id}": evidence needs a kind (${EVIDENCE_KINDS.join(', ')}) and "says": what it shows.`, [id]));
      continue;
    }
    if (!(STANCES as readonly unknown[]).includes(stance)) {
      issues.push(err('evidence-shape', `"${id}": an evidence stance must be ${STANCES.join(' or ')}.`, [id]));
      continue;
    }
    const item: Evidence = { kind: kind as EvidenceKind, stance: stance as Stance, says };
    for (const key of ['source', 'origin', 'by', 'date', 'unit', 'sample', 'period', 'witness'] as const) {
      const text = asText(entry[key]);
      if (text) item[key] = text;
    }
    const value = entry['value'];
    if (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) item.value = value;
    if (typeof entry['first_hand'] === 'boolean') item.firstHand = entry['first_hand'];
    if (typeof entry['peer_reviewed'] === 'boolean') item.peerReviewed = entry['peer_reviewed'];
    out.push(item);
  }
  return out;
}

function parseLog(raw: unknown, issues: Issue[]): LogEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push(err('log-shape', 'log must be a list of rounds.'));
    return [];
  }
  const out: LogEntry[] = [];
  for (const entry of raw) {
    if (!isDict(entry)) continue;
    const item: LogEntry = { at: asText(entry['at']) ?? '', by: asText(entry['by']) ?? '', did: asText(entry['did']) ?? '' };
    const claim = asId(entry['claim']);
    const note = asText(entry['note']);
    if (claim) item.claim = claim;
    if (note) item.note = note;
    if (entry['verdict'] === 'stands' || entry['verdict'] === 'falls' || entry['verdict'] === 'contested') {
      item.verdict = entry['verdict'] as Status;
    }
    if (typeof entry['bets'] === 'number') item.bets = entry['bets'];
    if (typeof entry['sharp'] === 'number') item.sharp = entry['sharp'];
    out.push(item);
  }
  return out;
}

function parsePair(raw: unknown): [string, string] | undefined {
  if (Array.isArray(raw) && raw.length === 2) {
    const a = asId(raw[0]);
    const b = asId(raw[1]);
    if (a !== undefined && b !== undefined) return [a, b];
  }
  if (isDict(raw)) {
    const a = asId(raw['from']);
    const b = asId(raw['to']);
    if (a !== undefined && b !== undefined) return [a, b];
  }
  return undefined;
}

function parseTerms(raw: unknown, issues: Issue[]): Map<string, Term> {
  const terms = new Map<string, Term>();
  if (raw === undefined || raw === null) return terms;
  if (!isDict(raw)) {
    issues.push(err('terms-shape', 'terms must be a mapping from term to definition.'));
    return terms;
  }
  for (const [key, value] of Object.entries(raw)) {
    let definition = '';
    let aliases: string[] = [];
    if (typeof value === 'string') {
      definition = value.trim();
    } else if (isDict(value)) {
      if (typeof value['definition'] === 'string') definition = value['definition'].trim();
      if (Array.isArray(value['aliases'])) {
        aliases = value['aliases'].filter((a): a is string => typeof a === 'string' && a.trim() !== '');
      }
    }
    if (definition === '') {
      issues.push(err('term-definition', `Term "${key}" has no definition. Pinning a term means saying what it means.`));
      continue;
    }
    const hash = key.indexOf('#');
    const word = hash === -1 ? key : key.slice(0, hash);
    const sense = hash === -1 ? undefined : key.slice(hash + 1);
    if (word === '' || sense === '') {
      issues.push(err('term-key', `Term key "${key}" must look like "word" or "word#sense".`));
      continue;
    }
    const term: Term = { key, word, definition, aliases };
    if (sense !== undefined) term.sense = sense;
    terms.set(key, term);
  }
  return terms;
}

function parsePairs(raw: unknown, name: 'attacks' | 'disputes', issues: Issue[]): [string, string][] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push(err(`${name}-shape`, `${name} must be a list of [from, to] pairs.`));
    return [];
  }
  const pairs: [string, string][] = [];
  for (const entry of raw) {
    const pair = parsePair(entry);
    if (!pair) {
      issues.push(err(`${name}-shape`, `Each entry in ${name} must be a pair of claim ids.`));
      continue;
    }
    if (pair[0] === pair[1]) {
      issues.push(err('self-attack', `"${pair[0]}" cannot attack or dispute itself.`, [pair[0]]));
      continue;
    }
    pairs.push(pair);
  }
  return pairs;
}

/**
 * Write down, on each claim, what the terms it pins are defined as. A term with
 * no definition in reach is recorded as such, so adding one later also counts
 * as a change.
 */
export function pinClaims(claims: Iterable<Claim>, terms: ReadonlyMap<string, Term>): void {
  for (const claim of claims) {
    const keys = [...new Set(termKeys(claim.text))].sort();
    if (keys.length === 0) delete claim.pinned;
    else claim.pinned = JSON.stringify(keys.map((key) => [key, terms.get(key)?.definition ?? null]));
  }
}

/** Read one file's shape. Cross-references are checked later, once any library is merged in. */
export function parseFile(source: string, name = ''): RawFile {
  const raw: RawFile = {
    name,
    terms: new Map(),
    claims: new Map(),
    attacks: [],
    disputes: [],
    log: [],
    issues: [],
    unreadable: false,
  };
  let doc: unknown;
  try {
    doc = parseYaml(source);
  } catch (e) {
    const message = e instanceof Error ? e.message.split('\n')[0] : String(e);
    raw.issues.push(err('yaml', `Not valid YAML: ${message}`));
    raw.unreadable = true;
    return raw;
  }
  if (!isDict(doc)) {
    raw.issues.push(err('shape', 'The file must be a mapping with title, conclusion and claims.'));
    raw.unreadable = true;
    return raw;
  }
  const issues = raw.issues;
  if (doc['argmap'] !== undefined && doc['argmap'] !== 1) {
    issues.push(warn('version', `This engine reads format version 1; the file says ${JSON.stringify(doc['argmap'])}.`));
  }
  const title = asText(doc['title']);
  if (title) raw.title = title;
  const conclusion = asId(doc['conclusion']);
  if (conclusion) raw.conclusion = conclusion;
  raw.terms = parseTerms(doc['terms'], issues);

  const rawClaims = doc['claims'];
  if (rawClaims !== undefined && rawClaims !== null && !isDict(rawClaims)) {
    issues.push(err('claims-shape', 'claims must be a mapping from id to claim.'));
  } else if (isDict(rawClaims)) {
    for (const [id, value] of Object.entries(rawClaims)) {
      let text = '';
      let because: string[][] = [];
      let bet: Bet | undefined;
      let note: string | undefined;
      let reviews: Review[] = [];
      let evidence: Evidence[] = [];
      let predictions: Prediction[] = [];
      let label = prettyLabel(id);
      if (typeof value === 'string') {
        text = value.trim();
      } else if (isDict(value)) {
        if (typeof value['text'] === 'string') text = value['text'].trim();
        because = parseBecause(value['because'], id, issues);
        bet = parseBet(value['bet'], id, issues);
        reviews = parseReviews(value['reviews'], id, issues);
        evidence = parseEvidence(value['evidence'], id, issues);
        predictions = parsePredictions(value['predictions'], id, issues);
        note = asText(value['note']);
        if (typeof value['label'] === 'string' && value['label'].trim() !== '') label = value['label'].trim();
      } else {
        issues.push(err('claim-shape', `"${id}" must be a sentence or a mapping with text, because and bet.`, [id]));
        continue;
      }
      if (text === '') {
        issues.push(err('claim-text', `"${id}" has no text.`, [id]));
        text = id;
      }
      const claim: Claim = { id, label, text, because, reviews, evidence, predictions, origin: name };
      if (bet) claim.bet = bet;
      if (note) claim.note = note;
      raw.claims.set(id, claim);
    }
  }
  raw.attacks = parsePairs(doc['attacks'], 'attacks', issues);
  raw.disputes = parsePairs(doc['disputes'], 'disputes', issues);
  raw.log = parseLog(doc['log'], issues);
  // With only this file's terms. A claim that pins a term from another file is pinned again when the files are combined.
  pinClaims(raw.claims.values(), raw.terms);
  return raw;
}

/**
 * Combine an argument file with library files. Every claim in the argument file
 * is kept. A library claim is pulled in only when something already included
 * rests on it or is opposed by it, so known objections travel with the claims
 * they object to.
 */
export function assemble(main: RawFile, library: RawFile[] = []): ParseResult {
  if (main.unreadable) return { issues: main.issues };
  const issues: Issue[] = [...main.issues];
  for (const file of library) {
    for (const issue of file.issues) issues.push({ ...issue, message: `${file.name}: ${issue.message}` });
  }

  const title = main.title ?? 'Untitled argument';
  const claims = new Map<string, Claim>(main.claims);
  if (claims.size === 0) {
    issues.push(err('claims-missing', 'The file needs a claims mapping with at least one claim.'));
  }

  // Index the library, refusing ids defined twice.
  const shelf = new Map<string, Claim>();
  for (const file of library) {
    for (const claim of file.claims.values()) {
      const clash = main.claims.has(claim.id) ? 'the argument file' : shelf.get(claim.id)?.origin;
      if (clash !== undefined) {
        issues.push(err('duplicate-claim', `"${claim.id}" is defined in both ${clash} and ${file.name}. Ids must be unique.`, [claim.id]));
      } else {
        shelf.set(claim.id, claim);
      }
    }
  }
  const shelfAttacks: [string, string][] = [];
  const shelfDisputes: [string, string][] = [];
  for (const file of library) {
    shelfAttacks.push(...file.attacks);
    shelfDisputes.push(...file.disputes);
  }

  // Pull in what the included claims rest on, and what opposes them.
  let grew = true;
  while (grew) {
    grew = false;
    const include = (id: string): void => {
      const claim = shelf.get(id);
      if (claim && !claims.has(id)) {
        claims.set(id, claim);
        grew = true;
      }
    };
    for (const claim of [...claims.values()]) for (const group of claim.because) for (const m of group) include(m);
    for (const [from, to] of [...main.attacks, ...shelfAttacks]) if (claims.has(to)) include(from);
    for (const [a, b] of [...main.disputes, ...shelfDisputes]) {
      if (claims.has(a)) include(b);
      if (claims.has(b)) include(a);
    }
  }

  // Terms: the argument's own, plus library terms that included claims pin.
  const terms = new Map<string, Term>(main.terms);
  const pinned = new Set<string>();
  for (const claim of claims.values()) for (const key of termKeys(claim.text)) pinned.add(key);
  for (const file of library) {
    for (const term of file.terms.values()) {
      const existing = terms.get(term.key);
      if (existing) {
        if (existing.definition !== term.definition) {
          issues.push(err('duplicate-term', `Term "${term.key}" has two different definitions (one in ${file.name}). Pin one meaning.`));
        }
      } else if (pinned.has(term.key)) {
        terms.set(term.key, term);
      }
    }
  }

  pinClaims(claims.values(), terms);

  // Leaves are bets; derived claims are not.
  for (const claim of claims.values()) {
    if (claim.because.length > 0 && claim.bet) {
      issues.push(
        err(
          'bet-on-derived',
          `"${claim.id}" has both support and a bet. A bet marks where justification stops, so a supported claim cannot be one.`,
          [claim.id],
        ),
      );
      delete claim.bet;
    } else if (claim.because.length === 0 && !claim.bet) {
      issues.push(
        warn('bet-unlabelled', `"${claim.id}" has no support and no bet, so it is treated as assumed. Label how far you trust it.`, [
          claim.id,
        ]),
      );
      claim.bet = { trust: 'assumed', cost: 'medium', explicit: false };
    }
    for (const group of claim.because) {
      for (const member of group) {
        if (member === claim.id) {
          issues.push(err('self-support', `"${claim.id}" lists itself as its own support.`, [claim.id]));
        } else if (!claims.has(member)) {
          issues.push(err('unknown-claim', `"${claim.id}" rests on "${member}", which is not defined.`, [claim.id]));
        }
      }
    }
  }

  const attacks: Attack[] = [];
  const disputes: [string, string][] = [];
  const seen = new Set<string>();
  const addAttack = (from: string, to: string): void => {
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    attacks.push({ from, to });
  };
  const known = (pairs: [string, string][], name: string, strict: boolean): [string, string][] =>
    pairs.filter(([a, b]) => {
      const missing = [a, b].filter((id) => !claims.has(id));
      if (missing.length === 0) return true;
      // A library pair about claims this argument does not use is simply not relevant here.
      if (strict || missing.some((id) => !shelf.has(id))) {
        issues.push(err('unknown-claim', `${name} mentions "${missing.join('", "')}", which is not defined.`));
      }
      return false;
    });
  for (const [from, to] of known(main.attacks, 'attacks', true)) addAttack(from, to);
  for (const [from, to] of known(shelfAttacks, 'attacks', false)) addAttack(from, to);
  for (const [a, b] of [...known(main.disputes, 'disputes', true), ...known(shelfDisputes, 'disputes', false)]) {
    if (disputes.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) continue;
    disputes.push([a, b]);
    addAttack(a, b);
    addAttack(b, a);
  }

  let conclusion = main.conclusion ?? '';
  if (conclusion === '') {
    issues.push(err('conclusion-missing', 'The file must name its conclusion: the id of the claim everything else is about.'));
  } else if (!claims.has(conclusion)) {
    issues.push(err('unknown-claim', `The conclusion "${conclusion}" is not defined in claims.`));
    conclusion = '';
  }

  return { argument: { title, conclusion, terms, claims, attacks, disputes, log: main.log }, issues };
}

/**
 * Read an argument file, optionally with library files to draw claims from.
 * Shape problems are reported as issues rather than thrown, so a half-written
 * file still gives useful feedback.
 */
export function parseArgument(source: string, library: LibrarySource[] = []): ParseResult {
  return assemble(
    parseFile(source),
    library.map((file) => parseFile(file.source, file.name)),
  );
}
