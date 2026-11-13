import { supportersClosure } from './graph.ts';
import type { Argument, Issue, Term } from './types.ts';

export type Segment = { kind: 'text'; value: string } | { kind: 'term'; key: string; shown: string };

const MARKER = /\{([^{}|]+)(?:\|([^{}]*))?\}/g;

function defaultShown(key: string): string {
  const hash = key.indexOf('#');
  return (hash === -1 ? key : key.slice(0, hash)).replace(/-/g, ' ');
}

/** Split claim text into plain runs and pinned-term markers. */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(MARKER)) {
    const start = m.index;
    if (start > last) out.push({ kind: 'text', value: text.slice(last, start) });
    const key = (m[1] ?? '').trim();
    const shown = m[2] !== undefined && m[2].trim() !== '' ? m[2] : defaultShown(key);
    out.push({ kind: 'term', key, shown });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out;
}

/** Claim text as a reader sees it, with markers replaced by their shown words. */
export function plainText(text: string): string {
  return segments(text)
    .map((s) => (s.kind === 'text' ? s.value : s.shown))
    .join('');
}

export function termKeys(text: string): string[] {
  const keys: string[] = [];
  for (const s of segments(text)) {
    if (s.kind === 'term' && !keys.includes(s.key)) keys.push(s.key);
  }
  return keys;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Words that count as the same word as this term when they appear unpinned. */
function surfaceForms(term: Term): string[] {
  return [term.word.replace(/-/g, ' '), ...term.aliases];
}

function describeSense(sense: string): string {
  return sense === '' ? 'no stated sense' : `"${sense}"`;
}

/**
 * Checks that guard against equivocation: a word that quietly means
 * two things makes a chain look valid when it is not.
 */
export function termIssues(arg: Argument): Issue[] {
  const issues: Issue[] = [];
  const usedIn = new Map<string, string[]>();
  /** claim id -> word -> senses used ('' when the term has no sense) */
  const senses = new Map<string, Map<string, Set<string>>>();

  for (const claim of arg.claims.values()) {
    const perWord = new Map<string, Set<string>>();
    for (const key of termKeys(claim.text)) {
      const term = arg.terms.get(key);
      if (!term) {
        issues.push({
          severity: 'error',
          code: 'term-undefined',
          message: `"${claim.id}" pins {${key}}, which has no definition under terms.`,
          claims: [claim.id],
        });
        continue;
      }
      const list = usedIn.get(key) ?? [];
      list.push(claim.id);
      usedIn.set(key, list);
      const set = perWord.get(term.word) ?? new Set<string>();
      set.add(term.sense ?? '');
      perWord.set(term.word, set);
    }
    senses.set(claim.id, perWord);
  }

  for (const term of arg.terms.values()) {
    const uses = usedIn.get(term.key) ?? [];
    if (uses.length === 0) {
      issues.push({
        severity: 'warning',
        code: 'term-unused',
        message: `Term "${term.key}" is defined but no claim pins it.`,
        claims: [],
      });
    } else if (uses.length === 1) {
      issues.push({
        severity: 'warning',
        code: 'term-once',
        message: `Term "${term.key}" is pinned in only one claim ("${uses[0]}"), so no other claim is tied to that meaning.`,
        claims: uses,
      });
    }
  }

  // A defined word used outside a marker is free to drift.
  const reported = new Set<string>();
  for (const term of arg.terms.values()) {
    for (const form of surfaceForms(term)) {
      const stem = form.length > 4 && form.endsWith('e') ? form.slice(0, -1) : form;
      const pattern = new RegExp(`(^|[^\\p{L}])${escapeRegExp(stem)}`, 'iu');
      for (const claim of arg.claims.values()) {
        const unpinned = segments(claim.text)
          .map((s) => (s.kind === 'text' ? s.value : ' '))
          .join('');
        const key = `${claim.id}\u0000${term.word}`;
        if (pattern.test(unpinned) && !reported.has(key)) {
          reported.add(key);
          issues.push({
            severity: 'warning',
            code: 'term-unpinned',
            message: `"${claim.id}" uses "${form}" without pinning it. Write it as {${term.key}} so it cannot change meaning.`,
            claims: [claim.id],
          });
        }
      }
    }
  }

  // The same word in two senses along one chain of support.
  const shifts = new Set<string>();
  for (const claim of arg.claims.values()) {
    const mine = senses.get(claim.id);
    if (!mine || mine.size === 0) continue;
    for (const supporter of supportersClosure(arg, claim.id)) {
      const theirs = senses.get(supporter);
      if (!theirs) continue;
      for (const [word, mySenses] of mine) {
        const theirSenses = theirs.get(word);
        if (!theirSenses) continue;
        for (const a of mySenses) {
          for (const b of theirSenses) {
            if (a === b) continue;
            const key = [word, ...[a, b].sort()].join('\u0000');
            if (shifts.has(key)) continue;
            shifts.add(key);
            issues.push({
              severity: 'warning',
              code: 'sense-shift',
              message: `"${word}" changes sense along one chain of support: ${describeSense(a)} in "${claim.id}", ${describeSense(b)} in "${supporter}". The step only holds if both mean the same thing.`,
              claims: [claim.id, supporter],
            });
          }
        }
      }
    }
  }

  // An attacker using a word in a different sense from its target.
  const clashes = new Set<string>();
  for (const { from, to } of arg.attacks) {
    const a = senses.get(from);
    const b = senses.get(to);
    if (!a || !b) continue;
    for (const [word, fromSenses] of a) {
      const toSenses = b.get(word);
      if (!toSenses) continue;
      const shared = [...fromSenses].some((s) => toSenses.has(s));
      if (shared) continue;
      const key = [word, ...[from, to].sort()].join('\u0000');
      if (clashes.has(key)) continue;
      clashes.add(key);
      issues.push({
        severity: 'warning',
        code: 'sense-clash',
        message: `"${from}" and "${to}" are opposed but use "${word}" in different senses (${[...fromSenses].map(describeSense).join(', ')} against ${[...toSenses].map(describeSense).join(', ')}). They may be talking past each other.`,
        claims: [from, to],
      });
    }
  }

  return issues;
}
