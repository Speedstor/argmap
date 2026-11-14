import { Document, isScalar, isSeq, visit } from 'yaml';
import { prettyLabel } from './parse.ts';
import type { Argument } from './types.ts';

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
      out['bet'] = bet;
    }
    if (claim.note) out['note'] = claim.note;
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
