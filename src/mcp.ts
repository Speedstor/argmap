import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Editor, EditError } from './edit.ts';
import type { EditResult, NewClaim } from './edit.ts';
import {
  analyze,
  COST_LEVELS,
  knockOut,
  lintClaim,
  nextSteps,
  plainText,
  reason,
  REVIEWER_KINDS,
  reviewSummary,
  TRUST_LEVELS,
  VERDICTS,
} from './index.ts';
import type { Argument } from './index.ts';
import { toJson } from './report.ts';
import { searchClaims } from './search.ts';
import { ARGUMENTS_DIR, argumentFiles, loadFile } from './workspace.ts';
import type { LoadedFile } from './workspace.ts';

const ROOT = resolve(process.env['ARGMAP_ROOT'] ?? process.cwd());

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(value: unknown): Result {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function failure(message: string): Result {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Run a tool body, turning expected failures into tool errors the client can read and act on. */
function guard<A>(body: (args: A) => unknown): (args: A) => Promise<Result> {
  return async (args) => {
    try {
      return ok(body(args));
    } catch (e) {
      if (e instanceof EditError || e instanceof UserError) return failure(e.message);
      return failure(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

class UserError extends Error {}

const rel = (path: string): string => relative(ROOT, path).split(sep).join('/');

/** An argument is named by its path in the workspace, or just its file name without the extension. */
function argumentPath(name: string, mustExist = true): string {
  const candidates = /\.ya?ml$/.test(name) ? [name] : [`${ARGUMENTS_DIR}/${name}.yaml`, `${name}.yaml`, name];
  for (const candidate of candidates) {
    const path = resolve(ROOT, candidate);
    if (path !== ROOT && !path.startsWith(ROOT + sep)) throw new UserError(`"${name}" is outside the workspace.`);
    if (existsSync(path) || !mustExist) return path;
  }
  const known = argumentFiles(ROOT).map(rel);
  throw new UserError(`No argument "${name}". Known arguments: ${known.length > 0 ? known.join(', ') : 'none yet; use create_argument'}.`);
}

function open(name: string): LoadedFile & { argument: Argument } {
  const loaded = loadFile(argumentPath(name), ROOT);
  if (!loaded.ok || !loaded.argument) {
    const errors = loaded.issues.filter((i) => i.severity === 'error').map((i) => i.message);
    throw new UserError(`${rel(loaded.path)} has errors and cannot be evaluated: ${errors.join(' ')}`);
  }
  return loaded as LoadedFile & { argument: Argument };
}

function describeEdit(result: EditResult): unknown {
  return {
    saved: result.written,
    conclusion: result.conclusion,
    resolution: `${result.sharp} of ${result.bets} bets are specific enough to check`,
    warnings: result.warnings.map((w) => w.message),
  };
}

const argument = z.string().describe('The argument: its file name without extension (e.g. "second-industrialization"), or its path in the workspace.');
const by = z.string().min(1).describe('Who is making this change: a person\'s name or a model name. Recorded in the log.');
const trust = z.enum(TRUST_LEVELS).describe('How far a bet has been checked: observed (seen first-hand), corroborated (independent sources agree), track-record (this kind of claim has held up before), assumed (not checked).');
const newClaim = z.object({
  id: z.string().describe('A new id in lowercase-with-hyphens that reads as a short label, e.g. "surface-mines-reach-80m".'),
  text: z.string().describe('One checkable sentence. Prefer a figure, date, place or named case over words like "largely" or "enough". Pin key terms as {term}.'),
  trust: trust.optional(),
  note: z.string().optional().describe('Where this comes from, or how to check it.'),
  cost: z.enum(COST_LEVELS).optional(),
});

const server = new McpServer(
  { name: 'argmap', version: '0.2.0' },
  {
    instructions:
      'argmap maps arguments so their weak points are visible. An argument has a conclusion, claims that support each other, and bets: claims with no support, labelled by how far they are trusted. Statuses (stands, falls, contested) follow from the bets as written and never mean "true". Work in rounds: call next_steps, do the top step (usually refine_claim to replace a hand-wavy bet with sharper ones, or set_bet after checking a source), then call next_steps again. Reviews from people and AI count the same; when reviewers disagree the claim waits for adjudication and nothing picks a winner. Only label a bet corroborated or observed when a source was actually checked, and say which in the note.',
  },
);

/* ---------- Reading ---------- */

server.registerTool(
  'list_arguments',
  { description: 'List the argument files in the workspace with their title and current verdict.', inputSchema: {} },
  guard(() =>
    argumentFiles(ROOT).map((path) => {
      const loaded = loadFile(path, ROOT);
      return {
        argument: rel(path),
        title: loaded.argument?.title,
        conclusion: loaded.ok && loaded.argument ? analyze(loaded.argument).conclusion : 'has errors',
      };
    }),
  ),
);

server.registerTool(
  'report',
  {
    description:
      'Full analysis of one argument: the verdict on its conclusion, every claim with its status and reason, bets ranked by exposure, the open disputes it hinges on, how many bets are specific enough to check, the next steps, the log of past rounds, and any warnings.',
    inputSchema: { argument },
  },
  guard(({ argument: name }: { argument: string }) => toJson(loadFile(argumentPath(name), ROOT))),
);

server.registerTool(
  'next_steps',
  {
    description:
      'What to work on next, most valuable first. Kinds: adjudicate (reviewers disagree), answer (a reviewer rejected it), refine (a bet is hand-wavy: replace it with sharper claims), check (specific but unverified: find a source), settle (an open dispute), review (nobody has reviewed it). Steps marked decisive can change the conclusion on their own.',
    inputSchema: { argument, limit: z.number().int().min(1).max(50).optional().describe('How many steps to return. Default 5.') },
  },
  guard(({ argument: name, limit }: { argument: string; limit?: number }) => {
    const { argument: arg } = open(name);
    const steps = nextSteps(arg, analyze(arg));
    return { total: steps.length, steps: steps.slice(0, limit ?? 5) };
  }),
);

server.registerTool(
  'get_claim',
  {
    description: 'Everything about one claim: wording, status and why, what it rests on, what opposes it, its bet, its reviews, and prompts for sharpening it.',
    inputSchema: { argument, id: z.string() },
  },
  guard(({ argument: name, id }: { argument: string; id: string }) => {
    const { argument: arg } = open(name);
    const claim = arg.claims.get(id);
    if (!claim) throw new UserError(`No claim "${id}" in this argument. Use search_claims to find ids.`);
    const a = analyze(arg);
    const review = reviewSummary(claim);
    return {
      id,
      text: plainText(claim.text),
      written: claim.text,
      definedIn: claim.origin === '' ? 'the argument file' : claim.origin,
      status: a.statuses.get(id),
      reason: reason(arg, a.statuses, new Set(), id),
      side: a.sides.get(id),
      restsOn: claim.because,
      opposedBy: arg.attacks.filter((x) => x.to === id).map((x) => x.from),
      opposes: arg.attacks.filter((x) => x.from === id).map((x) => x.to),
      bet: claim.bet,
      ifItFails: a.bets.find((b) => b.id === id)?.conclusionIfFails,
      sharpen: claim.bet ? lintClaim(claim).map((f) => f.message) : [],
      review: { state: review.state, current: review.current, stale: review.stale },
      note: claim.note,
    };
  }),
);

server.registerTool(
  'search_claims',
  {
    description:
      'Search the claims database: the shared library plus every argument file. Use this before adding a claim, so an existing one is reused instead of duplicated. An empty query lists everything.',
    inputSchema: { query: z.string(), limit: z.number().int().min(1).max(100).optional() },
  },
  guard(({ query, limit }: { query: string; limit?: number }) => searchClaims(ROOT, query, limit ?? 20)),
);

server.registerTool(
  'knock_out',
  {
    description: 'What would change if these claims were false. Nothing is saved; this only answers "what falls if this fails?".',
    inputSchema: { argument, ids: z.array(z.string()).min(1) },
  },
  guard(({ argument: name, ids }: { argument: string; ids: string[] }) => {
    const { argument: arg } = open(name);
    const unknown = ids.filter((id) => !arg.claims.has(id));
    if (unknown.length > 0) throw new UserError(`Unknown claim id: ${unknown.join(', ')}.`);
    const base = analyze(arg).conclusion;
    const { statuses, changes } = knockOut(arg, new Set(), ids);
    return { conclusionBefore: base, conclusionAfter: statuses.get(arg.conclusion), changes };
  }),
);

/* ---------- Writing ---------- */

server.registerTool(
  'create_argument',
  {
    description: 'Start a new argument file with just its conclusion, held as an assumed bet. Then build it out with refine_claim.',
    inputSchema: {
      name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe('File name without extension, lowercase-with-hyphens.'),
      title: z.string().describe('The question the argument answers.'),
      conclusion_id: z.string(),
      conclusion_text: z.string(),
      by,
    },
  },
  guard(({ name, title, conclusion_id, conclusion_text, by: who }: { name: string; title: string; conclusion_id: string; conclusion_text: string; by: string }) => {
    const path = argumentPath(`${ARGUMENTS_DIR}/${name}.yaml`, false);
    if (existsSync(path)) throw new UserError(`${rel(path)} already exists.`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `argmap: 1\ntitle: ${JSON.stringify(title)}\nconclusion: ${conclusion_id}\n`);
    try {
      const editor = new Editor(path, ROOT).addClaim({ id: conclusion_id, text: conclusion_text });
      return { argument: rel(path), ...(describeEdit(editor.save({ by: who, did: 'create' })) as object) };
    } catch (e) {
      // Leave nothing behind if the first claim was not usable.
      rmSync(path, { force: true });
      throw e;
    }
  }),
);

server.registerTool(
  'add_claim',
  {
    description:
      'Add a claim. With no "because" it is a bet. Search first, to avoid duplicating a claim that exists. Set library_file (e.g. "energy.yaml") to store a reusable fact in the shared library instead of this argument. A new claim does nothing until something rests on it or it opposes something: follow with set_support, refine_claim or add_opposition.',
    inputSchema: {
      argument,
      claim: newClaim.extend({ because: z.array(z.array(z.string())).optional().describe('Lines of support: each inner list is one line, all of whose members are needed; any one line is enough.') }),
      library_file: z.string().optional(),
      by,
    },
  },
  guard(({ argument: name, claim, library_file, by: who }: { argument: string; claim: NewClaim; library_file?: string; by: string }) =>
    describeEdit(new Editor(argumentPath(name), ROOT).addClaim(claim, library_file).save({ by: who, did: 'add', claim: claim.id })),
  ),
);

server.registerTool(
  'refine_claim',
  {
    description:
      'Increase resolution: replace a hand-wavy bet with sharper claims underneath it. The claim stops being a bet and now rests on its parts. Give new parts, existing claim ids to reuse, or both. mode "all": every part is needed. mode "any": each part is enough alone. Optionally reword the claim itself. Existing reviews of the claim become stale.',
    inputSchema: {
      argument,
      id: z.string().describe('The bet to refine.'),
      parts: z.array(newClaim).optional().describe('New, sharper claims. Each becomes a bet.'),
      use: z.array(z.string()).optional().describe('Existing claim ids to rest on as well.'),
      mode: z.enum(['all', 'any']).optional(),
      text: z.string().optional().describe('New wording for the refined claim.'),
      library_file: z.string().optional().describe('Store the new parts in this library file instead of beside the claim.'),
      by,
      note: z.string().optional().describe('Why it was split this way.'),
    },
  },
  guard((a: { argument: string; id: string; parts?: NewClaim[]; use?: string[]; mode?: 'all' | 'any'; text?: string; library_file?: string; by: string; note?: string }) => {
    const options: Parameters<Editor['refine']>[1] = {};
    if (a.parts) options.parts = a.parts;
    if (a.use) options.use = a.use;
    if (a.mode) options.mode = a.mode;
    if (a.text) options.text = a.text;
    if (a.library_file) options.into = a.library_file;
    const entry = { by: a.by, did: 'refine', claim: a.id, ...(a.note ? { note: a.note } : {}) };
    return describeEdit(new Editor(argumentPath(a.argument), ROOT).refine(a.id, options).save(entry));
  }),
);

server.registerTool(
  'set_support',
  {
    description: 'Replace what a claim rests on. Each inner list is one line of support, all of whose members are needed; any one line is enough. If the claim was a bet, it stops being one.',
    inputSchema: { argument, id: z.string(), because: z.array(z.array(z.string()).min(1)).min(1), by, note: z.string().optional() },
  },
  guard((a: { argument: string; id: string; because: string[][]; by: string; note?: string }) =>
    describeEdit(
      new Editor(argumentPath(a.argument), ROOT).setSupport(a.id, a.because).save({ by: a.by, did: 'rewire', claim: a.id, ...(a.note ? { note: a.note } : {}) }),
    ),
  ),
);

server.registerTool(
  'set_bet',
  {
    description: 'Record the result of checking a bet: its new trust level and a note naming the source or test. Use corroborated or observed only if something was actually checked.',
    inputSchema: { argument, id: z.string(), trust, note: z.string().optional(), cost: z.enum(COST_LEVELS).optional(), by },
  },
  guard((a: { argument: string; id: string; trust: (typeof TRUST_LEVELS)[number]; note?: string; cost?: (typeof COST_LEVELS)[number]; by: string }) => {
    const bet: Parameters<Editor['setBet']>[1] = { trust: a.trust };
    if (a.note) bet.note = a.note;
    if (a.cost) bet.cost = a.cost;
    return describeEdit(new Editor(argumentPath(a.argument), ROOT).setBet(a.id, bet).save({ by: a.by, did: 'check', claim: a.id, note: `trust: ${a.trust}` }));
  }),
);

server.registerTool(
  'reword_claim',
  {
    description: 'Change the wording of a claim, for example to replace a vague word with a figure. Existing reviews of it become stale.',
    inputSchema: { argument, id: z.string(), text: z.string(), by, note: z.string().optional() },
  },
  guard((a: { argument: string; id: string; text: string; by: string; note?: string }) =>
    describeEdit(new Editor(argumentPath(a.argument), ROOT).reword(a.id, a.text).save({ by: a.by, did: 'reword', claim: a.id, ...(a.note ? { note: a.note } : {}) })),
  ),
);

server.registerTool(
  'add_review',
  {
    description:
      'Record a peer review of a claim. For a bet: is it acceptable as stated? For a supported claim: does its support really establish it? People and AI reviewers have the same standing, and either can confirm or reject. Reviews do not change statuses; when reviewers disagree the claim is marked split and waits for adjudication. A reviewer\'s newest review replaces their earlier one.',
    inputSchema: {
      argument,
      id: z.string(),
      verdict: z.enum(VERDICTS),
      kind: z.enum(REVIEWER_KINDS).describe('Whether the reviewer is a person or an AI.'),
      by: z.string().min(1).describe('The reviewer: a person\'s name or a model name.'),
      note: z.string().optional().describe('The reason. Expected for a rejection.'),
    },
  },
  guard((a: { argument: string; id: string; verdict: (typeof VERDICTS)[number]; kind: (typeof REVIEWER_KINDS)[number]; by: string; note?: string }) => {
    const review = { by: a.by, kind: a.kind, verdict: a.verdict, ...(a.note ? { note: a.note } : {}) };
    const entry = { by: a.by, did: 'review', claim: a.id, note: `${a.verdict}${a.note ? `: ${a.note}` : ''}` };
    return describeEdit(new Editor(argumentPath(a.argument), ROOT).review(a.id, review).save(entry));
  }),
);

server.registerTool(
  'add_opposition',
  {
    description:
      'Set one claim against another. kind "attack" is one-way: if "from" stands, "to" falls. kind "dispute" is an open disagreement: each attacks the other, and both stay contested until someone picks a side. Use dispute when it is not known who is right.',
    inputSchema: { argument, kind: z.enum(['attack', 'dispute']), from: z.string(), to: z.string(), by, note: z.string().optional() },
  },
  guard((a: { argument: string; kind: 'attack' | 'dispute'; from: string; to: string; by: string; note?: string }) =>
    describeEdit(
      new Editor(argumentPath(a.argument), ROOT)
        .oppose(a.kind, a.from, a.to)
        .save({ by: a.by, did: a.kind, claim: a.to, note: a.note ?? `${a.from} against ${a.to}` }),
    ),
  ),
);

await server.connect(new StdioServerTransport());
