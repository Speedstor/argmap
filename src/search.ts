import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { parseFile, plainText, reviewSummary } from './index.ts';
import type { ReviewState, Trust } from './index.ts';
import { argumentFiles, libraryFiles, loadFile } from './workspace.ts';

export interface Hit {
  id: string;
  text: string;
  /** Where the claim is defined, relative to the workspace root. */
  file: string;
  kind: 'bet' | 'supported';
  trust?: Trust;
  review: ReviewState;
  /** Argument files that draw on this claim. */
  usedIn: string[];
}

/** Find claims anywhere in the workspace: the library and every argument file. An empty query lists everything. */
export function searchClaims(root: string, query: string, limit = 20): Hit[] {
  const rel = (path: string): string => relative(root, path).split(sep).join('/');
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const args = argumentFiles(root);

  const usedIn = new Map<string, string[]>();
  for (const path of args) {
    const loaded = loadFile(path, root);
    for (const id of loaded.argument?.claims.keys() ?? []) {
      const list = usedIn.get(id) ?? [];
      list.push(rel(path));
      usedIn.set(id, list);
    }
  }

  const hits: (Hit & { score: number })[] = [];
  for (const path of [...libraryFiles(root), ...args]) {
    const file = parseFile(readFileSync(path, 'utf8'), rel(path));
    for (const claim of file.claims.values()) {
      const text = plainText(claim.text);
      const haystack = `${claim.id.replace(/-/g, ' ')} ${text}`.toLowerCase();
      if (!words.every((w) => haystack.includes(w))) continue;
      const hit: Hit & { score: number } = {
        id: claim.id,
        text,
        file: rel(path),
        kind: claim.because.length > 0 ? 'supported' : 'bet',
        review: reviewSummary(claim).state,
        usedIn: usedIn.get(claim.id) ?? [],
        score: words.filter((w) => claim.id.includes(w)).length,
      };
      if (claim.bet) hit.trust = claim.bet.trust;
      hits.push(hit);
    }
  }
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score: _score, ...hit }) => hit);
}
