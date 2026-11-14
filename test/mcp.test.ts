import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const ARG = 'second-industrialization';
let root: string;
let client: Client;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'argmap-'));
  cpSync(join(repo, 'test/fixtures/arguments'), join(root, 'arguments'), { recursive: true });
  cpSync(join(repo, 'test/fixtures/claims'), join(root, 'claims'), { recursive: true });
  client = new Client({ name: 'argmap-test', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(repo, 'bin/argmap-mcp.mjs')],
      env: { ...(process.env as Record<string, string>), ARGMAP_ROOT: root },
    }),
  );
});

after(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ error: boolean; text: string; json: any }> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = result.content[0]?.text ?? '';
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { error: result.isError === true, text, json };
}

const file = (path: string): string => readFileSync(join(root, path), 'utf8');

test('the server lists its tools and the arguments in the workspace', async () => {
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 13);
  const { json } = await call('list_arguments');
  assert.deepEqual(json, [
    { argument: `arguments/${ARG}.yaml`, title: 'Could a collapsed civilization industrialize a second time?', conclusion: 'contested' },
  ]);
});

test('next_steps starts with the vaguest decisive bet', async () => {
  const { json } = await call('next_steps', { argument: ARG, limit: 1 });
  assert.equal(json.steps[0].kind, 'refine');
  assert.equal(json.steps[0].claims[0], 'easy-coal-mined-out');
});

test('refine_claim replaces a bet with sharper parts, logs the round, and keeps comments', async () => {
  const before = (await call('report', { argument: ARG })).json.resolution;
  const { json, error, text } = await call('refine_claim', {
    argument: ARG,
    id: 'water-wind-too-small',
    parts: [
      { id: 'wheel-power-test', text: 'A water wheel of 1800 delivered under 100 kW.', note: 'Test fixture.' },
      { id: 'mill-power-test', text: 'A rolling mill of 1900 needed over 1,000 kW.' },
    ],
    by: 'tester',
    note: 'Split into supply and demand.',
  });
  assert.ok(!error, text);
  assert.equal(json.conclusion, 'contested');
  const after = (await call('report', { argument: ARG })).json;
  assert.equal(after.resolution.bets, before.bets + 1);
  assert.equal(after.resolution.sharp, before.sharp + 2);
  assert.deepEqual(after.log.at(-1).did, 'refine');
  const source = file(`arguments/${ARG}.yaml`);
  assert.ok(source.includes('# --- Premise 3'), 'comments survive an edit');
  assert.ok(source.includes('because: [wheel-power-test, mill-power-test]'));
  const claim = (await call('get_claim', { argument: ARG, id: 'water-wind-too-small' })).json;
  assert.equal(claim.bet, undefined);
  assert.deepEqual(claim.restsOn, [['wheel-power-test', 'mill-power-test']]);
});

test('a change that would break the argument is refused and nothing is written', async () => {
  const before = file(`arguments/${ARG}.yaml`);
  const dup = await call('add_claim', { argument: ARG, claim: { id: 'never-again', text: 'Again.' }, by: 'tester' });
  assert.ok(dup.error);
  assert.match(dup.text, /already exists/);
  const missing = await call('refine_claim', { argument: ARG, id: 'no-such-claim', parts: [{ id: 'x', text: 'X.' }], by: 'tester' });
  assert.ok(missing.error);
  const dangling = await call('set_support', { argument: ARG, id: 'same-inputs', because: [['ghost']], by: 'tester' });
  assert.ok(dangling.error);
  assert.equal(file(`arguments/${ARG}.yaml`), before);
});

test('a person and an AI can each confirm or reject, and disagreement waits for adjudication', async () => {
  const id = 'coal-drove-takeoff';
  await call('add_review', { argument: ARG, id, verdict: 'confirm', kind: 'person', by: 'ann', note: 'Matches Wrigley.' });
  let claim = (await call('get_claim', { argument: ARG, id })).json;
  assert.equal(claim.review.state, 'confirmed');
  await call('add_review', { argument: ARG, id, verdict: 'reject', kind: 'ai', by: 'model-x', note: '1840s is too early.' });
  claim = (await call('get_claim', { argument: ARG, id })).json;
  assert.equal(claim.review.state, 'split');
  assert.ok(file('claims/energy-and-industry.yaml').includes('by: model-x'), 'the review is stored beside the claim, in the library');
  const steps = (await call('next_steps', { argument: ARG, limit: 1 })).json.steps;
  assert.equal(steps[0].kind, 'adjudicate');
  assert.equal(steps[0].claims[0], id);

  await call('reword_claim', { argument: ARG, id, text: 'Britain ran on coal by 1850.', by: 'tester' });
  claim = (await call('get_claim', { argument: ARG, id })).json;
  assert.equal(claim.review.state, 'unreviewed');
  assert.equal(claim.review.stale.length, 2);
});

test('checking a bet records its new trust', async () => {
  const { error } = await call('set_bet', { argument: ARG, id: 'books-survive', trust: 'corroborated', note: 'Two library surveys.', by: 'tester' });
  assert.ok(!error);
  const claim = (await call('get_claim', { argument: ARG, id: 'books-survive' })).json;
  assert.equal(claim.bet.trust, 'corroborated');
  assert.equal(claim.bet.note, 'Two library surveys.');
});

test('search, knock_out and new library files work', async () => {
  const hits = (await call('search_claims', { query: 'charcoal iron' })).json;
  assert.equal(hits[0].id, 'charcoal-iron-works-today');
  assert.deepEqual(hits[0].usedIn, [`arguments/${ARG}.yaml`]);
  const knock = (await call('knock_out', { argument: ARG, ids: ['same-inputs'] })).json;
  assert.equal(knock.conclusionAfter, 'falls');

  const added = await call('add_claim', {
    argument: ARG,
    claim: { id: 'peat-exists-test', text: 'Ireland cut 4 Mt of peat in 1950.', trust: 'assumed' },
    library_file: 'fuel/peat.yaml',
    by: 'tester',
  });
  assert.ok(!added.error, added.text);
  assert.ok(file('claims/fuel/peat.yaml').includes('peat-exists-test'));
  const opposed = await call('add_opposition', { argument: ARG, kind: 'dispute', from: 'peat-exists-test', to: 'easy-coal-mined-out', by: 'tester' });
  assert.ok(!opposed.error, opposed.text);
  const report = (await call('report', { argument: ARG })).json;
  assert.ok(report.claims.some((c: { id: string }) => c.id === 'peat-exists-test'));
});

test('create_argument starts a new file that can be built out', async () => {
  const made = await call('create_argument', {
    name: 'bank-safety',
    title: 'Is my money in the bank safe?',
    conclusion_id: 'money-is-safe',
    conclusion_text: 'My deposits will be there when I ask for them.',
    by: 'tester',
  });
  assert.ok(!made.error, made.text);
  assert.equal(made.json.conclusion, 'stands');
  const refined = await call('refine_claim', {
    argument: 'bank-safety',
    id: 'money-is-safe',
    parts: [{ id: 'deposits-insured', text: 'Deposits up to 250,000 USD are insured by the FDIC.' }],
    by: 'tester',
  });
  assert.ok(!refined.error, refined.text);
  assert.equal((await call('list_arguments')).json.length, 2);
});
