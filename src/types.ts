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
  /** Who set the trust label. That signer vouches for the bet. */
  by?: string;
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
  /**
   * The definitions of the terms this claim pins, as one string. It is part of
   * the claim's fingerprint, so redefining a word the claim turns on makes
   * earlier reviews and tests stale, the same as rewording the claim.
   */
  pinned?: string;
  /** Tests of this claim: what was expected before looking, and what was found. */
  predictions: Prediction[];
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

export const PREDICTION_TYPES = ['lookup', 'forecast'] as const;
/** lookup: the answer already exists and only has to be found. forecast: it does not exist yet. */
export type PredictionType = (typeof PREDICTION_TYPES)[number];
export const OUTCOMES = ['yes', 'no', 'void'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** A name put to something, with the kind of signer and the day. */
export interface Signed {
  by: string;
  kind: ReviewerKind;
  date?: string;
}

/**
 * A test of a claim, written down before the answer is known: what will be
 * found, how a yes is told from a no, and how likely a yes is. The fields down
 * to `rev` are fixed once recorded. The rest is added later, each part once.
 */
export interface Prediction {
  /** What will be found, as a statement that turns out yes or no. */
  says: string;
  /** How a yes is told from a no. */
  how: string;
  type: PredictionType;
  /** The setter's chance of a yes. Used to score the setter, and for nothing else. */
  p: number;
  /** The chance of a yes if the claim is true. 1 when the claim strictly implies it. */
  ifTrue: number;
  /** The chance of a yes if the claim is false. Absent when the setter did not say. */
  ifFalse?: number;
  /** How many independent cases will be looked at, and how many must agree for a yes. */
  sample?: number;
  needs?: number;
  by: string;
  kind: ReviewerKind;
  made: string;
  due: string;
  /** Fingerprint of the claim wording this tests. A test of an older wording is stale. */
  rev?: string;

  /** Those who vouch for the claim and agreed, before the outcome, that it implies this test. */
  accepted: Signed[];
  /** Filed when the due date has passed with no outcome. The claim cannot stand until it is resolved. */
  overdue?: Signed;
  outcome?: Outcome;
  /** With a sample: how many cases agreed. */
  found?: number;
  resolved?: string;
  resolvedBy?: string;
  resolvedKind?: ReviewerKind;
  source?: string;
  note?: string;
  /** Others who checked the recorded outcome and agree with it. */
  confirmed: Signed[];
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
