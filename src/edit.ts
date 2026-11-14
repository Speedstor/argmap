import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { Document } from 'yaml';
import { analyze, claimRev, load, resolution, REVIEWER_KINDS, TRUST_LEVELS, VERDICTS } from './index.ts';
import type { Cost, Issue, Loaded, ReviewerKind, Status, Trust, Verdict } from './index.ts';
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

  /** Record the result of checking a bet. */
  setBet(id: string, bet: { trust: Trust; note?: string; cost?: Cost }): this {
    if (!(TRUST_LEVELS as readonly string[]).includes(bet.trust)) throw new EditError(`trust must be one of ${TRUST_LEVELS.join(', ')}.`);
    const path = this.mustLocate(id);
    const doc = this.openClaim(path, id);
    if (doc.hasIn(['claims', id, 'because'])) throw new EditError(`"${id}" has support, so it is not a bet.`);
    const value: Record<string, unknown> = { trust: bet.trust };
    const cost = bet.cost ?? doc.getIn(['claims', id, 'bet', 'cost']);
    const note = bet.note ?? doc.getIn(['claims', id, 'bet', 'note']);
    if (typeof cost === 'string' && cost !== 'medium') value['cost'] = cost;
    if (typeof note === 'string' && note.trim() !== '') value['note'] = note.trim();
    doc.setIn(['claims', id, 'bet'], doc.createNode(value));
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
