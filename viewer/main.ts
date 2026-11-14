import { analyze, attackersOf, load, nextSteps, plainText, reason, resolution, reviewSummaries, segments, TRUST_LEVELS } from '../src/index.ts';
import type { Analysis, Argument, Claim, Issue, Loaded, Resolution, ReviewState, ReviewSummary, Status, StepKind, Trust } from '../src/index.ts';
import { layout } from './layout.ts';
import type { Box } from './layout.ts';

interface Note {
  text: string;
  related: boolean;
  by?: string;
  date?: string;
}

/** Notes from the argument's notepads, embedded when the page was built. */
interface Notes {
  notepads: { path: string }[];
  byClaim: Record<string, Note[]>;
  general: Note[];
  related: Note[];
  url?: string;
}

declare global {
  interface Window {
    __ARGMAP_SOURCE__?: string;
    __ARGMAP_IDEAS__?: Notes | null;
  }
}

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') el.addEventListener(key, value);
    else if (value === true) el.setAttribute(key, '');
    else if (value !== false) el.setAttribute(key, value);
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';
function s(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

const STATUS_WORD: Record<Status, string> = { stands: 'Stands', falls: 'Falls', contested: 'Contested' };
const STATUS_MARK: Record<Status, string> = { stands: '✓', falls: '✕', contested: '?' };
const TRUST_WORD: Record<Trust, string> = {
  observed: 'Seen first-hand',
  corroborated: 'Independent sources agree',
  'track-record': 'Has held up before',
  assumed: 'Just assumed',
};

const state: {
  source: string;
  loaded: Loaded;
  knocked: Set<string>;
  selected: string;
  loadError: string;
} = { source: '', loaded: { issues: [], ok: false }, knocked: new Set(), selected: '', loadError: '' };

const root = document.getElementById('app') as HTMLElement;

function setSource(source: string): void {
  state.source = source;
  state.loaded = load(source);
  state.knocked = new Set();
  state.selected = state.loaded.argument?.conclusion ?? '';
  document.title = state.loaded.argument?.title ?? 'argmap';
}

function toggle(id: string): void {
  if (state.knocked.has(id)) state.knocked.delete(id);
  else state.knocked.add(id);
  render();
}

function select(id: string): void {
  state.selected = id;
  render();
}

function pill(status: Status, big = false): HTMLElement {
  return h(
    'span',
    { class: `pill${big ? ' pill-big' : ''}`, 'data-status': status },
    h('span', { class: 'pill-mark', 'aria-hidden': 'true' }, STATUS_MARK[status]),
    STATUS_WORD[status],
  );
}

const REVIEW_WORD: Record<ReviewState, string> = {
  unreviewed: 'Not reviewed',
  confirmed: 'Confirmed by review',
  rejected: 'Rejected by review',
  split: 'Reviewers disagree',
};

function reviewTag(state: ReviewState): HTMLElement {
  return h('span', { class: 'tag review-tag', 'data-review': state }, REVIEW_WORD[state]);
}

/** Per-render facts that several sections share. */
interface Extra {
  res: Resolution;
  reviews: Map<string, ReviewSummary>;
}

function pips(trust: Trust): HTMLElement {
  const filled = TRUST_LEVELS.length - TRUST_LEVELS.indexOf(trust);
  const el = h('span', { class: 'pips', 'data-trust': trust, role: 'img', 'aria-label': `Trust: ${TRUST_WORD[trust]}` });
  for (let i = 0; i < TRUST_LEVELS.length; i++) el.append(h('i', { class: i < filled ? 'on' : '' }));
  return el;
}

function claimText(arg: Argument, claim: Claim): HTMLElement {
  const el = h('span', { class: 'claim-text' });
  for (const seg of segments(claim.text)) {
    if (seg.kind === 'text') el.append(seg.value);
    else el.append(h('span', { class: 'term', title: arg.terms.get(seg.key)?.definition ?? '' }, seg.shown));
  }
  return el;
}

function chip(arg: Argument, a: Analysis, id: string): HTMLElement {
  return h(
    'button',
    { class: 'chip', type: 'button', 'data-status': a.statuses.get(id) ?? 'contested', click: () => select(id) },
    h('span', { 'aria-hidden': 'true' }, STATUS_MARK[a.statuses.get(id) ?? 'contested']),
    arg.claims.get(id)?.label ?? id,
  );
}

/* ---------- Verdict ---------- */

function verdictLine(arg: Argument, a: Analysis): string {
  const t = a.cruxes.tally;
  if (a.conclusion === 'contested' && t) {
    const n = a.cruxes.cruxes.length;
    return `It hinges on ${n} open dispute${n > 1 ? 's' : ''}. It stands in ${t.stands} of the ${t.total} ways ${
      n > 1 ? 'they' : 'it'
    } could be settled, and falls in ${t.falls}.`;
  }
  if (a.conclusion === 'stands') {
    const decisive = a.bets.filter((b) => b.decisive).length;
    return decisive > 0
      ? `Given the bets as written. ${decisive} of its ${a.bets.length} bets would change this if they failed alone.`
      : `Given the bets as written. No single bet failing would change this.`;
  }
  return reason(arg, a.statuses, state.knocked, arg.conclusion);
}

function renderVerdict(arg: Argument, a: Analysis, x: Extra): HTMLElement {
  const conclusion = arg.claims.get(arg.conclusion) as Claim;
  return h(
    'header',
    { class: 'verdict' },
    h('p', { class: 'eyebrow' }, 'argmap'),
    h('h1', {}, arg.title),
    h(
      'div',
      { class: 'verdict-body', 'data-status': a.conclusion },
      h('div', { class: 'verdict-top' }, pill(a.conclusion, true), h('span', { class: 'verdict-label' }, 'the conclusion')),
      h('p', { class: 'verdict-claim' }, claimText(arg, conclusion)),
      h('p', { class: 'verdict-why' }, verdictLine(arg, a)),
    ),
    h(
      'dl',
      { class: 'stats' },
      h('div', {}, h('dt', {}, 'Resolution'), h('dd', {}, `${x.res.sharp} of ${x.res.bets} bets specific enough to check`)),
      h(
        'div',
        {},
        h('dt', {}, 'Review'),
        h('dd', {}, `${[...x.reviews.values()].filter((r) => r.state !== 'unreviewed').length} of ${arg.claims.size} claims reviewed`),
      ),
      h('div', {}, h('dt', {}, 'Rounds'), h('dd', {}, String(arg.log.length))),
    ),
  );
}

function renderBar(arg: Argument, a: Analysis): HTMLElement {
  const n = state.knocked.size;
  return h(
    'div',
    { class: 'bar' },
    pill(a.conclusion),
    h('span', { class: 'bar-text' }, `${n} knocked out`),
    h(
      'button',
      {
        class: 'btn btn-quiet',
        type: 'button',
        disabled: n === 0,
        click: () => {
          state.knocked.clear();
          render();
        },
      },
      'Restore all',
    ),
  );
}

/* ---------- Graph ---------- */

function renderGraph(arg: Argument, a: Analysis, available: number): HTMLElement {
  const lay = layout(arg, available);
  const pad = 6;
  const svg = s('svg', {
    class: 'edges',
    width: lay.width + pad * 2,
    height: lay.height + pad * 2,
    viewBox: `${-pad} ${-pad} ${lay.width + pad * 2} ${lay.height + pad * 2}`,
    'aria-hidden': 'true',
  });
  const defs = s('defs', {});
  for (const kind of ['stands', 'falls', 'contested', 'attack']) {
    const marker = s('marker', {
      id: `arrow-${kind}`,
      viewBox: '0 0 8 8',
      refX: 7,
      refY: 4,
      markerWidth: 7,
      markerHeight: 7,
      orient: 'auto-start-reverse',
    });
    marker.append(s('path', { d: 'M0 0.5 L8 4 L0 7.5 Z', class: `head head-${kind}` }));
    defs.append(marker);
  }
  svg.append(defs);

  const status = (id: string): Status => a.statuses.get(id) ?? 'contested';
  const box = (id: string): Box | undefined => lay.boxes.get(id);

  // Support: members of one group meet at a junction, then one arrow enters the claim.
  for (const claim of arg.claims.values()) {
    const target = box(claim.id);
    if (!target) continue;
    const groups = claim.because;
    groups.forEach((group, i) => {
      const offset = (i - (groups.length - 1) / 2) * 12;
      const jx = target.x + target.w + lay.gapX * 0.42;
      const jy = target.y + target.h / 2 + offset;
      const groupStatus: Status = group.some((m) => status(m) === 'falls')
        ? 'falls'
        : group.every((m) => status(m) === 'stands')
          ? 'stands'
          : 'contested';
      for (const m of group) {
        const from = box(m);
        if (!from) continue;
        const fy = from.y + from.h / 2;
        const bend = Math.max(8, (from.x - jx) * 0.5);
        svg.append(
          s('path', {
            d: `M${from.x} ${fy} C${from.x - bend} ${fy} ${jx + bend} ${jy} ${jx} ${jy}`,
            class: `edge edge-${status(m)}`,
          }),
        );
      }
      svg.append(
        s('path', {
          d: `M${jx} ${jy} L${target.x + target.w + 1.5} ${jy}`,
          class: `edge edge-${groupStatus}`,
          'marker-end': `url(#arrow-${groupStatus})`,
        }),
      );
      if (group.length > 1) svg.append(s('circle', { cx: jx, cy: jy, r: 2.6, class: `joint joint-${groupStatus}` }));
    });
  }

  // Opposition: one-way attacks get one arrowhead, disputes get two.
  const drawn = new Set<string>();
  for (const { from, to } of arg.attacks) {
    const key = [from, to].sort().join('\u0000');
    if (drawn.has(key)) continue;
    drawn.add(key);
    const mutual = arg.attacks.some((x) => x.from === to && x.to === from);
    const fb = box(from);
    const tb = box(to);
    if (!fb || !tb) continue;
    let d: string;
    if (fb.col === tb.col) {
      const between = (lay.columns[fb.col] ?? []).some((id) => {
        const b = box(id);
        return b !== undefined && b.y > Math.min(fb.y, tb.y) && b.y < Math.max(fb.y, tb.y);
      });
      if (!between) {
        const x = fb.x + 16;
        d = fb.y > tb.y ? `M${x} ${fb.y} L${x} ${tb.y + tb.h + 1.5}` : `M${x} ${fb.y + fb.h} L${x} ${tb.y - 1.5}`;
      } else {
        const fy = fb.y + fb.h / 2;
        const ty = tb.y + tb.h / 2;
        d = `M${fb.x} ${fy} C${fb.x - 18} ${fy} ${tb.x - 18} ${ty} ${tb.x - 1.5} ${ty}`;
      }
    } else {
      const fy = fb.y + fb.h / 2;
      const ty = tb.y + tb.h / 2;
      const [sx, ex] = fb.x > tb.x ? [fb.x, tb.x + tb.w + 1.5] : [fb.x + fb.w, tb.x - 1.5];
      const mid = (sx + ex) / 2;
      d = `M${sx} ${fy} C${mid} ${fy} ${mid} ${ty} ${ex} ${ty}`;
    }
    const live = status(from) !== 'falls' || (mutual && status(to) !== 'falls');
    const attrs: Record<string, string> = { d, class: `edge edge-attack${live ? '' : ' edge-spent'}`, 'marker-end': 'url(#arrow-attack)' };
    if (mutual) attrs['marker-start'] = 'url(#arrow-attack)';
    svg.append(s('path', attrs));
  }

  const nodes = h('div', { class: 'nodes' });
  nodes.style.width = `${lay.width}px`;
  nodes.style.height = `${lay.height}px`;
  for (const claim of arg.claims.values()) {
    const b = box(claim.id);
    if (!b) continue;
    const st = status(claim.id);
    const node = h(
      'button',
      {
        class: 'node',
        type: 'button',
        'data-status': st,
        'data-side': a.sides.get(claim.id) ?? 'none',
        'aria-pressed': state.selected === claim.id ? 'true' : 'false',
        'aria-label': `${claim.label}: ${STATUS_WORD[st]}. ${plainText(claim.text)}`,
        click: () => select(claim.id),
      },
      h('span', { class: 'node-mark', 'aria-hidden': 'true' }, state.knocked.has(claim.id) ? '⊘' : STATUS_MARK[st]),
      h('span', { class: 'node-label' }, claim.label),
      claim.bet ? pips(claim.bet.trust) : null,
    );
    if (claim.id === arg.conclusion) node.classList.add('node-root');
    if (state.knocked.has(claim.id)) node.classList.add('node-knocked');
    node.style.left = `${b.x}px`;
    node.style.top = `${b.y}px`;
    node.style.width = `${b.w}px`;
    node.style.height = `${b.h}px`;
    nodes.append(node);
  }

  const canvas = h('div', { class: 'canvas' }, svg as unknown as Node, nodes);
  canvas.style.width = `${lay.width + pad * 2}px`;
  canvas.style.height = `${lay.height + pad * 2}px`;
  return h('div', { class: 'graph', id: 'graph-scroll' }, canvas);
}

function renderLegend(): HTMLElement {
  const item = (cls: string, text: string): HTMLElement => h('span', { class: 'legend-item' }, h('i', { class: `swatch ${cls}` }), text);
  return h(
    'div',
    { class: 'legend' },
    item('sw-stands', 'stands'),
    item('sw-contested', 'contested'),
    item('sw-falls', 'falls'),
    item('sw-support', 'supports'),
    item('sw-attack', 'opposes'),
    h('span', { class: 'legend-item' }, pips('corroborated'), 'trust in a bet'),
  );
}

/* ---------- Detail ---------- */

function renderDetail(arg: Argument, a: Analysis, x: Extra): HTMLElement {
  const claim = arg.claims.get(state.selected) ?? (arg.claims.get(arg.conclusion) as Claim);
  const st = a.statuses.get(claim.id) ?? 'contested';
  const side = a.sides.get(claim.id);
  const sideWord =
    claim.id === arg.conclusion
      ? 'the conclusion'
      : side === 'for'
        ? 'supports the conclusion'
        : side === 'against'
          ? 'counts against the conclusion'
          : side === 'both'
            ? 'cuts both ways'
            : 'no bearing on the conclusion';
  const knocked = state.knocked.has(claim.id);
  const against = attackersOf(arg).get(claim.id) ?? [];
  const bet = a.bets.find((b) => b.id === claim.id);

  const card = h(
    'section',
    { class: 'detail', 'data-status': st, 'aria-live': 'polite' },
    h('div', { class: 'detail-top' }, pill(st), h('span', { class: 'detail-side' }, sideWord), h('code', { class: 'detail-id' }, claim.id)),
    h('p', { class: 'detail-text' }, claimText(arg, claim)),
    h('p', { class: 'detail-why' }, reason(arg, a.statuses, state.knocked, claim.id)),
  );

  if (claim.bet && bet) {
    const effect = knocked
      ? 'You have knocked this out.'
      : bet.decisive
        ? `If this fails alone, the conclusion becomes ${bet.conclusionIfFails}.`
        : 'If this fails alone, the conclusion does not change.';
    card.append(
      h(
        'div',
        { class: 'detail-bet' },
        h('div', { class: 'bet-trust' }, pips(claim.bet.trust), h('strong', {}, TRUST_WORD[claim.bet.trust])),
        claim.bet.note ? h('p', { class: 'bet-note' }, claim.bet.note) : null,
        h('p', { class: 'bet-effect' }, effect),
      ),
    );
  }
  if (claim.note) card.append(h('p', { class: 'bet-note' }, claim.note));

  if (claim.evidence.length > 0) {
    const list = h('ul', { class: 'evidence' });
    for (const e of claim.evidence) {
      const figure = e.value !== undefined ? `${e.value}${e.unit ? ` ${e.unit}` : ''}` : '';
      const context = [e.sample, e.period].filter(Boolean).join(', ');
      const facts = [
        figure && `${figure}${context ? ` (${context})` : ''}`,
        e.witness && `${e.firstHand ? 'First-hand: ' : 'Reported by '}${e.witness}`,
        e.peerReviewed === true && 'peer reviewed',
        e.peerReviewed === false && 'not peer reviewed',
      ].filter((f): f is string => typeof f === 'string' && f !== '');
      const isUrl = e.source !== undefined && /^https?:\/\//.test(e.source);
      list.append(
        h(
          'li',
          { class: 'evidence-item', 'data-stance': e.stance },
          h('span', { class: 'evidence-head' }, h('span', { class: 'tag' }, e.kind), h('strong', {}, e.stance === 'for' ? 'for' : 'against')),
          h('span', { class: 'evidence-says' }, e.says),
          facts.length > 0 ? h('span', { class: 'evidence-facts' }, facts.join(' · ')) : null,
          e.source ? (isUrl ? h('a', { class: 'evidence-source', href: e.source, rel: 'noopener' }, e.source) : h('span', { class: 'evidence-source' }, e.source)) : null,
          e.by ? h('span', { class: 'review-by' }, `added by ${e.by}${e.date ? `, ${e.date}` : ''}`) : null,
        ),
      );
    }
    card.append(h('div', { class: 'detail-evidence' }, h('strong', {}, `Evidence (${claim.evidence.length})`), list));
  }

  const flags = x.res.flags.get(claim.id) ?? [];
  if (flags.length > 0) {
    const list = h('ul', { class: 'sharpen' });
    for (const flag of flags) list.append(h('li', {}, flag.message));
    card.append(h('div', { class: 'detail-sharpen' }, h('strong', {}, 'Could be sharper'), list));
  }

  const review = x.reviews.get(claim.id);
  if (review) {
    const box = h('div', { class: 'detail-reviews' }, h('div', { class: 'reviews-head' }, reviewTag(review.state)));
    const line = (r: ReviewSummary['current'][number], stale: boolean): HTMLElement =>
      h(
        'li',
        { class: `review${stale ? ' review-stale' : ''}`, 'data-verdict': r.verdict },
        h('span', { class: 'review-verdict' }, r.verdict === 'confirm' ? '✓ confirms' : '✕ rejects'),
        h('span', { class: 'review-by' }, `${r.by} (${r.kind === 'ai' ? 'AI' : 'person'})${r.date ? `, ${r.date}` : ''}${stale ? ', of an earlier wording' : ''}`),
        r.note ? h('span', { class: 'review-note' }, r.note) : null,
      );
    if (review.current.length + review.stale.length > 0) {
      const list = h('ul', { class: 'reviews' });
      for (const r of review.current) list.append(line(r, false));
      for (const r of review.stale) list.append(line(r, true));
      box.append(list);
    }
    if (review.state === 'split') box.append(h('p', { class: 'bet-note' }, 'Every reviewer counts the same, so this waits for adjudication.'));
    card.append(box);
  }
  if (claim.origin !== '') card.append(h('p', { class: 'origin' }, 'From the shared library: ', h('code', {}, claim.origin)));

  const notes = window.__ARGMAP_IDEAS__?.byClaim[claim.id] ?? [];
  if (notes.length > 0) card.append(h('div', { class: 'detail-notes' }, h('strong', {}, `Notes on this claim (${notes.length})`), noteList(notes)));

  if (claim.because.length > 0) {
    const rests = h('div', { class: 'detail-links' }, h('span', { class: 'links-label' }, 'Rests on'));
    claim.because.forEach((group, i) => {
      if (i > 0) rests.append(h('span', { class: 'links-or' }, 'or'));
      for (const m of group) rests.append(chip(arg, a, m));
    });
    card.append(rests);
  }
  if (against.length > 0) {
    const opp = h('div', { class: 'detail-links' }, h('span', { class: 'links-label' }, 'Opposed by'));
    for (const id of against) opp.append(chip(arg, a, id));
    card.append(opp);
  }

  card.append(
    h(
      'div',
      { class: 'detail-actions' },
      h(
        'button',
        { class: `btn ${knocked ? '' : 'btn-primary'}`, type: 'button', click: () => toggle(claim.id) },
        knocked ? 'Restore this claim' : 'Knock this out',
      ),
      h('span', { class: 'hint' }, knocked ? 'Puts it back as written.' : 'Treats it as false and recomputes everything.'),
    ),
  );
  return card;
}

/* ---------- Disputes ---------- */

function renderDisputes(arg: Argument, a: Analysis): HTMLElement | null {
  if (arg.disputes.length === 0) return null;
  const section = h(
    'section',
    { class: 'block' },
    h('h2', {}, 'Open disputes'),
    h('p', { class: 'lede' }, 'Each pair attacks the other, so the map cannot settle them. Pick a side to see what follows.'),
  );
  const list = h('div', { class: 'disputes' });
  for (const [x, y] of arg.disputes) {
    const crux = a.cruxes.cruxes.find((c) => c.a === x && c.b === y);
    const sideCard = (id: string, other: string, outcome: Status | undefined): HTMLElement => {
      const claim = arg.claims.get(id) as Claim;
      const st = a.statuses.get(id) ?? 'contested';
      const chosen = state.knocked.has(other) && !state.knocked.has(id);
      return h(
        'div',
        { class: `side${chosen ? ' side-chosen' : ''}`, 'data-status': st },
        h('div', { class: 'side-top' }, pill(st), h('button', { class: 'linkish', type: 'button', click: () => select(id) }, claim.label)),
        h('p', { class: 'side-text' }, claimText(arg, claim)),
        outcome ? h('p', { class: 'side-outcome' }, 'If this prevails, the conclusion ', h('strong', { 'data-status': outcome }, outcome === 'contested' ? 'stays contested' : outcome), '.') : null,
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            click: () => {
              if (chosen) state.knocked.delete(other);
              else {
                state.knocked.add(other);
                state.knocked.delete(id);
              }
              render();
            },
          },
          chosen ? 'Undo' : 'Side with this',
        ),
      );
    };
    list.append(
      h(
        'div',
        { class: 'dispute' },
        sideCard(x, y, crux?.ifAPrevails),
        h('span', { class: 'versus', 'aria-hidden': 'true' }, 'vs'),
        sideCard(y, x, crux?.ifBPrevails),
      ),
    );
  }
  section.append(list);
  const only = a.cruxes.standsOnlyIf;
  if (a.cruxes.tally && only.length > 0 && a.conclusion === 'contested') {
    section.append(
      h('p', { class: 'note' }, `The conclusion stands only if all of these prevail: ${only.map((id) => arg.claims.get(id)?.label ?? id).join(', ')}.`),
    );
  }
  return section;
}

