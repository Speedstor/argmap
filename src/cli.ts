import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { load } from './index.ts';
import { formatIssues, formatKnock, formatReport, toJson } from './report.ts';

const USAGE = `argmap: map an argument, see what it rests on, see what falls.

Usage
  argmap check  <file>              Check structure and pinned terms
  argmap report <file> [--json]     Verdict, open disputes, bets by exposure
  argmap knock  <file> <id>...      What changes if these claims fail
  argmap view   <file> [-o out]     Write a self-contained HTML viewer
  argmap init   <file>              Write a starter argument file

Statuses: stands, falls, contested. None of them means "true".
`;

const STARTER = `argmap: 1
title: A question worth mapping
conclusion: main-claim

# Pin every word the argument turns on. Use word#sense when a word has two meanings.
terms:
  key-word: What this word means everywhere it is pinned.

claims:
  main-claim:
    text: The thing you want to test, using the {key-word}.
    because: [first-reason, second-reason]

  first-reason:
    text: A reason that itself rests on something else.
    because: [a-bet]

  # A claim with no "because" is a bet: a place where you stop and trust.
  # trust: observed | corroborated | track-record | assumed
  a-bet:
    text: Something about the {key-word} you have not checked.
    bet:
      trust: assumed
      note: Why you stopped here.

  second-reason:
    text: Something you saw yourself.
    bet: observed

  an-objection:
    text: A reason to doubt the second reason.
    bet: assumed

# attacks: [attacker, target] means the target falls if the attacker stands.
# disputes: [a, b] means each attacks the other, so neither is settled.
disputes:
  - [second-reason, an-objection]
`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function read(file: string | undefined): string {
  if (!file) fail(USAGE);
  if (!existsSync(file)) fail(`No such file: ${file}`);
  return readFileSync(file, 'utf8');
}

async function main(argv: string[]): Promise<number> {
  const [command, file, ...rest] = argv;
  switch (command) {
    case 'check': {
      const loaded = load(read(file));
      console.log(formatIssues(loaded.issues));
      return loaded.ok ? 0 : 1;
    }
    case 'report': {
      const loaded = load(read(file));
      if (rest.includes('--json')) console.log(JSON.stringify(toJson(loaded), null, 2));
      else console.log(formatReport(loaded));
      return loaded.ok ? 0 : 1;
    }
    case 'knock': {
      const loaded = load(read(file));
      if (!loaded.ok || !loaded.argument) {
        console.log(formatIssues(loaded.issues));
        return 1;
      }
      if (rest.length === 0) fail('Name at least one claim id to knock out.');
      const unknown = rest.filter((id) => !loaded.argument?.claims.has(id));
      if (unknown.length > 0) fail(`Unknown claim id: ${unknown.join(', ')}`);
      console.log(formatKnock(loaded.argument, new Set(), rest));
      return 0;
    }
    case 'view': {
      const source = read(file);
      const loaded = load(source);
      if (!loaded.argument) {
        console.log(formatIssues(loaded.issues));
        return 1;
      }
      const o = rest.indexOf('-o');
      const out = resolve(o !== -1 && rest[o + 1] ? (rest[o + 1] as string) : basename(file as string).replace(/\.ya?ml$/, '') + '.html');
      const { buildViewer } = await import('../scripts/build.mjs');
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, await buildViewer({ source, title: loaded.argument.title }));
      console.log(`Wrote ${out}`);
      return 0;
    }
    case 'init': {
      if (!file) fail(USAGE);
      if (existsSync(file)) fail(`${file} already exists.`);
      writeFileSync(file, STARTER);
      console.log(`Wrote ${file}. Edit it, then run: argmap report ${file}`);
      return 0;
    }
    default:
      console.log(USAGE);
      return command === undefined || command === 'help' || command === '--help' ? 0 : 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 2;
  },
);
