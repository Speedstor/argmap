import { parse as parseYaml } from 'yaml';
import { termKeys } from './terms.ts';
import { COST_LEVELS, REVIEWER_KINDS, TRUST_LEVELS, VERDICTS } from './types.ts';
import type { Argument, Attack, Bet, Claim, Cost, Issue, LogEntry, Review, ReviewerKind, Status, Term, Trust, Verdict } from './types.ts';

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
  if (typeof raw === 'string') {
    trustRaw = raw;
  } else if (isDict(raw)) {
    trustRaw = raw['trust'];
    costRaw = raw['cost'];
    note = asText(raw['note']);
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
  return bet;
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
      let label = prettyLabel(id);
      if (typeof value === 'string') {
        text = value.trim();
      } else if (isDict(value)) {
        if (typeof value['text'] === 'string') text = value['text'].trim();
        because = parseBecause(value['because'], id, issues);
        bet = parseBet(value['bet'], id, issues);
        reviews = parseReviews(value['reviews'], id, issues);
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
      const claim: Claim = { id, label, text, because, reviews, origin: name };
      if (bet) claim.bet = bet;
      if (note) claim.note = note;
      raw.claims.set(id, claim);
    }
  }
  raw.attacks = parsePairs(doc['attacks'], 'attacks', issues);
  raw.disputes = parsePairs(doc['disputes'], 'disputes', issues);
  raw.log = parseLog(doc['log'], issues);
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