/* ---------- Bets ---------- */

function renderBets(arg: Argument, a: Analysis, x: Extra): HTMLElement {
  const section = h(
    'section',
    { class: 'block' },
    h('h2', {}, 'What you are trusting'),
    h(
      'p',
      { class: 'lede' },
      `${a.bets.length} bets hold this map up. Most exposed first: the ones whose failure changes the conclusion, then the least checked.`,
    ),
  );
  const list = h('ul', { class: 'bets' });
  for (const b of a.bets) {
    const claim = arg.claims.get(b.id) as Claim;
    const knocked = state.knocked.has(b.id);
    list.append(
      h(
        'li',
        { class: `bet${b.decisive ? ' bet-decisive' : ''}`, 'data-status': b.status },
        h(
          'div',
          { class: 'bet-main' },
          h('div', { class: 'bet-head' }, pips(b.trust), h('button', { class: 'linkish', type: 'button', click: () => select(b.id) }, claim.label)),
          h('p', { class: 'bet-text' }, plainText(claim.text)),
          h(
            'p',
            { class: 'bet-meta' },
            h('span', { class: 'tag', 'data-trust': b.trust }, b.trust),
            h('span', { class: 'tag' }, b.side === 'against' ? 'objection' : b.side === 'for' ? 'support' : b.side),
            x.res.flags.has(b.id) ? h('span', { class: 'tag tag-soft' }, 'hand-wavy') : null,
            x.reviews.get(b.id)?.state !== 'unreviewed' ? reviewTag(x.reviews.get(b.id)?.state ?? 'unreviewed') : null,
            knocked
              ? h('span', { class: 'effect' }, 'knocked out')
              : b.decisive
                ? h('span', { class: 'effect effect-hot' }, `fails → conclusion ${b.conclusionIfFails}`)
                : h('span', { class: 'effect' }, 'fails → conclusion unchanged'),
          ),
        ),
        h('button', { class: 'btn btn-small', type: 'button', click: () => toggle(b.id) }, knocked ? 'Restore' : 'Knock out'),
      ),
    );
  }
  section.append(list);
  return section;
}

