#!/usr/bin/env node
// Open a GitHub issue for each prediction that has come due and has no outcome.
// Run daily by .github/workflows/due.yml. It writes nothing to the repository,
// so it needs no signing key. An issue is the reminder: GitHub notifies whoever
// watches the repository, and nobody has to remember to look at a list.
//
//   node scripts/due-issues.mjs            open the issues (needs gh and GH_TOKEN)
//   node scripts/due-issues.mjs --dry-run  print what would be opened
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dryRun = process.argv.includes('--dry-run');
const cli = fileURLToPath(new URL('../bin/argmap.mjs', import.meta.url));
const { on, due } = JSON.parse(execFileSync(process.execPath, [cli, 'due', '--json'], { encoding: 'utf8' }));

const titleOf = (d) => `Prediction due: ${d.claim}, test ${d.n} (${d.file})`;
const bodyOf = (d) =>
  [
    `A prediction on \`${d.claim}\` in \`${d.file}\` was due on ${d.due} and has no outcome${d.late > 0 ? ` (${d.late} day${d.late === 1 ? '' : 's'} late as of ${on})` : ''}.`,
    '',
    `> ${d.says}`,
    '',
    `Set by ${d.by}.`,
    '',
    'Check it and record what was found:',
    '',
    '```sh',
    `npm run argmap -- resolve ${d.file} ${d.claim} ${d.n} yes|no --source <where> --by <name>`,
    '```',
    '',
    'For a prediction with a sample, give `--found <how many agreed>` in place of yes or no.',
    d.marked
      ? 'It is already marked overdue, so the claim cannot stand until this is done.'
      : `If nobody gets to it, anyone can mark it overdue, and then the claim cannot stand until it is resolved: \`npm run argmap -- overdue ${d.file} ${d.claim} ${d.n} --by <name>\`.`,
    '',
    'Close this issue once the outcome is recorded.',
  ].join('\n');

if (due.length === 0) {
  console.log(`No predictions are due as of ${on}.`);
  process.exit(0);
}

let existing = new Set();
if (!dryRun) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('GITHUB_REPOSITORY is not set. Use --dry-run outside GitHub Actions.');
    process.exit(2);
  }
  const titles = execFileSync('gh', ['api', '--paginate', `repos/${repo}/issues?state=open&per_page=100`, '--jq', '.[].title'], { encoding: 'utf8' });
  existing = new Set(titles.split('\n').filter(Boolean));
}

for (const d of due) {
  const title = titleOf(d);
  if (existing.has(title)) {
    console.log(`Already open: ${title}`);
  } else if (dryRun) {
    console.log(`Would open: ${title}\n${bodyOf(d)}\n`);
  } else {
    execFileSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/issues`, '-f', `title=${title}`, '-f', `body=${bodyOf(d)}`], { stdio: ['ignore', 'ignore', 'inherit'] });
    console.log(`Opened: ${title}`);
  }
}
