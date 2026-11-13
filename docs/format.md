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

## Other checks

- **circular-support**: claims that rest on each other with no bet underneath.
- **orphan**: a claim that neither supports nor opposes anything leading to the
  conclusion.