/* ---------- Next steps and rounds ---------- */

const STEP_WORD: Record<StepKind, string> = {
  adjudicate: 'Adjudicate',
  answer: 'Answer',
  refine: 'Sharpen',
  check: 'Check',
  settle: 'Settle',
  review: 'Review',
};

function renderSteps(arg: Argument, a: Analysis): HTMLElement {
  const steps = nextSteps(arg, a);
  const section = h(
    'section',
    { class: 'block' },
    h('h2', {}, 'What to do next'),
    h(
      'p',
      { class: 'lede' },
      steps.length === 0
        ? 'Nothing outstanding.'
        : `${steps.length} steps outstanding. The first few, most valuable first. Each round of work is recorded below.`,
    ),
  );
  if (steps.length === 0) return section;
  const list = h('ol', { class: 'steps' });
  for (const step of steps.slice(0, 6)) {
    const names = h('span', { class: 'step-claims' });
    step.claims.forEach((id, i) => {
      if (i > 0) names.append(' vs ');
      names.append(h('button', { class: 'linkish', type: 'button', click: () => select(id) }, arg.claims.get(id)?.label ?? id));
    });
    list.append(
      h(
        'li',
        { class: 'step' },
        h(
          'div',
          { class: 'step-head' },
          h('span', { class: 'step-kind', 'data-kind': step.kind }, STEP_WORD[step.kind]),
          names,
          step.decisive ? h('span', { class: 'effect effect-hot' }, 'can change the conclusion') : null,
        ),
        h('p', { class: 'bet-text' }, step.why),
      ),
    );
  }
  section.append(list);
  return section;
}

