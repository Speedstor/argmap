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
  /** Peer reviews of this claim, oldest first. */
  reviews: Review[];
  /** What has been found for or against this claim. */
  evidence: Evidence[];
  /** The file this claim was defined in: '' for the argument file, otherwise a library file name. */
  origin: string;
}

export const VERDICTS = ['confirm', 'reject'] as const;
export type Verdict = (typeof VERDICTS)[number];
export const REVIEWER_KINDS = ['person', 'ai'] as const;
export type ReviewerKind = (typeof REVIEWER_KINDS)[number];

/**
 * One reviewer's judgment of one claim. For a bet: is it acceptable as stated?
 * For a supported claim: does the support really establish it?
 * People and AI reviewers carry the same weight.
 */
export interface Review {
  by: string;
  kind: ReviewerKind;
  verdict: Verdict;
  note?: string;
  date?: string;
  /** Fingerprint of the claim when it was reviewed. A review of an older wording is stale. */
  rev?: string;
}

export const EVIDENCE_KINDS = ['statistic', 'account', 'paper', 'reference'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const STANCES = ['for', 'against'] as const;
export type Stance = (typeof STANCES)[number];

/**
 * One piece of evidence bearing on a claim.
 *   statistic: a measured figure, with its unit, sample and period
 *   account:   what someone saw or did, ideally first-hand
 *   paper:     a published study
 *   reference: any other secondary source (an encyclopedia, a report, a textbook)
 * Evidence can count against a claim as well as for it.
 */
export interface Evidence {
  kind: EvidenceKind;
  stance: Stance;
  /** What it shows, in one sentence. */
  says: string;
  /** Where to find it: a URL, DOI or citation. */
  source?: string;
  /** What it ultimately rests on. Two records with the same origin are not independent. */
  origin?: string;
  by?: string;
  date?: string;
  value?: number | string;
  unit?: string;
  sample?: string;
  period?: string;
  witness?: string;
  firstHand?: boolean;
  peerReviewed?: boolean;
}

/** One round of work on an argument, with the verdict it left behind. */
export interface LogEntry {
  at: string;
  by: string;
  did: string;
  claim?: string;
  note?: string;
  verdict?: Status;
  bets?: number;
  sharp?: number;
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
  /** Rounds of work, oldest first. */
  log: LogEntry[];
}

export interface Issue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  claims: string[];
}
