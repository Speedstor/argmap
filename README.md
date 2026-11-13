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
npm run argmap -- knock  arguments/second-industrialization.yaml easy-coal-mined-out
npm run argmap -- view   arguments/second-industrialization.yaml -o dist/map.html
npm run argmap -- init   arguments/my-argument.yaml
npm test
```

`view` writes one self-contained HTML page: a map of the argument where you can
knock out any claim, side with either party in a dispute, and watch the verdict
change. The page can also load any other argument file by paste or upload.

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
| `src/` | The engine: parsing, checks, evaluation, analysis. Deterministic, no AI |
| `viewer/` | The interactive page, bundled by `scripts/build.mjs` |
| `arguments/` | Argument files. Each one is data; adding one needs no code |
| `test/` | Engine tests |

Turning prose into an argument file is the one step that needs judgment (a
person, or a language model whose draft a person corrects). Everything after
that is computed, so the same file always gives the same answer, and a `git
diff` of an argument file is a record of how a belief changed.