function renderRounds(arg: Argument): HTMLElement | null {
  if (arg.log.length === 0) return null;
  const list = h('ol', { class: 'rounds' });
  arg.log.forEach((entry, i) => {
    const subject = entry.claim ? (arg.claims.get(entry.claim)?.label ?? entry.claim) : '';
    list.append(
      h(
        'li',
        { class: 'round' },
        h('span', { class: 'round-n' }, String(i + 1)),
        h(
          'div',
          { class: 'round-main' },
          h('p', { class: 'round-what' }, h('strong', {}, entry.did), subject ? ` ${subject}` : ''),
          entry.note ? h('p', { class: 'bet-text' }, entry.note) : null,
          h(
            'p',
            { class: 'bet-meta' },
            entry.verdict ? pill(entry.verdict) : null,
            entry.bets !== undefined ? h('span', { class: 'effect' }, `${entry.sharp ?? 0} of ${entry.bets} bets specific`) : null,
            h('span', { class: 'effect' }, [entry.by, entry.at].filter(Boolean).join(', ')),
          ),
        ),
      ),
    );
  });
  // Newest work matters most on a small screen: show the last few, fold the rest away.
  const RECENT = 6;
  const items = [...list.children];
  const section = h(
    'section',
    { class: 'block' },
    h('h2', {}, 'Rounds so far'),
    h('p', { class: 'lede' }, `${items.length} changes to the argument, each with the verdict and resolution it left behind. Newest last.`),
  );
  if (items.length > RECENT) {
    const earlier = h('ol', { class: 'rounds' });
    earlier.append(...items.slice(0, items.length - RECENT));
    section.append(h('details', { class: 'earlier' }, h('summary', {}, `Show the ${items.length - RECENT} earlier rounds`), earlier));
  }
  section.append(list);
  return section;
}

