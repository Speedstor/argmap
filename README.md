# argmap

A build system for beliefs. Write an argument as a plain text file, and argmap
tells you what it rests on, where it is exposed, and what falls when a bet fails.

**Reading this repository?** Start with the
[digest](../../tree/digest): every argument
written out with its verdict, structure, open disputes and next steps. It is
generated from `main` on each push and kept on the `digest` branch.

It does not tell you what is true. Every chain of justification ends somewhere
you chose to stop and trust (Agrippa's trilemma), so argmap makes those stopping
points visible instead of hiding them:

1. **Does the reasoning hold together?** Structure checks, and checks on pinned
   terms so a word cannot quietly change meaning between steps.
2. **What am I trusting?** Every claim with no support is a *bet*, labelled by
   how far it has been checked.
3. **Where am I exposed?** Which bets change the conclusion if they fail, and
   which open disputes the conclusion hinges on.

## Try it

Needs Node 22.18 or later.

```sh
npm install
npm run argmap -- report arguments/second-industrialization.yaml
npm run argmap -- next   arguments/second-industrialization.yaml
npm run argmap -- knock  arguments/second-industrialization.yaml same-inputs
npm run argmap -- search coal
npm run argmap -- review arguments/second-industrialization.yaml same-inputs reject --by you --note "why"
npm run argmap -- view   arguments/second-industrialization.yaml -o dist/map.html
npm run argmap -- init   arguments/my-argument.yaml
npm test
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
npm run argmap -- notepad arguments/second-industrialization.yaml --by you
npm run argmap -- idea arguments/second-industrialization.yaml "what about peat? [[easy-coal-mined-out]]" --by you
npm run argmap -- ideas arguments/second-industrialization.yaml
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
review, piece of evidence and log entry a commit adds is in the signer's own
name and kind. Nobody can record a judgment as someone else, and an AI cannot
record one as a person. A signature shows which key signed; for an AI that
means the agent its operator gave the key to, not which model wrote the text.
Signatures are checked with the public key alone, in the tool itself, so no
extra software is needed. Only `ssh-ed25519` keys are supported so far.

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
| `arguments/` | Argument files. Each one is data; adding one needs no code |
| `claims/` | The shared claims library |
| `src/` | The engine: parsing, checks, evaluation, analysis, lint, reviews. Deterministic, no AI |
| `src/edit.ts`, `src/mcp.ts` | Safe edits to the files, and the MCP server built on them |
| `src/ideas.ts`, `src/verify.ts`, `src/sign.ts` | Notepads on the ideas branch; checking and making signatures |
| `allowed_signers` | The public list of trusted keys |
| `viewer/` | The interactive page, bundled by `scripts/build.mjs` |
| `src/digest.ts` | The repository written out as Markdown, to read in one pass |
| `.github/workflows/ci.yml` | Tests on every change; writes the digest to the `digest` branch from `main` |
| `test/` | Engine, MCP server and digest tests |

Turning prose into an argument file is the one step that needs judgment (a
person, or a language model whose draft a person corrects). Everything after
that is computed, so the same file always gives the same answer, and a `git
diff` of an argument file is a record of how a belief changed.
