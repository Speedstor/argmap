# The ideas branch

This branch holds notepads: pages of loose thinking about an argument or a
single claim. Nothing here affects any verdict, and nothing here has to be
checked, pinned or reviewed. The strict side of argmap lives on `main`.

- `ideas/<argument>.md` is the notepad for an argument.
- `ideas/claims/<claim-id>.md` is the notepad for one claim.

Notepads are created on request, so most arguments and claims have none.

## Writing

Write anything under **Notes**. To tie a note to a claim, mention it as
`[[claim-id]]`. End the page with **Related ideas**: thoughts that could become
new claims. When one is promoted into a claim on `main`, it is held to the
usual standard there.

You can edit a notepad right here on GitHub, or use the tools:

```sh
argmap notepad arguments/<file>.yaml --by <name>
argmap idea arguments/<file>.yaml "a thought about [[some-claim]]" --by <name>
argmap ideas arguments/<file>.yaml
```

The tools read this branch directly. It is never merged into `main`.

## Pull requests

A pull request into this branch is approved and merged automatically when it
comes from someone with access to the repository and changes only notepad
files (`ideas/**/*.md`). Anything else waits for a person.
