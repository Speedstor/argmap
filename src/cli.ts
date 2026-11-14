import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { analyze, nextSteps, OUTCOMES, PREDICTION_TYPES, REVIEWER_KINDS, toYaml, VERDICTS } from './index.ts';
import type { Outcome, PredictionType, ReviewerKind, Verdict } from './index.ts';
import { allPredictions, dueOn, formatRecord, records } from './record.ts';
import { Editor, EditError } from './edit.ts';
import { formatIssues, formatKnock, formatReport, formatSteps, toJson } from './report.ts';
import { addIdea, createNotepad, ideasFor, IdeasError } from './ideas.ts';
import type { Idea } from './ideas.ts';
import { searchClaims } from './search.ts';
import { parseSigners, readSigners, verifyRange } from './verify.ts';
import { git, isRepo, refExists } from './git.ts';
import { parsePrivateKey, publicLine, SignError } from './sign.ts';
import { fileURLToPath } from 'node:url';
import { buildDigest } from './digest.ts';
import { findRoot, loadFile } from './workspace.ts';
import type { LoadedFile } from './workspace.ts';

const USAGE = `argmap: map an argument, see what it rests on, see what falls.

Usage
  argmap check  <file>              Check structure and pinned terms
  argmap report <file> [--json]     Verdict, open disputes, bets by exposure
  argmap next   <file> [-n 5]       What to work on next, most valuable first
  argmap knock  <file> <id>...      What changes if these claims fail
  argmap review <file> <id> confirm|reject --by <name> [--ai] [--note <text>]
  argmap predict <file> <id> --says <text> --how <text> --type lookup|forecast --p <chance>
                 --if-false <chance> [--if-true <chance>] [--sample <n> --needs <k>]
                 --due <YYYY-MM-DD> --by <name> [--ai]
                                    Before checking a claim, record what you expect to find
  argmap accept  <file> <id> <n> --by <name> [--ai]
                                    Agree that a claim you vouch for implies test number n
  argmap resolve <file> <id> <n> yes|no|void [--found <k>] --source <where> [--note <text>] --by <name> [--ai]
                                    Record what was found. With a sample, give --found and leave out yes|no
  argmap overdue <file> <id> <n> --by <name> [--ai]
                                    Mark a test that is past due; the claim cannot stand until it is resolved
  argmap confirm <file> <id> <n> --by <name> [--ai]
                                    Put a second name to a recorded outcome
  argmap due [--on <YYYY-MM-DD>] [--json]
                                    Open predictions: those that have come due, then those to come
  argmap record [<name>]            What each name's resolved predictions show
  argmap search <words>...          Find claims in the library and every argument
  argmap ideas  <file>              Show the notepads for an argument (read from the ideas branch)
  argmap notepad <file> [--claim <id>] --by <name>
                                    Start a notepad for the argument, or for one claim
  argmap idea   <file> "<text>" [--claim <id>] [--related] --by <name>
                                    Add a note to a notepad
  argmap verify [<range>] [--signers <file>] [--pull-request]
                                    Check commits are signed by a listed key, in the signer's own name.
                                    --pull-request also refuses a prediction and its outcome in one range
  argmap use-key <private key file> Sign this clone's commits with that key (no ssh-keygen needed)
  argmap bundle <file>              Print the argument with its library claims inlined
  argmap view   <file> [-o out]     Write a self-contained HTML viewer
  argmap digest [-o folder]         Write everything out as Markdown to read in one pass (default: dist/digest)
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

function argumentName(path: string): string {
  return basename(path).replace(/\.ya?ml$/, '');
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
    case 'predict':
    case 'accept':
    case 'resolve':
    case 'overdue':
    case 'confirm': {
      const id = rest[0];
      const by = option(rest, '--by');
      if (!file || !id || id.startsWith('--') || !by) fail(USAGE);
      const who = { by, kind: rest.includes('--ai') ? REVIEWER_KINDS[1] : REVIEWER_KINDS[0] } satisfies { by: string; kind: ReviewerKind };
      const number = (name: string): number | undefined => {
        const raw = option(rest, name);
        if (raw === undefined) return undefined;
        if (raw.trim() === '' || Number.isNaN(Number(raw))) fail(`${name} needs a number.`);
        return Number(raw);
      };
      try {
        const editor = new Editor(file);
        let note: string;
        if (command === 'predict') {
          const says = option(rest, '--says');
          const how = option(rest, '--how');
          const type = option(rest, '--type');
          const p = number('--p');
          const due = option(rest, '--due');
          if (!says || !how || !(PREDICTION_TYPES as readonly unknown[]).includes(type) || p === undefined || !due) fail(USAGE);
          const ifFalse = number('--if-false');
          const ifTrue = number('--if-true');
          const sample = number('--sample');
          const needs = number('--needs');
          editor.predict(id, {
            says,
            how,
            type: type as PredictionType,
            p,
            due,
            ...who,
            ...(ifFalse !== undefined ? { ifFalse } : {}),
            ...(ifTrue !== undefined ? { ifTrue } : {}),
            ...(sample !== undefined ? { sample } : {}),
            ...(needs !== undefined ? { needs } : {}),
          });
          note = `${Math.round(p * 100)}%: ${says}`;
        } else {
          const n = Number(rest[1]);
          if (!Number.isInteger(n) || n < 1) fail(`Say which prediction on "${id}" by its number, counted from 1.`);
          note = `test ${n}`;
          if (command === 'accept') editor.accept(id, n, who);
          else if (command === 'overdue') editor.markOverdue(id, n, who);
          else if (command === 'confirm') editor.confirmOutcome(id, n, who);
          else {
            const word = rest[2];
            const outcome = (OUTCOMES as readonly unknown[]).includes(word) ? (word as Outcome) : undefined;
            const found = number('--found');
            const source = option(rest, '--source');
            const why = option(rest, '--note');
            if (outcome === undefined && found === undefined) fail(USAGE);
            editor.resolve(id, n, {
              ...who,
              ...(outcome !== undefined ? { outcome } : {}),
              ...(found !== undefined ? { found } : {}),
              ...(source ? { source } : {}),
              ...(why ? { note: why } : {}),
            });
            note = `test ${n}: ${outcome ?? `${found} agreed`}`;
          }
        }
        const result = editor.save({ by, did: command, claim: id, note });
        console.log(`Recorded. Conclusion: ${result.conclusion}. Wrote ${result.written.join(', ')}.`);
        for (const warning of result.warnings.filter((w) => w.claims.includes(id) && (w.code.startsWith('test-') || w.code === 'credence-label'))) console.log(`  Note: ${warning.message}`);
        return 0;
      } catch (e) {
        if (e instanceof EditError) fail(e.message);
        throw e;
      }
    }
    case 'due': {
      const args = [file, ...rest].filter((a): a is string => !!a);
      const on = option(args, '--on') ?? new Date().toISOString().slice(0, 10);
      const { due, upcoming } = dueOn(allPredictions(findRoot(process.cwd())), on);
      if (args.includes('--json')) {
        const row = (e: (typeof upcoming)[number], late?: number): object => ({
          file: e.file,
          claim: e.claim,
          n: e.n,
          says: e.prediction.says,
          by: e.prediction.by,
          due: e.prediction.due,
          ...(late !== undefined ? { late } : {}),
          marked: e.prediction.overdue !== undefined,
        });
        console.log(JSON.stringify({ on, due: due.map((d) => row(d.entry, d.late)), upcoming: upcoming.map((e) => row(e)) }, null, 2));
        return 0;
      }
      const line = (e: (typeof upcoming)[number]): string => `${e.file}  ${e.claim}  test ${e.n}  by ${e.prediction.by}\n      ${e.prediction.says}`;
      if (due.length === 0 && upcoming.length === 0) console.log('No open predictions.');
      if (due.length > 0) console.log(`Due (${due.length}), as of ${on}`);
      for (const d of due) console.log(`  ${d.late === 0 ? 'due today' : `${d.late} day${d.late === 1 ? '' : 's'} late`}${d.entry.prediction.overdue ? ', marked overdue' : ''}  ${line(d.entry)}`);
      if (upcoming.length > 0) console.log(`${due.length > 0 ? '\n' : ''}To come (${upcoming.length})`);
      for (const e of upcoming) console.log(`  due ${e.prediction.due}  ${line(e)}`);
      return 0;
    }
    case 'record': {
      const all = records(allPredictions(findRoot(process.cwd())));
      const wanted = file ? all.filter((r) => r.name === file) : all;
      if (wanted.length === 0) console.log(file ? `${file} has set no predictions.` : 'Nobody has set a prediction yet. Start with: argmap predict');
      else console.log(wanted.map(formatRecord).join('\n\n'));
      return 0;
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
    case 'ideas': {
      const loaded = open(file);
      if (!loaded.argument) {
        console.log(formatIssues(loaded.issues));
        return 1;
      }
      const ideas = ideasFor(loaded.root, argumentName(loaded.path), loaded.argument);
      if (ideas.notepads.length === 0) {
        console.log('No notepad yet. Start one with: argmap notepad <file> --by <name>');
        return 0;
      }
      const show = (title: string, list: Idea[]): void => {
        if (list.length === 0) return;
        console.log(`\n${title}`);
        for (const idea of list) console.log(`  - ${idea.text}${idea.by ? `  (${idea.by}${idea.date ? `, ${idea.date}` : ''})` : ''}`);
      };
      console.log(`Notepads: ${ideas.notepads.map((n) => n.path).join(', ')}`);
      show('Notes', ideas.general);
      for (const [id, list] of Object.entries(ideas.byClaim)) show(`On ${id}`, list.filter((i) => !i.related));
      show('Related ideas', ideas.related);
      if (ideas.url) console.log(`\nOpen it: ${ideas.url}`);
      return 0;
    }
    case 'notepad':
    case 'idea': {
      const loaded = open(file);
      const by = option(rest, '--by');
      if (!loaded.argument || !by) fail(USAGE);
      const claim = option(rest, '--claim');
      if (claim && !loaded.argument.claims.has(claim)) fail(`Unknown claim id: ${claim}`);
      const scope = claim ? 'claim' : 'argument';
      const name = claim ?? argumentName(loaded.path);
      try {
        if (command === 'notepad') {
          const title = claim ? `${loaded.argument.claims.get(claim)?.label ?? claim}` : loaded.argument.title;
          const made = createNotepad(loaded.root, scope, name, title, by);
          console.log(`Started ${made.path} on the ideas branch. Share it with: git push origin ideas`);
        } else {
          const text = rest[0];
          if (!text || text.startsWith('--')) fail(USAGE);
          const made = addIdea(loaded.root, scope, name, text, { related: rest.includes('--related'), by });
          console.log(`Added to ${made.path} on the ideas branch. Share it with: git push origin ideas`);
        }
        return 0;
      } catch (e) {
        if (e instanceof IdeasError) fail(e.message);
        throw e;
      }
    }
    case 'verify': {
      const args = [file, ...rest].filter((a): a is string => !!a);
      const explicit = option(args, '--signers');
      const root = findRoot(process.cwd());
      const range = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--signers') ?? (refExists(root, 'origin/main') ? 'origin/main..HEAD' : 'HEAD');
      const list = readSigners(root, explicit);
      const signers = parseSigners(list.text);
      console.log(`Trusted keys: ${signers.length}, read from ${list.from}`);
      if (signers.length === 0) {
        console.log('The list is empty, so no commit can be attributed to anyone. Add public keys to allowed_signers on main.');
        return 1;
      }
      // In a pull request, a prediction and its outcome may not arrive together: the prediction has to be on main first.
      // A commit dated in the future is refused: the clock here is the one bound on dates that the committer does not set.
      const checks = verifyRange(root, range, signers, { separate: args.includes('--pull-request'), notAfter: Math.floor(Date.now() / 1000) });
      let bad = 0;
      for (const check of checks) {
        const fine = check.problems.length === 0;
        if (!fine) bad++;
        const who = check.signer
          ? `signed by ${check.signer.principal}${check.signer.label ? ` [${check.signer.label}]` : ''}`
          : check.merge === 'clean'
            ? 'merge that adds nothing of its own'
            : 'no trusted signature';
        console.log(`${fine ? '✓' : '✗'} ${check.commit.slice(0, 7)} ${who}  ${check.subject}`);
        for (const problem of check.problems) console.log(`      ${problem}`);
      }
      console.log(`${checks.length - bad} of ${checks.length} commits in ${range} pass.`);
      return bad === 0 ? 0 : 1;
    }
    case 'use-key': {
      if (!file) fail(USAGE);
      if (!existsSync(file)) fail(`No such file: ${file}`);
      const root = process.cwd();
      if (!isRepo(root)) fail('Run this inside the git clone whose commits should be signed.');
      let line: string;
      try {
        line = publicLine(parsePrivateKey(readFileSync(file, 'utf8')));
      } catch (e) {
        if (e instanceof SignError) fail(e.message);
        throw e;
      }
      const helper = fileURLToPath(new URL('../bin/argmap-ssh-sign.mjs', import.meta.url));
      git(root, ['config', 'gpg.format', 'ssh']);
      git(root, ['config', 'gpg.ssh.program', helper]);
      git(root, ['config', 'user.signingkey', resolve(file)]);
      git(root, ['config', 'commit.gpgsign', 'true']);
      const listed = parseSigners(readSigners(findRoot(root)).text).filter((signer) => line.endsWith(signer.key));
      console.log(`Commits in this clone will now be signed with: ${line}`);
      if (listed.length > 0) {
        const who = listed[0] as (typeof listed)[number];
        console.log(`That key is trusted as ${who.principal}${who.label ? ` [${who.label}]` : ''}.`);
        console.log(`Record reviews, evidence and log entries as by "${who.name}"${who.kind === 'unknown' ? '' : `, kind ${who.kind}`}, or verify will reject them.`);
      } else {
        console.log('That key is not in allowed_signers, so verify will reject these commits until it is added on main.');
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
      const ideas = ideasFor(loaded.root, argumentName(loaded.path), loaded.argument);
      writeFileSync(out, await buildViewer({ source: toYaml(loaded.argument), title: loaded.argument.title, ideas }));
      console.log(`Wrote ${out}`);
      return 0;
    }
    case 'digest': {
      const args = [file, ...rest].filter((a): a is string => !!a);
      const out = resolve(option(args, '-o') ?? 'dist/digest');
      const files = buildDigest(findRoot(process.cwd()));
      for (const page of files) {
        const path = join(out, page.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, page.content);
      }
      console.log(`Wrote ${files.length} files to ${out}`);
      for (const page of files) console.log(`  ${page.path}`);
      return 0;
    }
    case 'init': {
      if (!file) fail(USAGE);
      if (existsSync(file)) fail(`${file} already exists.`);
      mkdirSync(dirname(resolve(file)), { recursive: true });
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
