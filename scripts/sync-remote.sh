#!/usr/bin/env bash
set -euo pipefail

repo=/srv/yczx_musicvote
branch=main
service=yczx-musicvote.service

cd "$repo"
git fetch --quiet origin "$branch"

if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  logger -t yczx-musicvote-sync "Skipped: repository has local changes"
  exit 1
fi

local_commit=$(git rev-parse HEAD)
remote_commit=$(git rev-parse FETCH_HEAD)
if [[ "$local_commit" == "$remote_commit" ]]; then
  exit 0
fi

# Only follow fast-forward updates; never overwrite remote history or local-only commits.
if ! git merge-base --is-ancestor "$local_commit" "$remote_commit"; then
  logger -t yczx-musicvote-sync "Skipped: local and remote histories diverged"
  exit 1
fi

git reset --hard "$remote_commit"
systemctl restart "$service"
systemctl is-active --quiet "$service"
logger -t yczx-musicvote-sync "Updated to $remote_commit and restarted $service"