/* ---------- Notepad ---------- */

function noteList(notes: Note[]): HTMLElement {
  const list = h('ul', { class: 'notes' });
  for (const note of notes) {
    list.append(
      h(
        'li',
        { class: 'note-item' },
        note.text,
        note.by ? h('span', { class: 'review-by' }, ` ${note.by}${note.date ? `, ${note.date}` : ''}`) : null,
      ),
    );
  }
  return list;
}

function renderNotepad(): HTMLElement {
  const ideas = window.__ARGMAP_IDEAS__;
  const section = h('section', { class: 'block' }, h('h2', {}, 'Notepad'));
  if (!ideas || ideas.notepads.length === 0) {
    section.append(h('p', { class: 'lede' }, 'No notepad yet. A notepad is a page for loose thinking about an argument or a claim, and is only created on request.'));
    return section;
  }
  section.append(
    h('p', { class: 'lede' }, 'Loose thinking. Nothing here affects the verdict. Notes that mention a claim also appear on that claim.'),
  );
  const tied = Object.values(ideas.byClaim).reduce((n, list) => n + list.filter((i) => !i.related).length, 0);
  if (ideas.general.length > 0) section.append(h('div', { class: 'pad' }, h('h3', {}, 'Notes'), noteList(ideas.general)));
  if (tied > 0) section.append(h('p', { class: 'note' }, `${tied} more note${tied > 1 ? 's are' : ' is'} tied to particular claims. Tap a claim on the map to read them.`));
  section.append(
    h(
      'div',
      { class: 'pad pad-related' },
      h('h3', {}, 'Related ideas'),
      ideas.related.length > 0 ? noteList(ideas.related) : h('p', { class: 'bet-text' }, 'None yet.'),
      h('p', { class: 'bet-text' }, 'Any of these can be promoted into a claim, where it is held to the usual standard.'),
    ),
  );
  if (ideas.url) section.append(h('p', { class: 'note' }, h('a', { href: ideas.url, rel: 'noopener' }, 'Open the notepad on GitHub to add to it')));
  return section;
}

