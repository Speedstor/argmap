# argmap

A build system for beliefs. Write an argument as a plain text file, and argmap
tells you what it rests on, where it is exposed, and what falls when a bet fails.

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
| `add_review` | Record a confirm or reject from a person or an AI |

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
| `viewer/` | The interactive page, bundled by `scripts/build.mjs` |
| `test/` | Engine and MCP server tests |

Turning prose into an argument file is the one step that needs judgment (a
person, or a language model whose draft a person corrects). Everything after
that is computed, so the same file always gives the same answer, and a `git
diff` of an argument file is a record of how a belief changed.
