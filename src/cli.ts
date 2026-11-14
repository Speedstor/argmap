import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { analyze, nextSteps, REVIEWER_KINDS, toYaml, VERDICTS } from './index.ts';
import type { ReviewerKind, Verdict } from './index.ts';
import { Editor, EditError } from './edit.ts';
import { formatIssues, formatKnock, formatReport, formatSteps, toJson } from './report.ts';
import { searchClaims } from './search.ts';
import { findRoot, loadFile } from './workspace.ts';
import type { LoadedFile } from './workspace.ts';

const USAGE = `argmap: map an argument, see what it rests on, see what falls.

Usage
  argmap check  <file>              Check structure and pinned terms
  argmap report <file> [--json]     Verdict, open disputes, bets by exposure
  argmap next   <file> [-n 5]       What to work on next, most valuable first
  argmap knock  <file> <id>...      What changes if these claims fail
  argmap review <file> <id> confirm|reject --by <name> [--ai] [--note <text>]
  argmap search <words>...          Find claims in the library and every argument
  argmap bundle <file>              Print the argument with its library claims inlined
  argmap view   <file> [-o out]     Write a self-contained HTML viewer
  argmap init   <file>              Write a starter argument file

Claims not defined in an argument file are looked up in the nearest claims/ folder.
To let an AI client work on arguments, run the MCP server: node bin/argmap-mcp.mjs

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

function open(file: string | undefined): LoadedFile {
  if (!file) fail(USAGE);
  if (!existsSync(file)) fail(`No such file: ${file}`);
  return loadFile(file);
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [command, file, ...rest] = argv;
  switch (command) {
    case 'check': {
      const loaded = open(file);
      console.log(formatIssues(loaded.issues));
      return loaded.ok ? 0 : 1;
    }
    case 'report': {
      const loaded = open(file);
      if (rest.includes('--json')) console.log(JSON.stringify(toJson(loaded), null, 2));
      else console.log(formatReport(loaded));
      return loaded.ok ? 0 : 1;
    }
    case 'next': {
      const loaded = open(file);
      if (!loaded.ok || !loaded.argument) {
        console.log(formatIssues(loaded.issues));
        return 1;
      }
      const limit = Number(option(rest, '-n') ?? 5) || 5;
      console.log(formatSteps(nextSteps(loaded.argument, analyze(loaded.argument)), limit));
      return 0;
    }
    case 'review': {
      const [id, verdict] = rest;
      const by = option(rest, '--by');
      if (!file || !id || !(VERDICTS as readonly unknown[]).includes(verdict) || !by) fail(USAGE);
      const kind: ReviewerKind = rest.includes('--ai') ? REVIEWER_KINDS[1] : REVIEWER_KINDS[0];
      const note = option(rest, '--note');
      try {
        const result = new Editor(file)
          .review(id, { by, kind, verdict: verdict as Verdict, ...(note ? { note } : {}) })
          .save({ by, did: 'review', claim: id, note: `${verdict}${note ? `: ${note}` : ''}` });
        console.log(`Recorded. Conclusion: ${result.conclusion}. Wrote ${result.written.join(', ')}.`);
        return 0;
      } catch (e) {
        if (e instanceof EditError) fail(e.message);
        throw e;
      }
    }
    case 'search': {
      const words = [file, ...rest].filter((w): w is string => !!w);
      const hits = searchClaims(findRoot(process.cwd()), words.join(' '));
      if (hits.length === 0) console.log('No claims match.');
      for (const hit of hits) {
        console.log(`${hit.id}  [${hit.kind === 'bet' ? hit.trust : 'supported'}, ${hit.review}]  ${hit.file}`);
        console.log(`    ${hit.text}`);
        if (hit.usedIn.length > 0) console.log(`    used in: ${hit.usedIn.join(', ')}`);
      }
      return 0;
    }
    case 'bundle': {
      const loaded = open(file);
      if (!loaded.argument) {
        console.log(formatIssues(loaded.issues));
        return 1;
      }
      process.stdout.write(toYaml(loaded.argument));
      return loaded.ok ? 0 : 1;
    }
    case 'knock': {
      const loaded = open(file);
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
      const loaded = open(file);
      if (!loaded.argument) {
        console.log(formatIssues(loaded.issues));
        return 1;
      }
      const o = rest.indexOf('-o');
      const out = resolve(o !== -1 && rest[o + 1] ? (rest[o + 1] as string) : basename(file as string).replace(/\.ya?ml$/, '') + '.html');
      const { buildViewer } = await import('../scripts/build.mjs');
      mkdirSync(dirname(out), { recursive: true });
      // The page is self-contained, so library claims are inlined.
      writeFileSync(out, await buildViewer({ source: toYaml(loaded.argument), title: loaded.argument.title }));
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
