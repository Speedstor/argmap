import { Document, isScalar, isSeq, visit } from 'yaml';
import { prettyLabel } from './parse.ts';
import type { Argument, Evidence, Prediction, Signed } from './types.ts';

/** Evidence as it is written in a file: snake_case keys, defaults left out. */
export function evidenceToYaml(e: Evidence): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: e.kind };
  if (e.stance === 'against') out['stance'] = 'against';
  out['says'] = e.says;
  for (const key of ['value', 'unit', 'sample', 'period', 'witness'] as const) if (e[key] !== undefined) out[key] = e[key];
  if (e.firstHand !== undefined) out['first_hand'] = e.firstHand;
  if (e.peerReviewed !== undefined) out['peer_reviewed'] = e.peerReviewed;
  for (const key of ['source', 'origin', 'by', 'date'] as const) if (e[key] !== undefined) out[key] = e[key];
  return out;
}

const signedToYaml = (s: Signed): Record<string, unknown> => ({ by: s.by, kind: s.kind, ...(s.date ? { date: s.date } : {}) });

/** A prediction as it is written in a file: the fixed part first, then what was added later. */
export function predictionToYaml(p: Prediction): Record<string, unknown> {
  const out: Record<string, unknown> = { says: p.says, how: p.how, type: p.type, p: p.p };
  if (p.ifTrue !== 1) out['if_true'] = p.ifTrue;
  if (p.ifFalse !== undefined) out['if_false'] = p.ifFalse;
  if (p.sample !== undefined) Object.assign(out, { sample: p.sample, needs: p.needs });
  Object.assign(out, { by: p.by, kind: p.kind, made: p.made, due: p.due });
  if (p.rev !== undefined) out['rev'] = p.rev;
  if (p.accepted.length > 0) out['accepted'] = p.accepted.map(signedToYaml);
  if (p.overdue) out['overdue'] = signedToYaml(p.overdue);
  if (p.outcome !== undefined) {
    out['outcome'] = p.outcome;
    if (p.found !== undefined) out['found'] = p.found;
    if (p.resolved) out['resolved'] = p.resolved;
    out['resolved_by'] = p.resolvedBy;
    out['resolved_kind'] = p.resolvedKind;
    if (p.source) out['source'] = p.source;
    if (p.note) out['note'] = p.note;
  }
  if (p.confirmed.length > 0) out['confirmed'] = p.confirmed.map(signedToYaml);
  return out;
}

/**
 * Write an assembled argument as one self-contained file: the argument's own
 * claims plus everything it drew from the library. Comments are not kept.
 */
export function toYaml(arg: Argument): string {
  const terms: Record<string, unknown> = {};
  for (const term of arg.terms.values()) {
    terms[term.key] = term.aliases.length > 0 ? { definition: term.definition, aliases: term.aliases } : term.definition;
  }
  const claims: Record<string, unknown> = {};
  for (const claim of arg.claims.values()) {
    const out: Record<string, unknown> = { text: claim.text };
    if (claim.label !== prettyLabel(claim.id)) out['label'] = claim.label;
    if (claim.because.length === 1) out['because'] = claim.because[0];
    else if (claim.because.length > 1) out['because'] = claim.because;
    if (claim.bet?.explicit) {
      const bet: Record<string, unknown> = { trust: claim.bet.trust };
      if (claim.bet.cost !== 'medium') bet['cost'] = claim.bet.cost;
      if (claim.bet.note) bet['note'] = claim.bet.note;
      if (claim.bet.by) bet['by'] = claim.bet.by;
      out['bet'] = bet;
    }
    if (claim.note) out['note'] = claim.note;
    if (claim.evidence.length > 0) out['evidence'] = claim.evidence.map(evidenceToYaml);
    if (claim.predictions.length > 0) out['predictions'] = claim.predictions.map(predictionToYaml);
    if (claim.reviews.length > 0) out['reviews'] = claim.reviews;
    claims[claim.id] = out;
  }
  const mutual = (a: string, b: string): boolean => arg.disputes.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  const data: Record<string, unknown> = { argmap: 1, title: arg.title, conclusion: arg.conclusion };
  if (arg.terms.size > 0) data['terms'] = terms;
  data['claims'] = claims;
  const attacks = arg.attacks.filter((a) => !mutual(a.from, a.to)).map((a) => [a.from, a.to]);
  if (attacks.length > 0) data['attacks'] = attacks;
  if (arg.disputes.length > 0) data['disputes'] = arg.disputes;
  if (arg.log.length > 0) data['log'] = arg.log;

  const doc = new Document(data);
  visit(doc, {
    Seq(_key, node) {
      if (isSeq(node) && node.items.every((item) => isScalar(item))) node.flow = true;
    },
  });
  return doc.toString({ lineWidth: 100 });
}