/* ---------- Outline ---------- */

function renderOutline(arg: Argument, a: Analysis): HTMLElement {
  const attackers = attackersOf(arg);
  const shown = new Set<string>();
  const item = (id: string, role: 'root' | 'because' | 'but', trail: string[]): HTMLElement => {
    const claim = arg.claims.get(id) as Claim;
    const st = a.statuses.get(id) ?? 'contested';
    const repeat = shown.has(id);
    shown.add(id);
    const li = h(
      'li',
      { class: `ol-item ol-${role}`, 'data-status': st },
      h(
        'button',
        { class: 'ol-row', type: 'button', click: () => select(id) },
        h('span', { class: 'ol-mark', 'aria-hidden': 'true' }, STATUS_MARK[st]),
        h('span', { class: 'ol-body' }, role === 'but' ? h('em', { class: 'ol-role' }, 'But: ') : null, claimText(arg, claim), repeat ? h('span', { class: 'ol-repeat' }, ' (shown above)') : null),
      ),
    );
    if (repeat || trail.includes(id)) return li;
    const next = [...trail, id];
    const kids = h('ul', { class: 'ol-kids' });
    claim.because.forEach((group, i) => {
      if (claim.because.length > 1) kids.append(h('li', { class: 'ol-or' }, i === 0 ? 'Either' : 'Or'));
      for (const m of group) if (arg.claims.has(m)) kids.append(item(m, 'because', next));
    });
    for (const att of attackers.get(id) ?? []) if (!next.includes(att)) kids.append(item(att, 'but', next));
    if (kids.childElementCount > 0) li.append(kids);
    return li;
  };
  return h(
    'section',
    { class: 'block' },
    h('h2', {}, 'Read it top down'),
    h('p', { class: 'lede' }, 'The conclusion, then what it rests on, then what is said against each step.'),
    h('ul', { class: 'outline' }, item(arg.conclusion, 'root', [])),
  );
}

