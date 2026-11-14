# The argument file format (version 1)

An argument is one YAML file.

```yaml
argmap: 1
title: A question worth mapping
conclusion: main-claim        # the id of the claim everything else is about

terms:                        # pinned definitions
  collapse: What "collapse" means everywhere it is pinned.
  bank#river: The side of a river.          # word#sense for a word with two meanings
  bank#money: A company that holds deposits.

claims:
  main-claim:
    text: After a {collapse}, the {bank#river|riverbank} floods.
    because: [reason-a, reason-b]           # both needed

  reason-a:
    text: ...
    because:                                # alternatives: either line is enough
      - [x, y]
      - [z]

  reason-b:
    text: ...
    bet:                                    # no "because", so this is a bet
      trust: corroborated
      note: Where this comes from, and why you stopped here.
      cost: high                            # optional: low | medium | high
      by: ann                               # optional: who set the label. They vouch for the bet

attacks:
  - [objection, reason-a]     # if objection stands, reason-a falls

disputes:
  - [reason-b, rival]         # each attacks the other; neither is settled
```

## Claims

Each claim has an id (the key) and a `text`. A claim written as a bare string
is shorthand for a claim with only text. Optional fields: `label` (a short name
for the map; defaults to the id with hyphens as spaces) and `note`.

`because` lists what the claim rests on:

- one id, or a flat list of ids: one line of support, all of it needed;
- a list of lists: alternative lines of support, any one of which is enough.

## Bets

A claim with no `because` is a **bet**: a place where you stop justifying and
trust. Label it with how far it has been checked.

| trust | Meaning |
| --- | --- |
| `observed` | You saw it yourself. |
| `corroborated` | Independent sources agree. |
| `track-record` | This kind of claim or source has held up before. |
| `assumed` | Not checked. |

`bet: assumed` is shorthand for `bet: { trust: assumed }`. A leaf with no bet is
treated as `assumed` and reported with a warning. A claim cannot have both
support and a bet.

## Pinned terms

A word the argument turns on should mean one thing throughout. Define it under
`terms` and write it in claim text as `{key}`, or `{key|shown text}` when the
sentence needs a different form of the word.

When a word really is used in two senses, define both as `word#sense`. The
engine then reports:

- **sense-shift**: the same word in different senses along one chain of support
  (equivocation: the chain looks valid but is not);
- **sense-clash**: an objection that uses the word in a different sense from
  its target (the two may be talking past each other);
- **term-unpinned**: a defined word used outside a marker, where it is free to drift;
- **term-once** and **term-unused**: a definition that ties nothing together.

## Opposition

- `attacks: [[a, b]]` is one-way: if `a` stands, `b` falls.
- `disputes: [[a, b]]` is an open disagreement: each attacks the other, so both
  stay contested until you pick a side. Use this when you do not know who is right.

## How statuses are computed

Everything starts as contested. A claim is settled only when the rules force it:

- a bet stands when every claim attacking it has fallen;
- a supported claim stands when one whole line of support stands and every
  attacker has fallen;
- a claim falls when an attacker stands, or when every line of support has a
  fallen member.

This is the grounded labelling from abstract argumentation (Dung, 1995),
extended with support. The result does not depend on the order of the file.

"Knocking out" a claim treats it as false and recomputes. For each open dispute
the engine reports the conclusion under each outcome, and for up to ten disputes
it counts how the conclusion comes out across every way of settling them.

## The claims library

Files under `claims/` use the same sections (`terms`, `claims`, `attacks`,
`disputes`) but have no `title` or `conclusion`. An argument file can rest on a
library claim just by naming its id. When an argument is loaded:

- every claim in the argument file is kept;
- a library claim is included when an included claim rests on it, or when the
  library records it as attacking or disputing an included claim;
- a library term is included when an included claim pins it;
- an id defined in two files is an error.

`argmap bundle <file>` prints the argument with everything it drew from the
library inlined, as one self-contained file.

## Evidence

```yaml
claims:
  some-bet:
    text: ...
    bet: { trust: corroborated }
    evidence:
      - kind: statistic         # statistic | account | paper | reference
        stance: for             # for (default) | against
        says: Brazil produces about 10 million tonnes of pig iron a year using charcoal.
        value: 10
        unit: Mt per year
        sample: Brazilian pig iron made with charcoal
        period: about 2007
        source: https://fao.org/4/i1321e/i1321e04.pdf
        origin: ...             # optional: the underlying work, if the source reports on it
        by: aldrin
        date: 2026-11-14
      - kind: account
        says: The pit was worked by hand to about 15 m.
        witness: J. Smith, miner
        first_hand: true
      - kind: paper
        says: ...
        source: doi:10.1000/example
        peer_reviewed: true
```

`says` is required. Records with the same `origin` (or, without one, the same
`source`) count as one independent source. The trust label stays typed; the
engine warns with `trust-unbacked` when the label claims more than the
attached evidence shows, with `evidence-against` when a trusted bet has
evidence against it, and with `evidence-unsourced` when a record gives nothing
to look up.

## Predictions

A prediction is a test of a claim, written down before the answer is known.

