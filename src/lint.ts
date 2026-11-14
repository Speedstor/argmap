import { plainText } from './terms.ts';
import type { Argument, Claim } from './types.ts';

export interface Flag {
  code: 'vague-words' | 'no-anchor' | 'compound';
  message: string;
}

/** Words that sound like a quantity or a degree without committing to one. */
const VAGUE = [
  'largely', 'mostly', 'mainly', 'generally', 'often', 'usually', 'typically', 'sometimes',
  'many', 'most', 'some', 'several', 'much', 'few', 'enough', 'plenty',
  'too little', 'too few', 'too much', 'too small', 'too many',
  'far', 'very', 'quite', 'fairly', 'somewhat', 'long before', 'eventually', 'soon',
  'at scale', 'in quantity', 'a fraction', 'a lot',
  'significant', 'significantly', 'substantial', 'substantially', 'major', 'huge', 'large', 'small', 'modest',
  'cheap', 'easily', 'likely', 'probably', 'plausibly',
];

const VAGUE_PATTERN = new RegExp(`(?<![\\p{L}-])(${VAGUE.map((w) => w.replace(/ /g, '\\s+')).join('|')})(?![\\p{L}-])`, 'giu');
const JOINERS = /;|,\s+(and|but|so|because|which|while)\s/i;

/**
 * Prompts for sharpening a bet. These are word-level heuristics: they point at
 * where a claim may be hand-wavy, and a person or model decides whether it is.
 */
export function lintClaim(claim: Claim): Flag[] {
  const text = plainText(claim.text);
  const flags: Flag[] = [];

  const vague = [...new Set([...text.matchAll(VAGUE_PATTERN)].map((m) => (m[1] ?? '').toLowerCase().replace(/\s+/g, ' ')))];
  if (vague.length > 0) {
    flags.push({
      code: 'vague-words',
      message: `Says ${vague.map((w) => `"${w}"`).join(', ')} without saying how much. Replace with a figure or a threshold.`,
    });
  }

  const hasNumber = /\d/.test(text);
  const hasName = /(?<=[\p{Ll},;:]\s)\p{Lu}\p{L}+/u.test(text);
  if (!hasNumber && !hasName) {
    flags.push({
      code: 'no-anchor',
      message: 'Names no figure, date, place or case, so there is nothing specific to check it against.',
    });
  }

  if (JOINERS.test(text)) {
    flags.push({ code: 'compound', message: 'May bundle more than one claim. Split it so each part can stand or fall alone.' });
  }
  return flags;
}

export interface Resolution {
  bets: number;
  /** Bets with no flags. */
  sharp: number;
  flags: Map<string, Flag[]>;
}

/** How finely the argument is resolved: of its bets, how many are specific enough to check. */
export function resolution(arg: Argument): Resolution {
  const flags = new Map<string, Flag[]>();
  let bets = 0;
  let sharp = 0;
  for (const claim of arg.claims.values()) {
    if (!claim.bet) continue;
    bets++;
    const found = lintClaim(claim);
    if (found.length === 0) sharp++;
    else flags.set(claim.id, found);
  }
  return { bets, sharp, flags };
}
