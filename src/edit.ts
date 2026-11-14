import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { Document } from 'yaml';
import { analyze, claimRev, EVIDENCE_KINDS, evidenceToYaml, load, OUTCOMES, PREDICTION_TYPES, predictionToYaml, resolution, REVIEWER_KINDS, STANCES, TRUST_LEVELS, VERDICTS, vouchers } from './index.ts';
import type { Claim, Cost, Evidence, Issue, Loaded, Outcome, Prediction, PredictionType, ReviewerKind, Signed, Status, Trust, Verdict } from './index.ts';
import { findRoot, LIBRARY_DIR, libraryFiles } from './workspace.ts';

const WRITE_OPTIONS = { lineWidth: 0, flowCollectionPadding: false } as const;

export interface NewClaim {
  id: string;
  text: string;
  /** Lines of support. Omit for a bet. */
  because?: string[][];
  trust?: Trust;
  cost?: Cost;
  note?: string;
}

export interface EditResult {
  /** Files that were rewritten, relative to the workspace root. */
  written: string[];
  conclusion: Status;
  bets: number;
  sharp: number;
  /** Warnings on the argument after the edit. */
  warnings: Issue[];
}

export class EditError extends Error {}

/** What the setter fixes when a prediction is made. The date, the fingerprint and any acceptance are filled in on saving. */
export interface NewPrediction {
  says: string;
  how: string;
  type: PredictionType;
  p: number;
  ifFalse?: number;
  ifTrue?: number;
  sample?: number;
  needs?: number;
  due: string;
  by: string;
  kind: ReviewerKind;
}

const isDate = (text: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text));

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function checkId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new EditError(`"${id}" is not a usable id. Use lowercase letters, digits and hyphens, like "easy-coal-gone".`);
  }
}

/**
 * Makes changes to an argument and its library as one unit. Nothing is written
 * unless the result still loads without errors, and every change adds a line to
 * the argument's log with the verdict it left behind. Comments and layout in
 * the files are kept.
 */
export class Editor {
  readonly root: string;
  readonly argumentPath: string;
  private docs = new Map<string, Document>();
  private dirty = new Set<string>();

  constructor(argumentPath: string, root?: string) {
    this.argumentPath = resolve(argumentPath);
    this.root = root ? resolve(root) : findRoot(this.argumentPath);
    if (!existsSync(this.argumentPath)) throw new EditError(`No such argument file: ${argumentPath}`);
  }

  private doc(path: string): Document {
    let doc = this.docs.get(path);
    if (!doc) {
      doc = parseDocument(existsSync(path) ? readFileSync(path, 'utf8') : '');
      if (doc.errors.length > 0) throw new EditError(`${this.rel(path)} is not valid YAML: ${doc.errors[0]?.message ?? ''}`);
      this.docs.set(path, doc);
    }
    return doc;
  }

  private rel(path: string): string {
    return relative(this.root, path).split(sep).join('/');
  }

  private paths(): string[] {
    return [...new Set([this.argumentPath, ...libraryFiles(this.root), ...this.dirty])];
  }

  /** The file that defines a claim, if any. */
  private locate(id: string): string | undefined {
    return this.paths().find((path) => this.doc(path).hasIn(['claims', id]));
  }

  private mustLocate(id: string): string {
    const path = this.locate(id);
    if (!path) throw new EditError(`There is no claim "${id}" in this argument or the library.`);
    return path;
  }