```yaml
claims:
  licence-present:
    text: At least 9 in 10 public repositories with over 1,000 stars carry a licence file.
    bet: { trust: assumed, by: ann }      # by: who set the label, and so vouches for the bet
    predictions:
      - says: Of 60 such repositories drawn at random, at least 51 have a licence file.
        how: Draw 60 from the public list. A repository counts when a LICENSE or COPYING file is at its top level.
        type: lookup          # lookup: the answer already exists. forecast: it does not yet
        p: 0.8                # the setter's own chance of a yes
        if_true: 0.97         # the chance of a yes if the claim is true (default 1)
        if_false: 0.15        # the chance of a yes if the claim is false
        sample: 60            # optional: how many independent cases are looked at
        needs: 51             #           and how many must agree for a yes
        by: ann
        kind: person
        made: 2026-11-14
        due: 2026-11-28
        rev: e84ce6ae         # fingerprint of the claim wording this tests
        # Everything below is added later, each part once.
        accepted:
          - { by: ann, kind: person, date: 2026-11-14 }
        outcome: no           # yes | no | void
        found: 47             # with a sample: how many agreed. The outcome follows from it
        resolved: 2026-11-20
        resolved_by: model-x
        resolved_kind: ai
        source: https://example.org/sample-of-60.csv
        confirmed:
          - { by: ann, kind: person, date: 2026-11-21 }
```

The three chances do different jobs:

- `p` scores the setter, and is used for nothing else.
- `if_true` and `if_false` say how hard the test is. A yes that is no likelier
  with the claim true than with it false shows nothing. Hardness is counted in
  bits, `log2(if_true / if_false)`: one bit means a yes is twice as likely with
  the claim true.

**What a failed test does.** It knocks the claim out when three things hold:
it tested the present wording, the claim was taken to imply a yes (`if_true` is
0.95 or more), and someone who vouches for the claim accepted the test before
the outcome. The claim then falls, like one you knocked out by hand, until it
is reworded. Rewording changes the fingerprint, so the old test stops counting
for the status and stays on the claim's record. A failed test that misses any
of the three is evidence against the claim, and is reported as such.

**What a passed test does.** Nothing to any status. It is added to what the
claim has survived.

**Who vouches.** Whoever is named on the bet (`bet.by`, written when a trust
label is set), and every reviewer whose confirmation of the present wording
stands. Anyone may set a test. If the setter vouches for the claim, setting it
is accepting it; otherwise it waits for a voucher to accept it.

**Overdue.** After the due date, anyone may add `overdue: { by, kind, date }`.
If the test was accepted, the claim cannot stand until someone records the
outcome. The engine has no clock: the status changes because the file did.

**Samples.** For a claim about many cases, one case settles nothing. Fix
`sample` and `needs` before looking, and say in `how` the way the cases are
picked. Cases that rest on the same source count once. The outcome is not
typed: it follows from `found`.

**Withdrawing.** A prediction is never deleted. To withdraw one, record the
outcome `void` with a `note`. Withdrawals are counted on the setter's record.

The engine reports:

- **test-failed**: a failed test knocked the claim out;
- **test-against**: a failed test that counts only as evidence against;
- **test-overdue**: an accepted test is marked overdue and holds the claim back;
- **test-unvouched**: a test is waiting for someone who vouches for the claim;
- **test-soft**: `if_false` is missing, or a yes is less than twice as likely
  with the claim true;
- **test-inconsistent**: `p` does not lie between `if_false` and `if_true`;
- **credence-label**: the three chances imply the setter believes the claim
  less than even, while labelling it `observed` or `corroborated`;
- **test-one-case**: a claim about many cases is tested on one.

`argmap verify` enforces the order. A prediction must arrive without its
outcome, in the signer's own name. Its fixed fields (everything down to `rev`)
never change, and it is never removed. An acceptance must come from someone
who vouches for the claim, before the outcome. An outcome is recorded once, in
the signer's name. With `--pull-request`, a prediction and its outcome may not
arrive in the same range of commits.

## Reviews

```yaml
claims:
  some-claim:
    text: ...
    reviews:
      - by: aldrin          # a person's name or a model name
        kind: person        # person | ai; both count the same
        verdict: reject     # confirm | reject
        note: The 1840s is too early.
        date: 2026-11-14
        rev: 3fa9c21e       # fingerprint of the wording that was judged
```

`rev` is written by the tools. It is a fingerprint of the claim's text and
support, so a review of an older wording is recognised as stale and stops
counting. A review written by hand without `rev` is treated as current. Each
reviewer's newest review replaces their earlier one.

A claim's review state is `unreviewed`, `confirmed` (no current rejection),
`rejected` (no current confirmation) or `split` (both). Review state never
changes whether a claim stands; a split claim waits for adjudication.

## The log

```yaml
log:
  - at: 2026-11-13
    by: claude-fable-5.2
    did: refine             # create, add, refine, rewire, reword, check, evidence, review, attack, dispute,
                            # predict, accept, resolve, overdue, confirm
    claim: easy-coal-mined-out
    note: Why the change was made.
    verdict: contested      # the conclusion after this round
    bets: 17                # how many bets the argument rests on
    sharp: 4                # how many of them are specific enough to check
```

The tools append one entry per change, so the file records how the verdict and
the resolution moved over time.

## Other checks

- **circular-support**: claims that rest on each other with no bet underneath.
- **orphan**: a claim that neither supports nor opposes anything leading to the
  conclusion.