/* ---------- Checks, terms, loader ---------- */

function renderIssues(issues: Issue[], heading: string): HTMLElement | null {
  if (issues.length === 0) return null;
  const list = h('ul', { class: 'issues' });
  for (const issue of issues) {
    list.append(h('li', { class: `issue issue-${issue.severity}` }, h('span', { class: 'issue-kind' }, issue.severity), issue.message));
  }
  return h('section', { class: 'block' }, h('h2', {}, heading), list);
}

function renderTerms(arg: Argument): HTMLElement | null {
  if (arg.terms.size === 0) return null;
  const dl = h('dl', { class: 'terms' });
  for (const term of arg.terms.values()) {
    dl.append(
      h('dt', {}, term.word.replace(/-/g, ' '), term.sense ? h('span', { class: 'sense' }, term.sense) : null),
      h('dd', {}, term.definition),
    );
  }
  return h(
    'section',
    { class: 'block' },
    h('h2', {}, 'Pinned terms'),
    h('p', { class: 'lede' }, 'Underlined words mean exactly this wherever they appear. A word with two senses gets two entries.'),
    dl,
  );
}

function renderLoader(): HTMLElement {
  const area = h('textarea', { id: 'source-text', rows: '8', spellcheck: 'false', placeholder: 'Paste an argmap YAML file here' });
  area.value = '';
  const file = h('input', { id: 'source-file', type: 'file', accept: '.yaml,.yml,text/plain' });
  file.addEventListener('change', () => {
    const picked = file.files?.[0];
    if (!picked) return;
    void picked.text().then((text) => {
      area.value = text;
    });
  });
  return h(
    'details',
    { class: 'loader' },
    h('summary', {}, 'Load another argument'),
    h('label', { for: 'source-file' }, 'Open a file'),
    file,
    h('label', { for: 'source-text' }, 'Or paste one'),
    area,
    h(
      'div',
      { class: 'detail-actions' },
      h(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          click: () => {
            if (area.value.trim() === '') return;
            setSource(area.value);
            render();
            window.scrollTo({ top: 0 });
          },
        },
        'Load it',
      ),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          click: () => {
            area.value = state.source;
          },
        },
        'Show the current file',
      ),
    ),
  );
}

