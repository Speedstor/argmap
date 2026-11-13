/** How far a bet has been checked. Ordered from strongest to weakest. */
export const TRUST_LEVELS = ['observed', 'corroborated', 'track-record', 'assumed'] as const;
export type Trust = (typeof TRUST_LEVELS)[number];

/** How expensive it would be to have relied on a bet that turns out false. */
export const COST_LEVELS = ['low', 'medium', 'high'] as const;
export type Cost = (typeof COST_LEVELS)[number];

/**
 * The three outcomes the engine can compute for a claim.
 * None of them means "true": they describe what follows from the bets as written.
 */
export type Status = 'stands' | 'falls' | 'contested';

/** A leaf claim is a bet: a place where justification stops and trust begins. */
export interface Bet {
  trust: Trust;
  cost: Cost;
  note?: string;
  /** False when the file gave no bet and the engine filled in "assumed". */
  explicit: boolean;
}

export interface Claim {
  id: string;
  /** Short name for graph nodes. Defaults to the id with hyphens as spaces. */
  label: string;
  /** Claim text. Pinned terms are written {key} or {key|shown text}. */
  text: string;
  /**
   * Lines of support. Every claim in one group is needed (AND);
   * any one group is enough (OR). Empty for a leaf.
   */
  because: string[][];
  bet?: Bet;
  note?: string;
}

/** A pinned definition. The key is `word` or `word#sense`. */
export interface Term {
  key: string;
  word: string;
  sense?: string;
  definition: string;
  aliases: string[];
}

export interface Attack {
  from: string;
  to: string;
}

export interface Argument {
  title: string;
  conclusion: string;
  terms: Map<string, Term>;
  claims: Map<string, Claim>;
  /** Directed attacks. Each dispute appears here twice, once per direction. */
  attacks: Attack[];
  /** Open disagreements: each side attacks the other. */
  disputes: [string, string][];
}

export interface Issue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  claims: string[];
}
