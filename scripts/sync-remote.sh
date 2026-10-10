#!/usr/bin/env bash
set -euo pipefail

repo=/srv/yczx_musicvote
branch=main
service=yczx-musicvote.service

cd "$repo"
logger -t yczx-musicvote-sync "Checking origin/$branch for updates"
git fetch --quiet origin "$branch"

local_commit=$(git rev-parse HEAD)
remote_commit=$(git rev-parse FETCH_HEAD)
if [[ "$local_commit" == "$remote_commit" ]]; then
  logger -t yczx-musicvote-sync "Already current at $remote_commit"
  exit 0
fi

logger -t yczx-musicvote-sync "Force replacing local $local_commit with origin/$branch $remote_commit"
git reset --hard "$remote_commit"
git clean -fd
systemctl restart "$service"
systemctl is-active --quiet "$service"
logger -t yczx-musicvote-sync "Updated to $remote_commit and restarted $service"
