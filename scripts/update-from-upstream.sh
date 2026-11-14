#!/usr/bin/env bash
# Bring a private copy of argmap up to date with the public repository.
#
#   scripts/update-from-upstream.sh [upstream-url] [branch]
#
# Merges the upstream branch into the branch that is checked out. It only ever
# reads from upstream, and it pushes nowhere: the caller decides what to do with
# the result.
#
# Exit codes
#   0  already up to date, or merged
#   1  this repository is not a copy of upstream, or something else went wrong
#   2  the update conflicts with changes made here; the merge was undone
#   3  the update changes workflow files and ALLOW_WORKFLOW_CHANGES is not 1
set -euo pipefail

url="${1:-https://github.com/Speedstor/argmap.git}"
branch="${2:-main}"
target="refs/remotes/upstream/$branch"

# Upstream is public, so it is read without credentials. In GitHub Actions the
# checkout leaves a token that belongs to this repository only.
git -c "http.https://github.com/.extraheader=" fetch --quiet --no-tags "$url" "+refs/heads/$branch:$target"

if git merge-base --is-ancestor "$target" HEAD; then
  echo "Already up to date with upstream $branch."
  exit 0
fi

base="$(git merge-base "$target" HEAD || true)"
if [ -z "$base" ]; then
  echo "This repository shares no history with $url, so it is not a copy of it."
  exit 1
fi

workflows="$(git diff --name-only "$base" "$target" -- .github/workflows)"
if [ -n "$workflows" ] && [ "${ALLOW_WORKFLOW_CHANGES:-0}" != "1" ]; then
  echo "This update changes workflow files:"
  printf '%s\n' "$workflows" | sed 's/^/  /'
  echo "GitHub's built-in token is not allowed to push those. Either run this"
  echo "script from a clone and push the result yourself, or add a secret named"
  echo "SYNC_TOKEN holding a token that may update workflows."
  exit 3
fi

count="$(git rev-list --count "HEAD..$target")"
if ! git merge --no-edit -m "Update from upstream: $count commit(s)" "$target"; then
  echo "The update conflicts with changes made in this copy, in:"
  git diff --name-only --diff-filter=U | sed 's/^/  /'
  git merge --abort
  echo "Nothing was changed. Merge by hand: git merge upstream/$branch"
  exit 2
fi
echo "Merged $count commit(s) from upstream $branch."