/* ---------- Page ---------- */

function render(): void {
  const scroller = document.getElementById('graph-scroll');
  const scrollLeft = scroller?.scrollLeft ?? 0;
  const { loaded } = state;
  const arg = loaded.argument;
  const parts: Child[] = [];

  if (!arg || !loaded.ok) {
    parts.push(
      h('header', { class: 'verdict' }, h('p', { class: 'eyebrow' }, 'argmap'), h('h1', {}, arg?.title ?? 'No argument loaded')),
      state.source.trim() === ''
        ? h('p', { class: 'lede' }, 'Load an argument file to map it.')
        : renderIssues(loaded.issues, 'This file needs fixing before it can be mapped'),
      renderLoader(),
    );
    root.replaceChildren(...parts.filter((p): p is Node => p instanceof Node));
    return;
  }

  const a = analyze(arg, state.knocked);
  const x: Extra = { res: resolution(arg), reviews: reviewSummaries(arg) };
  // Content width of the page, less the map's border and inner padding.
  const cs = getComputedStyle(root);
  const available = Math.max(260, root.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 14);
  parts.push(
    renderVerdict(arg, a, x),
    renderBar(arg, a),
    h(
      'section',
      { class: 'block block-map' },
      h('h2', {}, 'The map'),
      h('p', { class: 'lede' }, 'Conclusion on the left, bets on the right. Tap a claim to read it, then knock it out to see what falls. A deep map scrolls sideways.'),
      renderGraph(arg, a, available),
      renderLegend(),
      renderDetail(arg, a, x),
    ),
    renderSteps(arg, a),
    renderDisputes(arg, a),
    renderBets(arg, a, x),
    renderOutline(arg, a),
    renderRounds(arg),
    renderNotepad(),
    renderIssues(
      loaded.issues.filter((i) => i.severity === 'warning'),
      'Checks',
    ),
    renderTerms(arg),
    renderLoader(),
    h(
      'p',
      { class: 'foot' },
      'Stands, falls and contested describe what follows from the bets as written. None of them means true.',
    ),
  );
  root.replaceChildren(...parts.filter((p): p is Node => p instanceof Node));
  const next = document.getElementById('graph-scroll');
  if (next) next.scrollLeft = scrollLeft;
}

let lastWidth = 0;
let timer: number | undefined;
new ResizeObserver(() => {
  const width = root.clientWidth;
  if (width === lastWidth) return;
  lastWidth = width;
  window.clearTimeout(timer);
  timer = window.setTimeout(render, 80);
}).observe(root);

setSource(window.__ARGMAP_SOURCE__ ?? '');
lastWidth = root.clientWidth;
render();