  /** Where a new claim goes: the argument file, or a named file in the library. */
  private target(into?: string): string {
    if (!into) return this.argumentPath;
    const name = into.replace(/^claims\//, '');
    if (!/^[\w.-]+(\/[\w.-]+)*\.ya?ml$/.test(name) || name.includes('..')) {
      throw new EditError(`"${into}" is not a usable library file name. Use something like "energy.yaml".`);
    }
    return join(this.root, LIBRARY_DIR, name);
  }

  private touch(path: string): Document {
    this.dirty.add(path);
    return this.doc(path);
  }

  /** Turn a claim written as a bare sentence into a mapping so fields can be added. */
  private openClaim(path: string, id: string): Document {
    const doc = this.touch(path);
    const node = doc.getIn(['claims', id], true);
    if (!isMap(node)) doc.setIn(['claims', id], doc.createNode({ text: String(doc.getIn(['claims', id]) ?? '') }));
    return doc;
  }

  private flowSeq(doc: Document, items: unknown[]): unknown {
    const node = doc.createNode(items);
    if (isSeq(node)) {
      node.flow = true;
      for (const item of node.items) if (isSeq(item)) item.flow = true;
    }
    return node;
  }

  private setBecause(doc: Document, id: string, because: string[][]): void {
    const groups = because.filter((g) => g.length > 0);
    if (groups.length === 0) doc.deleteIn(['claims', id, 'because']);
    else doc.setIn(['claims', id, 'because'], this.flowSeq(doc, groups.length === 1 ? (groups[0] as string[]) : groups));
  }

  private writeClaim(claim: NewClaim, into?: string): string {
    checkId(claim.id);
    if (claim.text.trim() === '') throw new EditError(`"${claim.id}" needs text.`);
    const existing = this.locate(claim.id);
    if (existing) throw new EditError(`"${claim.id}" already exists in ${this.rel(existing)}. Pick another id, or reuse the existing claim.`);
    const path = this.target(into);
    const doc = this.touch(path);
    if (!isMap(doc.get('claims', true))) doc.set('claims', doc.createNode({}));
    const value: Record<string, unknown> = { text: claim.text.trim() };
    const supported = (claim.because ?? []).some((g) => g.length > 0);
    if (!supported) {
      const bet: Record<string, unknown> = { trust: claim.trust ?? 'assumed' };
      if (claim.cost && claim.cost !== 'medium') bet['cost'] = claim.cost;
      if (claim.note) bet['note'] = claim.note.trim();
      value['bet'] = bet;
    } else if (claim.note) {
      value['note'] = claim.note.trim();
    }
    const map = doc.get('claims', true);
    if (isMap(map)) {
      // A blank line before each new claim, to match hand-written files.
      const pair = doc.createPair(claim.id, value);
      if (map.items.length > 0 && isScalar(pair.key)) pair.key.spaceBefore = true;
      map.add(pair);
    }
    if (supported) this.setBecause(doc, claim.id, claim.because as string[][]);
    return path;
  }

  /* ---------- Operations ---------- */

  addClaim(claim: NewClaim, into?: string): this {
    this.writeClaim(claim, into);
    return this;
  }

  /**
   * Increase resolution: replace a bet with sharper claims underneath it.
   * mode "all" means every part is needed; "any" means each part is enough alone.
   */
  refine(id: string, options: { parts?: NewClaim[]; use?: string[]; mode?: 'all' | 'any'; text?: string; into?: string }): this {
    const path = this.mustLocate(id);
    const parts = options.parts ?? [];
    const use = options.use ?? [];
    if (parts.length + use.length === 0) throw new EditError('Refining needs at least one part: a new claim, or an existing one to reuse.');
    for (const existing of use) this.mustLocate(existing);
    const into = options.into ?? (path === this.argumentPath ? undefined : this.rel(path));
    for (const part of parts) this.writeClaim(part, into);

    const doc = this.openClaim(path, id);
    const members = [...parts.map((p) => p.id), ...use];
    if (doc.hasIn(['claims', id, 'because'])) {
      throw new EditError(`"${id}" already has support. Use set_support to change it.`);
    }
    const oldTrust = doc.getIn(['claims', id, 'bet', 'trust']) ?? doc.getIn(['claims', id, 'bet']);
    const oldNote = doc.getIn(['claims', id, 'bet', 'note']);
    doc.deleteIn(['claims', id, 'bet']);
    if (options.text) doc.setIn(['claims', id, 'text'], options.text.trim());
    this.setBecause(doc, id, options.mode === 'any' ? members.map((m) => [m]) : [members]);
    if (typeof oldNote === 'string' && !doc.hasIn(['claims', id, 'note'])) {
      doc.setIn(['claims', id, 'note'], `Was a bet (${typeof oldTrust === 'string' ? oldTrust : 'assumed'}): ${oldNote}`);
    }
    return this;
  }

  setSupport(id: string, because: string[][]): this {
    const path = this.mustLocate(id);
    if (!because.some((g) => g.length > 0)) throw new EditError('Support cannot be empty. A claim with no support must be a bet.');
    for (const member of because.flat()) this.mustLocate(member);
    const doc = this.openClaim(path, id);
    doc.deleteIn(['claims', id, 'bet']);
    this.setBecause(doc, id, because);
    return this;
  }

  /** Record the result of checking a bet. `by` is who sets the label, and so who vouches for the bet from now on. */
  setBet(id: string, bet: { trust: Trust; note?: string; cost?: Cost; by?: string }): this {
    if (!(TRUST_LEVELS as readonly string[]).includes(bet.trust)) throw new EditError(`trust must be one of ${TRUST_LEVELS.join(', ')}.`);
    const path = this.mustLocate(id);
    const doc = this.openClaim(path, id);
    if (doc.hasIn(['claims', id, 'because'])) throw new EditError(`"${id}" has support, so it is not a bet.`);
    const value: Record<string, unknown> = { trust: bet.trust };
    const cost = bet.cost ?? doc.getIn(['claims', id, 'bet', 'cost']);
    const note = bet.note ?? doc.getIn(['claims', id, 'bet', 'note']);
    if (typeof cost === 'string' && cost !== 'medium') value['cost'] = cost;
    if (typeof note === 'string' && note.trim() !== '') value['note'] = note.trim();
    const by = bet.by ?? doc.getIn(['claims', id, 'bet', 'by']);
    if (typeof by === 'string' && by.trim() !== '') value['by'] = by.trim();
    doc.setIn(['claims', id, 'bet'], doc.createNode(value));
    return this;
  }

  /* ---------- Predictions ---------- */

  private pendingPredictions: { id: string; prediction: NewPrediction }[] = [];

  /**
   * Write down a test of a claim before the answer is known. The claim's
   * fingerprint is filled in on saving. If the setter vouches for the claim,
   * the test is accepted in the same step.
   */
  predict(id: string, prediction: NewPrediction): this {
    const chance = (v: number | undefined, allowOne: boolean): boolean => typeof v === 'number' && v > 0 && (allowOne ? v <= 1 : v < 1);
    if (prediction.says.trim() === '' || prediction.how.trim() === '') throw new EditError('A prediction needs "says" (what will be found) and "how" (how a yes is told from a no).');
    if (!(PREDICTION_TYPES as readonly string[]).includes(prediction.type)) throw new EditError(`type must be ${PREDICTION_TYPES.join(' or ')}: lookup when the answer already exists, forecast when it does not yet.`);
    if (!chance(prediction.p, false)) throw new EditError('p, the chance of a yes, must be above 0 and below 1.');
    if (prediction.ifFalse !== undefined && !chance(prediction.ifFalse, false)) throw new EditError('if_false must be above 0 and below 1.');
    if (prediction.ifTrue !== undefined && !chance(prediction.ifTrue, true)) throw new EditError('if_true must be above 0 and at most 1.');
    if ((prediction.sample === undefined) !== (prediction.needs === undefined)) throw new EditError('sample and needs go together.');
    if (prediction.sample !== undefined) {
      const { sample, needs } = prediction as { sample: number; needs: number };
      if (!Number.isInteger(sample) || !Number.isInteger(needs) || needs < 1 || needs > sample) throw new EditError('sample and needs must be whole numbers, with needs between 1 and sample.');
    }
    if (!isDate(prediction.due)) throw new EditError('due must be a date written as YYYY-MM-DD.');
    if (prediction.due < today()) throw new EditError(`due (${prediction.due}) is already past.`);
    if (!(REVIEWER_KINDS as readonly string[]).includes(prediction.kind)) throw new EditError(`kind must be ${REVIEWER_KINDS.join(' or ')}.`);
    if (prediction.by.trim() === '') throw new EditError('A prediction needs the name of whoever sets it.');
    this.mustLocate(id);
    this.pendingPredictions.push({ id, prediction });
    return this;
  }

  /** The claim and one of its predictions, counted from 1 in the order they were recorded. */
  private prediction(id: string, n: number): { claim: Claim; found: Prediction } {
    this.mustLocate(id);
    const claim = this.loadNow().argument?.claims.get(id);
    const found = Number.isInteger(n) ? claim?.predictions[n - 1] : undefined;
    if (!claim || !found) throw new EditError(`"${id}" has no prediction number ${n}. It has ${claim?.predictions.length ?? 0}.`);
    return { claim, found };
  }

  private append(doc: Document, path: (string | number)[], value: Record<string, unknown>): void {
    if (isSeq(doc.getIn(path, true))) doc.addIn(path, doc.createNode(value));
    else doc.setIn(path, doc.createNode([value]));
  }

  private openPrediction(id: string, n: number): { doc: Document; at: (string | number)[]; found: Prediction; backers: string[]; current: boolean } {
    const { claim, found } = this.prediction(id, n);
    const doc = this.openClaim(this.mustLocate(id), id);
    return { doc, at: ['claims', id, 'predictions', n - 1], found, backers: vouchers(claim), current: found.rev === undefined || found.rev === claimRev(claim) };
  }

  /** Someone who vouches for the claim agrees that it implies this test. Only then can a failure knock the claim out. */
  accept(id: string, n: number, who: { by: string; kind: ReviewerKind }): this {
    const { doc, at, found, backers, current } = this.openPrediction(id, n);
    if (found.outcome !== undefined) throw new EditError('That prediction already has an outcome. A test is accepted before the answer is known, or not at all.');
    if (!current) throw new EditError('That prediction tests an earlier wording of the claim.');
    if (!backers.includes(who.by)) {
      throw new EditError(
        `${who.by} does not vouch for "${id}", so cannot accept a test on its behalf. ${backers.length > 0 ? `Those who do: ${backers.join(', ')}.` : 'Nobody does yet: confirm the claim in a review first, or be named on its trust label.'}`,
      );
    }
    if (found.accepted.some((a) => a.by === who.by)) throw new EditError(`${who.by} has already accepted that test.`);
    this.append(doc, [...at, 'accepted'], { by: who.by, kind: who.kind, date: today() });
    return this;
  }

  /** Record what was found. With a sample, give how many cases agreed and the outcome follows from the count. */
  resolve(id: string, n: number, result: { outcome?: Outcome; found?: number; source?: string; note?: string; by: string; kind: ReviewerKind }): this {
    const { doc, at, found } = this.openPrediction(id, n);
    if (found.outcome !== undefined) throw new EditError(`That prediction already has an outcome (${found.outcome}). An outcome is recorded once.`);
    let outcome = result.outcome;
    if (found.sample !== undefined && outcome !== 'void') {
      if (result.found === undefined || !Number.isInteger(result.found) || result.found < 0 || result.found > found.sample) {
        throw new EditError(`That prediction looks at ${found.sample} cases. Say how many agreed (found), from 0 to ${found.sample}.`);
      }
      const derived: Outcome = result.found >= (found.needs as number) ? 'yes' : 'no';
      if (outcome !== undefined && outcome !== derived) throw new EditError(`${result.found} of ${found.sample} with ${found.needs} needed is a ${derived}, not a ${outcome}.`);
      outcome = derived;
    } else if (result.found !== undefined) {
      throw new EditError('found is for a prediction with a sample.');
    }
    if (!outcome || !(OUTCOMES as readonly string[]).includes(outcome)) throw new EditError(`The outcome must be ${OUTCOMES.join(', ')}.`);
    if (outcome !== 'void' && !result.source?.trim()) throw new EditError('An outcome needs a source that others can open.');
    if (outcome === 'void' && !result.note?.trim()) throw new EditError('Withdrawing a prediction needs a note saying why.');
    doc.setIn([...at, 'outcome'], doc.createNode(outcome));
    if (result.found !== undefined && outcome !== 'void') doc.setIn([...at, 'found'], result.found);
    doc.setIn([...at, 'resolved'], today());
    doc.setIn([...at, 'resolved_by'], result.by);
    doc.setIn([...at, 'resolved_kind'], result.kind);
    if (result.source?.trim()) doc.setIn([...at, 'source'], result.source.trim());
    if (result.note?.trim()) doc.setIn([...at, 'note'], result.note.trim());
    return this;
  }

  /** Mark a prediction whose due date has passed with no outcome. The claim cannot stand until it is resolved. */
  markOverdue(id: string, n: number, who: { by: string; kind: ReviewerKind }): this {
    const { doc, at, found } = this.openPrediction(id, n);
    if (found.outcome !== undefined) throw new EditError('That prediction already has an outcome.');
    if (found.overdue) throw new EditError(`That prediction was already marked overdue by ${found.overdue.by}.`);
    if (today() <= found.due) throw new EditError(`That prediction is not overdue: it is due on ${found.due}.`);
    doc.setIn([...at, 'overdue'], doc.createNode({ by: who.by, kind: who.kind, date: today() }));
    return this;
  }

  /** A second name on an outcome: someone else opened the source and agrees with what was recorded. */
  confirmOutcome(id: string, n: number, who: { by: string; kind: ReviewerKind }): this {
    const { doc, at, found } = this.openPrediction(id, n);
    if (found.outcome === undefined) throw new EditError('That prediction has no outcome to confirm yet.');
    if (found.resolvedBy === who.by) throw new EditError(`${who.by} recorded that outcome, so cannot also confirm it.`);
    if (found.confirmed.some((c) => c.by === who.by)) throw new EditError(`${who.by} has already confirmed that outcome.`);
    this.append(doc, [...at, 'confirmed'], { by: who.by, kind: who.kind, date: today() });
    return this;
  }

  /** Attach a piece of evidence to a claim. It does not change the claim's trust label; that stays a judgment. */
  addEvidence(id: string, evidence: Evidence): this {
    if (!(EVIDENCE_KINDS as readonly string[]).includes(evidence.kind)) throw new EditError(`kind must be one of ${EVIDENCE_KINDS.join(', ')}.`);
    if (!(STANCES as readonly string[]).includes(evidence.stance)) throw new EditError(`stance must be ${STANCES.join(' or ')}.`);
    if (evidence.says.trim() === '') throw new EditError('Evidence needs "says": one sentence on what it shows.');
    const path = this.mustLocate(id);
    const doc = this.openClaim(path, id);
    const node = doc.createNode(evidenceToYaml({ date: today(), ...evidence }));
    if (isSeq(doc.getIn(['claims', id, 'evidence'], true))) doc.addIn(['claims', id, 'evidence'], node);
    else doc.setIn(['claims', id, 'evidence'], doc.createNode([evidenceToYaml({ date: today(), ...evidence })]));
    return this;
  }

  reword(id: string, text: string): this {
    if (text.trim() === '') throw new EditError('The new wording is empty.');
    const path = this.mustLocate(id);
    this.openClaim(path, id).setIn(['claims', id, 'text'], text.trim());
    return this;
  }

  /** Add a review. The fingerprint is filled in when the change is saved, so it matches the final wording. */
  private pendingReviews: { id: string; by: string; kind: ReviewerKind; verdict: Verdict; note?: string }[] = [];

  review(id: string, review: { by: string; kind: ReviewerKind; verdict: Verdict; note?: string }): this {
    if (!(VERDICTS as readonly string[]).includes(review.verdict)) throw new EditError(`verdict must be ${VERDICTS.join(' or ')}.`);
    if (!(REVIEWER_KINDS as readonly string[]).includes(review.kind)) throw new EditError(`kind must be ${REVIEWER_KINDS.join(' or ')}.`);
    if (review.by.trim() === '') throw new EditError('A review needs the name of the reviewer.');
    this.mustLocate(id);
    this.pendingReviews.push({ id, ...review });
    return this;
  }

  oppose(kind: 'attack' | 'dispute', from: string, to: string): this {
    this.mustLocate(from);
    this.mustLocate(to);
    const doc = this.touch(this.argumentPath);
    const key = kind === 'attack' ? 'attacks' : 'disputes';
    const pair = this.flowSeq(doc, [from, to]);
    if (isSeq(doc.get(key, true))) doc.addIn([key], pair);
    else doc.set(key, doc.createNode([pair]));
    return this;
  }

  /* ---------- Saving ---------- */

  private sources(): { main: string; library: { name: string; source: string }[] } {
    const text = (path: string): string => this.doc(path).toString(WRITE_OPTIONS);
    const libraryPaths = new Set([...libraryFiles(this.root), ...[...this.dirty].filter((p) => p !== this.argumentPath)]);
    return {
      main: text(this.argumentPath),
      library: [...libraryPaths].sort().map((path) => ({ name: this.rel(path), source: text(path) })),
    };
  }

  private loadNow(): Loaded {
    const { main, library } = this.sources();
    return load(main, library);
  }

  /**
   * Check the result, add a line to the log, and write the files.
   * Throws without writing anything if the change would break the argument.
   */
  save(entry: { by: string; did: string; claim?: string; note?: string }): EditResult {
    let loaded = this.loadNow();
    const fail = (l: Loaded): never => {
      const errors = l.issues.filter((i) => i.severity === 'error').map((i) => i.message);
      throw new EditError(`Not saved, because the result would not load: ${errors.join(' ')}`);
    };
    if (!loaded.ok || !loaded.argument) fail(loaded);

    for (const review of this.pendingReviews) {
      const claim = loaded.argument?.claims.get(review.id);
      const path = this.mustLocate(review.id);
      const doc = this.openClaim(path, review.id);
      const value: Record<string, unknown> = { by: review.by.trim(), kind: review.kind, verdict: review.verdict };
      if (review.note) value['note'] = review.note.trim();
      value['date'] = today();
      if (claim) value['rev'] = claimRev(claim);
      const node = doc.createNode(value);
      if (isSeq(doc.getIn(['claims', review.id, 'reviews'], true))) doc.addIn(['claims', review.id, 'reviews'], node);
      else doc.setIn(['claims', review.id, 'reviews'], doc.createNode([value]));
    }
    this.pendingReviews = [];
    for (const { id, prediction } of this.pendingPredictions) {
      const claim = loaded.argument?.claims.get(id);
      const doc = this.openClaim(this.mustLocate(id), id);
      const full: Prediction = {
        says: prediction.says.trim(),
        how: prediction.how.trim(),
        type: prediction.type,
        p: prediction.p,
        ifTrue: prediction.ifTrue ?? 1,
        by: prediction.by.trim(),
        kind: prediction.kind,
        made: today(),
        due: prediction.due,
        accepted: [],
        confirmed: [],
      };
      if (prediction.ifFalse !== undefined) full.ifFalse = prediction.ifFalse;
      if (prediction.sample !== undefined) Object.assign(full, { sample: prediction.sample, needs: prediction.needs });
      if (claim) {
        full.rev = claimRev(claim);
        // Setting a test on a claim you vouch for is accepting it.
        if (vouchers(claim).includes(full.by)) full.accepted.push({ by: full.by, kind: full.kind, date: today() } satisfies Signed);
      }
      this.append(doc, ['claims', id, 'predictions'], predictionToYaml(full));
    }
    this.pendingPredictions = [];
    loaded = this.loadNow();
    if (!loaded.ok || !loaded.argument) fail(loaded);
    const arg = loaded.argument as NonNullable<Loaded['argument']>;

    const conclusion = analyze(arg).conclusion;
    const { bets, sharp } = resolution(arg);
    const line: Record<string, unknown> = { at: today(), by: entry.by, did: entry.did };
    if (entry.claim) line['claim'] = entry.claim;
    if (entry.note) line['note'] = entry.note.trim();
    Object.assign(line, { verdict: conclusion, bets, sharp });
    const main = this.touch(this.argumentPath);
    if (isSeq(main.get('log', true))) main.addIn(['log'], main.createNode(line));
    else main.set('log', main.createNode([line]));

    const written: string[] = [];
    for (const path of this.dirty) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, this.doc(path).toString(WRITE_OPTIONS));
      written.push(this.rel(path));
    }
    this.dirty.clear();
    return { written, conclusion, bets, sharp, warnings: loaded.issues.filter((i) => i.severity === 'warning') };
  }
}
