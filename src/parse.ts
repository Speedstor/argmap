import { parse as parseYaml } from 'yaml';
import { COST_LEVELS, TRUST_LEVELS } from './types.ts';
import type { Argument, Attack, Bet, Claim, Cost, Issue, Term, Trust } from './types.ts';

export interface ParseResult {
  /** Present unless the file is too broken to read at all. */
  argument?: Argument;
  issues: Issue[];
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
    if (typeof raw['note'] === 'string') note = raw['note'].trim();
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

/**
 * Read an argument file. Shape problems are reported as issues rather than thrown,
 * so a half-written file still gives useful feedback.
 */
export function parseArgument(source: string): ParseResult {
  const issues: Issue[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(source);
  } catch (e) {
    const message = e instanceof Error ? e.message.split('\n')[0] : String(e);
    return { issues: [err('yaml', `Not valid YAML: ${message}`)] };
  }
  if (!isDict(doc)) {
    return { issues: [err('shape', 'The file must be a mapping with title, conclusion and claims.')] };
  }
  if (doc['argmap'] !== undefined && doc['argmap'] !== 1) {
    issues.push(warn('version', `This engine reads format version 1; the file says ${JSON.stringify(doc['argmap'])}.`));
  }

  const title = typeof doc['title'] === 'string' && doc['title'].trim() !== '' ? doc['title'].trim() : 'Untitled argument';
  const terms = parseTerms(doc['terms'], issues);

  const claims = new Map<string, Claim>();
  const rawClaims = doc['claims'];
  if (!isDict(rawClaims) || Object.keys(rawClaims).length === 0) {
    issues.push(err('claims-missing', 'The file needs a claims mapping with at least one claim.'));
  } else {
    for (const [id, value] of Object.entries(rawClaims)) {
      let text = '';
      let because: string[][] = [];
      let bet: Bet | undefined;
      let note: string | undefined;
      let label = prettyLabel(id);
      if (typeof value === 'string') {
        text = value.trim();
      } else if (isDict(value)) {
        if (typeof value['text'] === 'string') text = value['text'].trim();
        because = parseBecause(value['because'], id, issues);
        bet = parseBet(value['bet'], id, issues);
        if (typeof value['note'] === 'string') note = value['note'].trim();
        if (typeof value['label'] === 'string' && value['label'].trim() !== '') label = value['label'].trim();
      } else {
        issues.push(err('claim-shape', `"${id}" must be a sentence or a mapping with text, because and bet.`, [id]));
        continue;
      }
      if (text === '') {
        issues.push(err('claim-text', `"${id}" has no text.`, [id]));
        text = id;
      }
      const claim: Claim = { id, label, text, because };
      if (bet) claim.bet = bet;
      if (note) claim.note = note;
      claims.set(id, claim);
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
  const readPairs = (raw: unknown, name: 'attacks' | 'disputes'): [string, string][] => {
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
      const [a, b] = pair;
      const missing = [a, b].filter((id) => !claims.has(id));
      if (missing.length > 0) {
        issues.push(err('unknown-claim', `${name} mentions "${missing.join('", "')}", which is not defined.`));
        continue;
      }
      if (a === b) {
        issues.push(err('self-attack', `"${a}" cannot attack or dispute itself.`, [a]));
        continue;
      }
      pairs.push(pair);
    }
    return pairs;
  };
  for (const [from, to] of readPairs(doc['attacks'], 'attacks')) addAttack(from, to);
  for (const [a, b] of readPairs(doc['disputes'], 'disputes')) {
    if (disputes.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) continue;
    disputes.push([a, b]);
    addAttack(a, b);
    addAttack(b, a);
  }

  let conclusion = asId(doc['conclusion']) ?? '';
  if (conclusion === '') {
    issues.push(err('conclusion-missing', 'The file must name its conclusion: the id of the claim everything else is about.'));
  } else if (!claims.has(conclusion)) {
    issues.push(err('unknown-claim', `The conclusion "${conclusion}" is not defined in claims.`));
    conclusion = '';
  }

  return { argument: { title, conclusion, terms, claims, attacks, disputes }, issues };
}
