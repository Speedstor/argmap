# argmap

A build system for beliefs. Write an argument as a plain text file, and argmap
tells you what it rests on, where it is exposed, and what falls when a bet fails.
Like a build, it has tests: a prediction is written down before anyone checks,
and one that fails knocks its claim out.

**This repository is the tool only.** It holds no arguments, claims or
notepads, so a copy of it starts empty. Arguments mapped in public are kept in
[argmap-garden](https://github.com/Speedstor/argmap-garden), which is a copy
of this repository. [Keep a private copy](#keep-a-private-copy) says how to
make one.

**Reading a copy?** Start with its [digest](../../tree/digest): every argument
written out with its verdict, structure, open disputes and next steps. It is
generated from `main` on each push and kept on the `digest` branch.

The loose thinking behind the arguments is in the
[notepads](../../tree/ideas): plain pages of ideas that are not claims yet.
They are kept on the `ideas` branch, which is never merged into `main`.

It does not tell you what is true. Every chain of justification ends somewhere
you chose to stop and trust (Agrippa's trilemma), so argmap makes those stopping
points visible instead of hiding them, and gives each one a way to be tested:

1. **Does the reasoning hold together?** Structure checks, and checks on pinned
   terms so a word cannot quietly change meaning between steps.
2. **What am I trusting?** Every claim with no support is a *bet*, labelled by
   how far it has been checked.
3. **Where am I exposed?** Which bets change the conclusion if they fail, and
   which open disputes the conclusion hinges on.
4. **Has the world been asked?** Before a bet is checked, someone writes down
   what they expect to find and how sure they are. A failed test that someone
   vouching for the claim accepted beforehand knocks the claim out, the way a
   failing test breaks a build.

The first three are answered from the file alone. They show whether an
argument holds together and what it leans on, not whether its bets match the
world. Predictions are where the map meets the world. They still do not say
what is true: a passed test changes no status, and a trust label stays a typed
judgment. What they add is that being wrong becomes quick to notice and hard to
hide, because the guess is on record, in its author's name, before the answer
is. The rules are under [Predictions](#predictions-let-the-world-grade-it).

## Try it

Needs Node 22.18 or later.

```sh
npm install
npm run argmap -- init   arguments/my-argument.yaml   # a small starter argument to edit
npm run argmap -- report arguments/my-argument.yaml
npm run argmap -- next   arguments/my-argument.yaml
npm run argmap -- knock  arguments/my-argument.yaml a-bet
npm run argmap -- search reason
npm run argmap -- review arguments/my-argument.yaml a-bet reject --by you --note "why"
npm run argmap -- due        # open predictions (see "Predictions" below)
npm run argmap -- record     # what each name's predictions show
npm run argmap -- view   arguments/my-argument.yaml -o dist/map.html
npm test
```

The starter has five claims. For a full-size argument, with a claims library,
evidence and a log of rounds, read the copy the tests use:

```sh
npm run argmap -- report test/fixtures/arguments/second-industrialization.yaml
```

`view` writes one self-contained HTML page: a map of the argument where you can
knock out any claim, side with either party in a dispute, and watch the verdict
change. It also shows what to do next, the reviews on each claim, and the log
of rounds. The page can load any other argument file by paste or upload.

## The digest

`digest` writes the repository out as Markdown, to be read in one pass. It is
made mainly for a model starting a session, and reads fine on GitHub too.

```sh
npm run argmap -- digest -o dist/digest
```

It puts what the engine computes next to what the files say: the status of
every claim, the structure as an indented outline, what each open dispute
decides, how exposed each bet is, and what to do next. There is one page per
argument, one for the claims library, and an index that also lists the trusted
keys and what each name has on record.

- Every claim is named by its id, so searching for an id finds everything
  about it. There are no links.
- Claim text is given as written, with its pinned-term markers.
- Nothing in the digest is a source. It is generated, and the same files
  always give the same digest.

`.github/workflows/ci.yml` runs the type check and the tests on every pull
request and every push to `main`. From `main` it also writes the digest to the
`digest` branch, so it can be read without cloning or installing anything.

## Keep a private copy

The settings to change by hand on GitHub, for this repository or a copy, are
listed in [docs/github-setup.md](docs/github-setup.md).

The tool is public; your arguments do not have to be. A private copy is an
ordinary private repository that starts as a copy of this one and keeps
receiving its updates. It cannot be a GitHub fork, because a fork of a public
repository is always public. A copy starts with no arguments, claims or
notepads. A public copy is made the same way.

Create an empty private repository on GitHub, then:

```sh
git clone https://github.com/Speedstor/argmap && cd argmap
git remote rename origin upstream
git remote set-url --push upstream DISABLED     # this clone can never push to the public repo
git remote add origin https://github.com/YOU/argmap-private
git push -u origin main
git push origin upstream/ideas:refs/heads/ideas  # optional: the workflow that merges notepad pull requests
```

From then on:

- **Your thinking goes in the copy**: new files under `arguments/` and
  `claims/`, notepads on its `ideas` branch. Its CI writes its own `digest`
  branch.
- **Updates arrive by themselves.** `.github/workflows/update-from-upstream.yml`
  merges the public `main` into the copy once a day, and from the Actions tab
  (Update from upstream > Run workflow). In a clone, `npm run update` does the
  same merge and leaves the push to you.
- **Change tool files only in the public repository.** Then updates always
  merge cleanly. If an update does conflict with something changed in the copy,
  it stops, names the files and changes nothing.
- **Nothing flows the other way.** The copy only reads from the public
  repository. To offer a fix back, make it on a branch cut from `upstream/main`,
  so it carries none of the copy's history.

One limit: GitHub's built-in token may not push changes to workflow files. When
an update contains one, the workflow stops and says so. Run `npm run update` in
a clone and push, or give the copy a secret named `SYNC_TOKEN` holding a token
that may update workflows.

## Working in rounds

An argument starts coarse. Each round makes it finer:

1. `next` names the most valuable step. Steps that can change the conclusion
   come first.
2. You do it. Usually that means **sharpening** a hand-wavy bet (replacing it
   with more specific claims underneath), or **checking** a specific one and
   recording the source.
3. The change is logged in the argument file with the verdict and the
   resolution it left behind, and `next` names the following step.

**Resolution** is the share of bets that are specific enough to check. A bet is
flagged as hand-wavy when it leans on words like "largely" or "enough", names
no figure, date, place or case, or bundles several claims into one sentence.
These are word-level prompts. They point at where to look; a person or a model
decides what the sharper claim is.

## Predictions: let the world grade it

argmap cannot tell you what is true. It can make being wrong quick to notice
and hard to hide. The rule is: **predict before you check.**

Most bets never resolve by themselves, but checking one does. Before you open a
source, write down what you expect to find and how sure you are. Then look,
and record what you found.

```sh
npm run argmap -- predict arguments/reuse.yaml licence-present \
    --says "Of 60 such repositories drawn at random, at least 51 have a licence file." \
    --how "A repository counts when a LICENSE or COPYING file is at its top level." \
    --type lookup --p 0.8 --if-true 0.97 --if-false 0.15 --sample 60 --needs 51 \
    --due 2026-11-28 --by ann
npm run argmap -- resolve arguments/reuse.yaml licence-present 1 --found 47 \
    --source https://example.org/sample-of-60.csv --by model-x --ai
npm run argmap -- due        # open predictions, most overdue first
npm run argmap -- record     # what each name's predictions show
```

- **A failed test knocks the claim out**, the way a failing test breaks a
  build, when the claim was taken to imply the test and someone who vouches for
  the claim accepted it beforehand. Reword the claim to what was found and it
  stands again; the failure stays on its record. A passed test changes no
  status.
- **Three chances, three jobs.** `--p` is your own chance of a yes and scores
  you. `--if-true` and `--if-false` say how likely a yes is with the claim true
  and with it false, which is how hard the test is. A test the claim would pass
  either way is flagged as soft.
- **The guess must come first.** `verify` refuses a prediction that arrives
  with its outcome, or that is edited or removed afterwards. In a pull request
  the prediction has to be on `main` before its outcome is recorded.
- **A test belongs to its claim.** It carries the claim's fingerprint, cannot
  be moved or copied to another claim, and the claim cannot be reworded while
  an accepted test of it is waiting. The fingerprint takes in the definitions
  of the terms the claim pins, so redefining a word counts as rewording.
- **A record per name, never pooled.** Lookups (the answer already existed) and
  forecasts are scored apart, forecasts by how long they ran, and only on ten
  or more resolved. Each part shows a Brier score, and the score if every open
  or withdrawn prediction went against you. There is no skill score: you chose
  the questions, and any score can be padded with sure things.
- **A record per claim.** How many tests it has survived, counted only where a
  failure would have knocked it out; how hard they were, kept apart by whether
  its own vouchers or someone else typed the figures; how many were withdrawn;
  and how many failed under an earlier wording.
- **Trust labels stay typed.** A record sits beside a label and never sets it.
  A label above `assumed` with nobody's name behind it reads as `assumed`,
  because it claims a check nobody stands behind.
- **Reminders.** `.github/workflows/due.yml` opens an issue each day for every
  prediction that has come due, so nobody has to remember to look.

What this does not close. Someone can look first and predict afterwards; for a
lookup nothing in a repository can prove otherwise. Dates are checked against
commit dates, which are bounded by the parent commit and the present but not
proven. One accepted test with a far due date stops a claim being reworded
until its setter withdraws it. Anyone who can confirm a
claim, or put their own name on its trust label, can vouch for it, including
someone who wants it to fail. A bet nobody vouches for cannot be knocked out by
any test; the report counts those. How hard a test is rests on figures somebody
typed. And a prediction says nothing about a bet that cannot be scored at all. The format
is described in [docs/format.md](docs/format.md).

## The claims database

Claims that more than one argument can use live in `claims/`, as files in the
same format without a conclusion. An argument refers to them by id. A library
claim is pulled into an argument only when something in it rests on that claim
or is opposed by it, so objections recorded against a claim travel with it into
every argument that uses it. `search` looks across the library and every
argument file.

## Peer review

Any claim can carry reviews: who, `confirm` or `reject`, and why. For a bet the
question is whether it is acceptable as stated. For a supported claim it is
whether the support really establishes it.

- People and AI reviewers have the same standing. Either can confirm or reject.
- A review is tied to the wording it judged. Reword or re-support a claim and
  its old reviews are kept but marked stale.
- Reviews do not change statuses. When reviewers disagree the claim is marked
  **split** and goes to the top of `next` as needing adjudication. There is no
  adjudication rule yet; that is the next thing to design.

## Evidence

Any claim can carry evidence records, each with one sentence on what it shows
and a source someone else can open:

| kind | What it is |
| --- | --- |
| `statistic` | A measured figure, with its unit, sample and period |
| `account` | What someone saw or did, ideally first-hand |
| `paper` | A published study |
| `reference` | Any other secondary source: an encyclopedia, a report, a textbook |

Evidence can count **for** or **against** a claim. Records that rest on the
same underlying work share an `origin`, so they count as one source.

The trust label is **not** computed from the evidence. A rule that sets the
label can be gamed by whoever wants a claim to look verified, so the label
stays a typed judgment that reviewers can challenge. The tool only points out
the gap: `corroborated` with fewer than two independent sources attached,
`observed` with no first-hand account, `track-record` with nothing attached,
or a trusted bet with evidence against it.

## Notepads

A notepad is a page of loose thinking about an argument or a single claim. It
is plain Markdown, nothing on it affects a verdict, and nothing on it has to be
checked. Mention a claim as `[[claim-id]]` to tie a note to it. Each page ends
with **Related ideas**: thoughts that could become new claims.

Notepads live on the `ideas` branch, which is never merged into `main`. The
tools read that branch directly and write to it without checking it out, so
you can stay on your working branch:

```sh
npm run argmap -- notepad arguments/my-argument.yaml --by you
npm run argmap -- idea arguments/my-argument.yaml "has anyone checked this? [[a-bet]]" --by you
npm run argmap -- ideas arguments/my-argument.yaml
git push origin ideas
```

Notepads are created on request (`--claim <id>` for one claim), so most
arguments and claims have none. A pull request into `ideas` is approved and
merged automatically when it comes from someone with access to the repository
and changes only notepad files; the workflow is on the `ideas` branch.

## Who said it: signed access

`allowed_signers` lists the public keys of the people and AIs trusted to
contribute, one per line as `name@person` or `name@ai`. Public keys can check
a signature but cannot make one, so the list is safe to publish. What needs
protecting is who can edit it, so it is read from `main`.

```sh
npm run argmap -- verify                  # commits since origin/main
npm run argmap -- verify HEAD~5..HEAD
```

`verify` checks that every commit is signed by a listed key, and that each
review, piece of evidence, log entry and prediction a commit adds is in the
signer's own name and kind. A signer can take back only what is in their own
name: removing someone else's review, evidence or log entry is refused, and so
is changing a trust label that carries someone else's name without taking it
over. A new review must carry the fingerprint of the claim it judged. A commit
cannot be dated before the one it builds on, or after the present. It also
keeps predictions in order: none arrives with its outcome, and none is edited,
moved or removed afterwards.

Statuses are worked out from the files as they stand, so `verify` is an alarm
and not a lock. The digest prints its result at the top: whether every commit
behind it passes, and if not, which do not.

CI runs it on every pull request with `--pull-request`, which also refuses a
prediction and its outcome in the same pull request. The checker and the list
of trusted keys are taken from `main`, so a pull request cannot rewrite the
rules it is judged by. A push to `main` is checked the same way, against the
checker from before the push. Two limits: the workflow file itself comes from
the pull request, and a check on a push can turn a commit red but cannot stop
it. Protecting `main` so that it only changes through pull requests is a
setting on GitHub, not something in this repository. Nobody can record a judgment as someone else, and an AI cannot
record one as a person. A signature shows which key signed; for an AI that
means the agent its operator gave the key to, not which model wrote the text.
Signatures are checked with the public key alone, in the tool itself, so no
extra software is needed. Only `ssh-ed25519` keys are supported so far.

A merge is the one commit that may pass without a listed signature. GitHub
signs the merges its button makes with its own key, and a workflow leaves its
merges unsigned. `verify` redoes the merge and compares: when the merge commit
holds exactly what combining its two parents gives, it adds nothing of its
own, and every line in it comes from a commit that is checked separately. A
merge that was edited (a conflict somebody resolved, or a file changed along
the way) is treated like any other commit: it needs a listed signature, and
what it adds beyond its parents must be in the signer's name. This needs git
2.38 or later and the full history, so in CI fetch with `fetch-depth: 0`.
Merge pull requests with "Create a merge commit"; "Squash" and "Rebase" write
new commits under GitHub's key, which `verify` rejects.

Signing normally needs `ssh-keygen`. Where that is missing, argmap ships a
small helper that does the same job for a key without a passphrase:

```sh
npm run argmap -- use-key ~/.ssh/argmap_key
```

That points this clone's git at the helper and the key, and tells you which
name on the list the key is trusted as. Records you add must be in that name.
Text after a key in `allowed_signers` is a free label, shown by `verify`.

Notepads are deliberately outside this: editing one on GitHub from a phone
produces a commit your own key did not sign, and loose notes do not need the
same guarantee.

## MCP server

`bin/argmap-mcp.mjs` is a Model Context Protocol server over stdio, so an AI
client can read, search, sharpen and review arguments. Point a client at it:

```json
{
  "mcpServers": {
    "argmap": {
      "command": "node",
      "args": ["/path/to/argmap/bin/argmap-mcp.mjs"],
      "env": { "ARGMAP_ROOT": "/path/to/argmap" }
    }
  }
}
```

| Tool | What it does |
| --- | --- |
| `list_arguments`, `report`, `get_claim` | Read arguments, verdicts and claims |
| `next_steps` | The guided loop: what to work on next |
| `search_claims` | Search the claims database |
| `knock_out` | What falls if these claims fail (saves nothing) |
| `create_argument`, `add_claim`, `set_support`, `add_opposition` | Build structure |
| `refine_claim` | Increase resolution: replace a bet with sharper claims |
| `reword_claim`, `set_bet` | Sharpen wording; record the result of a check |
| `add_evidence` | Attach a statistic, account, paper or reference, for or against |
| `add_review` | Record a confirm or reject from a person or an AI |
| `predict`, `accept_test`, `resolve_prediction` | Record what you expect before checking, accept a test on a claim you vouch for, record what was found |
| `mark_overdue`, `confirm_outcome` | Mark a test that is past due; put a second name to an outcome |
| `due_predictions`, `prediction_record` | Open predictions by date; what each name's predictions show |
| `read_ideas`, `create_notepad`, `add_idea` | Read and write notepads on the ideas branch |

Every write is checked before it is saved: a change that would leave the
argument unloadable is refused and nothing is written. Comments and layout in
the YAML files are kept.

## The three statuses

| Status | Meaning |
| --- | --- |
| stands | One whole line of support stands and every objection has fallen. |
| falls | An objection stands, or every line of support has lost a member. |
| contested | Cannot be settled from the file: an open dispute, a circle of support, or something that depends on one. |

These follow from the bets as written. None of them means "true".

## Layout

| Path | What it is |
| --- | --- |
| `docs/format.md` | The argument file format |
| `docs/github-setup.md` | The settings to change by hand on GitHub: branch rules, merge buttons, notifications |
| `arguments/` | Argument files. Each one is data; adding one needs no code. None here: a copy adds its own |
| `claims/` | The shared claims library. None here either |
| `src/` | The engine: parsing, checks, evaluation, analysis, lint, reviews. Deterministic, no AI |
| `src/edit.ts`, `src/mcp.ts` | Safe edits to the files, and the MCP server built on them |
| `src/ideas.ts`, `src/verify.ts`, `src/sign.ts` | Notepads on the ideas branch; checking and making signatures |
| `src/predict.ts`, `src/record.ts` | Predictions: what a test does to a claim, and what each name's predictions show |
| `allowed_signers` | The public list of trusted keys |
| `viewer/` | The interactive page, bundled by `scripts/build.mjs` |
| `src/digest.ts` | The repository written out as Markdown, to read in one pass |
| `.github/workflows/ci.yml` | Tests and `verify` on every pull request; writes the digest to the `digest` branch from `main` |
| `.github/workflows/due.yml`, `scripts/due-issues.mjs` | Opens an issue each day for every prediction that has come due |
| `scripts/update-from-upstream.sh`, `.github/workflows/update-from-upstream.yml` | Bring a private copy up to date with this repository |
| `test/` | Engine, MCP server, digest, workspace and update tests. `test/fixtures/` holds a full-size argument for them |

Turning prose into an argument file is the one step that needs judgment (a
person, or a language model whose draft a person corrects). Everything after
that is computed, so the same file always gives the same answer, and a `git
diff` of an argument file is a record of how a belief changed.
