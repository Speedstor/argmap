# Setting up the repository on GitHub

Some of argmap's setup lives in GitHub's settings, not in files, so nothing in
the repository can do it for you. This page lists every one of those steps.
It takes about ten minutes. Use a browser: the GitHub phone app does not show
repository settings.

Do the steps in this order. Steps 1 to 5 are for any repository that holds
argmap. Step 6 is only for a private copy.

| Step | What | Needed for |
| --- | --- | --- |
| 1 | Let Actions approve pull requests | Notepads that merge by themselves |
| 2 | Protect `main` with a ruleset | `verify` being a lock, not only an alarm |
| 3 | Limit the merge button | Merges that `verify` accepts |
| 4 | Turn on notifications for issues | Reminders when a prediction comes due |
| 5 | Run the checks once | Knowing the setup works |
| 6 | Extra steps for a private copy | Updates from the public repository |

## 1. Let Actions approve pull requests

Settings > Actions > General > Workflow permissions. Tick **Allow GitHub
Actions to create and approve pull requests**, and save.

The workflow on the `ideas` branch approves and merges pull requests that
change only notepad files. Without this setting it cannot approve anything.
Skip this step if you do not use notepads.

## 2. Protect `main` with a ruleset

Do this after CI has run on `main` at least once. Until then the check you
need to pick does not exist.

Settings > Rules > Rulesets > New ruleset > New branch ruleset.

| Setting | Value | Why |
| --- | --- | --- |
| Ruleset name | Anything, for example "main needs CI" | |
| Enforcement status | Active | A disabled ruleset does nothing |
| Bypass list | Empty | Nobody skips the rules, the owner included |
| Target branches | Add target > Include default branch | See the warning below |
| Restrict deletions | On | `main` cannot be deleted |
| Block force pushes | On | History on `main` cannot be rewritten |
| Require a pull request before merging | On | A direct push would skip the check |
| Required approvals | 0 | See below |
| Allowed merge methods | Merge only | See step 3 |
| Require status checks to pass | On, with the check `test` | Runs the tests and `argmap verify` |
| Require branches to be up to date before merging | On | The check runs again when `main` has moved |

Three things that are easy to get wrong:

- **Target the default branch only, never all branches.** CI replaces the
  `digest` branch with a force push on every change to `main`, and the
  `ideas` branch merges by itself. A rule on every branch breaks both.
- **Required approvals stays at 0 unless a second person reviews.** GitHub
  does not let anyone approve their own pull request. If you are the only
  person, or an AI agent opens pull requests under your account, a required
  approval can never be given and nothing can be merged.
- **There is no separate check for `verify`.** GitHub lists checks by job,
  and `verify` is a step inside the job `test`. The check only shows in the
  search box if it ran in the last few days.

What it costs: `main` can no longer be edited from the GitHub website, and
every change goes through a pull request. Notepads are not affected.

What it does not do: the workflow file that runs the check comes from the
pull request itself. A pull request that changes `.github/`, `src/verify.ts`
or `allowed_signers` gets a warning in its CI run; read it before merging.

## 3. Limit the merge button

Settings > General > Pull Requests.

- Leave **Allow merge commits** ticked.
- Untick **Allow squash merging** and **Allow rebase merging**. Both write
  new commits under GitHub's own key, which `verify` refuses.
- Optional: tick **Automatically delete head branches**, so merged branches
  do not pile up.

The ruleset in step 2 already allows merge commits only. This step removes
the other two buttons, so nobody presses one and wonders why it is refused.

## 4. Turn on notifications for issues

On the repository's main page: Watch > Custom > tick **Issues** > Apply. In
the GitHub phone app, allow notifications.

Once a day a workflow opens an issue for each prediction that has come due
and has no outcome. The issue is the reminder, so it only works if issues
reach you.

GitHub switches scheduled workflows off after 60 days with no activity in a
repository. If reminders stop, open the Actions tab and run **Predictions
due** by hand; that switches it back on.

## 5. Run the checks once

1. Actions > **Predictions due** > Run workflow. It should pass. With no
   prediction due it opens no issue.
2. Actions > **CI**. The newest run on `main` should be green.
3. Open the `digest` branch and read `README.md`. Under "History check" it
   should say that every commit passes `argmap verify`.

## 6. Extra steps for a private copy

Create the copy as the README describes under "Keep a private copy". Then:

- **Updates that change a workflow file need a token.** GitHub's built-in
  token may not push changes to workflow files. Create a fine-grained
  personal access token for the copy with read and write access to
  **Contents** and **Workflows**. Add it under Settings > Secrets and
  variables > Actions > New repository secret, with the name `SYNC_TOKEN`.
  Without it, an update that touches a workflow stops and says so, and you
  run `npm run update` in a clone instead.
- **To follow a different repository,** add a variable named
  `ARGMAP_UPSTREAM` in the same place, with the value `owner/name`.
- **Do steps 1, 3, 4 and 5 in the copy as well.**
- **Do not copy the ruleset from step 2 as it is.** The update workflow
  pushes its merge straight to `main`. A rule that requires a pull request,
  or a status check, refuses that push, and updates stop arriving. In a copy,
  a ruleset on `main` with only **Restrict deletions** and **Block force
  pushes** is safe. This has not been tried: no copy has had a ruleset yet.
- **Rulesets on a private repository need a paid plan.** GitHub offers them
  on public repositories with GitHub Free, and on private ones with GitHub
  Pro, Team or Enterprise Cloud.

## What is not on this page

- Adding a signing key: see "Who said it: signed access" in the README. A
  key is added by a pull request that changes `allowed_signers`.
- Everything that lives in files: the workflows, the tests and the tool
  itself arrive with the repository.
