import { attackersOf } from '../src/index.ts';
import type { Argument } from '../src/index.ts';

export interface Box {
  id: string;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  boxes: Map<string, Box>;
  /** Claim ids per column, top to bottom. */
  columns: string[][];
  width: number;
  height: number;
  gapX: number;
}

const NODE_H = 56;
const GAP_Y = 16;
const MIN_W = 96;
const MAX_W = 200;

/**
 * Left-to-right layers: the conclusion on the left, bets on the right.
 * A supporter sits at least one column right of what it supports; an attacker
 * shares its target's column and is placed directly below it.
 */
export function layout(arg: Argument, available: number): Layout {
  const attackers = attackersOf(arg);
  const cap = arg.claims.size;
  const col = new Map<string, number>();
  if (arg.claims.has(arg.conclusion)) col.set(arg.conclusion, 0);

  let moved = true;
  for (let pass = 0; moved && pass <= cap; pass++) {
    moved = false;
    const raise = (id: string, to: number): void => {
      const next = Math.min(to, cap);
      if ((col.get(id) ?? -1) < next) {
        col.set(id, next);
        moved = true;
      }
    };
    for (const claim of arg.claims.values()) {
      const c = col.get(claim.id);
      if (c === undefined) continue;
      for (const group of claim.because) for (const m of group) if (arg.claims.has(m)) raise(m, c + 1);
      for (const a of attackers.get(claim.id) ?? []) raise(a, c);
    }
  }
  const deepest = Math.max(0, ...col.values());
  for (const id of arg.claims.keys()) if (!col.has(id)) col.set(id, deepest + 1);

  // Depth-first order keeps each claim's support and objections next to it.
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id) || !arg.claims.has(id)) return;
    seen.add(id);
    order.push(id);
    for (const group of arg.claims.get(id)?.because ?? []) for (const m of group) visit(m);
    for (const a of attackers.get(id) ?? []) visit(a);
  };
  visit(arg.conclusion);
  for (const id of arg.claims.keys()) visit(id);

  const count = Math.max(...col.values()) + 1;
  const columns: string[][] = Array.from({ length: count }, () => []);
  for (const id of order) columns[col.get(id) as number]?.push(id);

  const gapX = available < 520 ? 22 : 44;
  const w = Math.max(MIN_W, Math.min(MAX_W, Math.floor((available - gapX * (count - 1)) / count)));
  const boxes = new Map<string, Box>();
  let height = 0;

  // Right to left, so each claim can centre itself on the claims it rests on.
  for (let c = count - 1; c >= 0; c--) {
    let bottom = -GAP_Y;
    for (const id of columns[c] ?? []) {
      const kids = (arg.claims.get(id)?.because.flat() ?? [])
        .map((m) => boxes.get(m))
        .filter((b): b is Box => b !== undefined);
      let y = bottom + GAP_Y;
      if (kids.length > 0) {
        const centre = kids.reduce((sum, b) => sum + b.y + b.h / 2, 0) / kids.length;
        y = Math.max(y, Math.round(centre - NODE_H / 2));
      }
      boxes.set(id, { id, col: c, x: c * (w + gapX), y, w, h: NODE_H });
      bottom = y + NODE_H;
    }
    height = Math.max(height, bottom);
  }

  return { boxes, columns, width: count * w + (count - 1) * gapX, height, gapX };
}
