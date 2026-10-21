#!/usr/bin/env bash
# Publish the ReelBolt Claude Code plugin to its public mirror.
# Source of truth: plugins/reelbolt/ in the ReelBolt source repository.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./publish.sh [--check] <mirror-repo-dir>

  <mirror-repo-dir>  A checkout of the public mirror
                     (github.com/vecchiotom/reelbolt-claude-plugin).

  --check            Compare instead of publishing; exit 1 if the mirror is stale.
EOF
}

check_only=false
if [[ "${1:-}" == "--check" ]]; then
  check_only=true
  shift
fi

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 2
fi

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dst="$(cd "$1" 2>/dev/null && pwd)" || {
  echo "error: $1 is not a directory" >&2
  exit 1
}

if [[ ! -d "$dst/.git" ]]; then
  echo "error: $dst is not a git checkout of the mirror" >&2
  exit 1
fi

if $check_only; then
  if diff -ru --exclude=.git "$src" "$dst"; then
    echo "mirror is up to date"
    exit 0
  fi
  echo "mirror is stale; run ./publish.sh $dst" >&2
  exit 1
fi

if [[ -n "$(git -C "$dst" status --porcelain)" ]]; then
  echo "error: $dst has uncommitted changes; commit or discard them first" >&2
  exit 1
fi

rsync -a --delete --exclude=.git "$src"/ "$dst"/

if [[ -z "$(git -C "$dst" status --porcelain)" ]]; then
  echo "mirror already matches; nothing to commit"
  exit 0
fi

git -C "$dst" add -A
git -C "$dst" commit -m "Publish ReelBolt Claude Code plugin $(date -u +%Y-%m-%d)"
git -C "$dst" push -u origin HEAD
echo "published to $(git -C "$dst" remote get-url origin)"
