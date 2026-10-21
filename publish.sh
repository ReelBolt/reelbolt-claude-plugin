#!/usr/bin/env bash
# Publish the ReelBolt Claude Code plugin to its public mirror.
# Source of truth: plugins/reelbolt/ in the ReelBolt source repository.
#
# The payload is built from the COMMITTED tree (`git archive HEAD`), never from
# the working directory, so an untracked or ignored file cannot reach a public
# repository even by accident.
set -euo pipefail

expected_origin="${REELBOLT_PLUGIN_MIRROR_URL:-https://github.com/vecchiotom/reelbolt-claude-plugin.git}"

usage() {
  cat <<'EOF'
Usage: ./publish.sh [--check] <mirror-repo-dir>

  <mirror-repo-dir>  A checkout of the public mirror
                     (github.com/vecchiotom/reelbolt-claude-plugin).

  --check            Compare instead of publishing; exit 1 if the mirror is stale,
                     dirty, or has commits that were never pushed.

The plugin directory must be clean and committed: untracked or ignored files are
refused, because only the committed tree is published.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

# Compare remotes independent of the transport and the trailing .git.
normalize_origin() {
  local url="$1"
  url="${url%.git}"
  url="${url#ssh://git@github.com/}"
  url="${url#git@github.com:}"
  url="${url#https://github.com/}"
  url="${url#http://github.com/}"
  printf '%s' "$url"
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

# Resolve through a symlink: a copied or symlinked publisher must not be able to
# publish whichever directory happens to contain it.
script="$(readlink -f "${BASH_SOURCE[0]}")" || die "cannot resolve this script"
src="$(dirname "$script")"

[[ -f "$src/.claude-plugin/plugin.json" ]] \
  || die "$src is not the ReelBolt plugin (no .claude-plugin/plugin.json)"
grep -q '"name": *"reelbolt"' "$src/.claude-plugin/plugin.json" \
  || die "$src is not the ReelBolt plugin (plugin.json does not name reelbolt)"
if [[ -n "$(find "$src" -type l -print -quit)" ]]; then
  die "$src contains symbolic links; refusing to publish them"
fi

source_root="$(git -C "$src" rev-parse --show-toplevel 2>/dev/null)" \
  || die "$src is not inside a git repository"
[[ -z "$(git -C "$src" status --porcelain --ignored -- .)" ]] \
  || die "$src has uncommitted or ignored files; commit or remove them first (only committed content is published)"
prefix="$(git -C "$src" rev-parse --show-prefix)"
[[ -n "$prefix" ]] || die "$src is the repository root; run this from the plugin directory"

[[ -L "$1" ]] && die "$1 is a symlink; pass the mirror checkout itself"
dst="$(cd "$1" 2>/dev/null && pwd -P)" || die "$1 is not a directory"
[[ -d "$dst/.git" ]] || die "$dst is not a git checkout of the mirror"

origin="$(git -C "$dst" remote get-url origin 2>/dev/null)" || die "$dst has no origin remote"
[[ "$(normalize_origin "$origin")" == "$(normalize_origin "$expected_origin")" ]] \
  || die "$dst's origin is $origin, not the public mirror ($expected_origin)"

branch="$(git -C "$dst" symbolic-ref --quiet --short HEAD)" \
  || die "$dst is on a detached HEAD"
local_head="$(git -C "$dst" rev-parse --verify HEAD 2>/dev/null || true)"
remote_head="$(git -C "$dst" rev-parse --verify "refs/remotes/origin/$branch" 2>/dev/null || true)"

workspace="$(mktemp -d)"
trap 'rm -rf "$workspace"' EXIT

# The payload is the committed tree under the plugin directory, nothing else.
payload="$workspace/payload"
mkdir -p "$payload"
git -C "$source_root" archive --format=tar "HEAD:${prefix%/}" | tar -x -C "$payload"

# Defence in depth: refuse the obvious credential shapes before anything leaves.
secret_hits="$(grep -rInE \
  '(BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{20,})' \
  "$payload" || true)"
[[ -z "$secret_hits" ]] || die "refusing to publish: possible secret in the payload:
$secret_hits"

if $check_only; then
  [[ -n "$remote_head" ]] || { echo "mirror has no origin/$branch to compare against" >&2; exit 1; }
  [[ -z "$(git -C "$dst" status --porcelain)" ]] || { echo "mirror has uncommitted changes" >&2; exit 1; }
  [[ "$local_head" == "$remote_head" ]] || { echo "mirror has commits that were never pushed" >&2; exit 1; }
  if diff -ru --exclude=.git "$payload" "$dst"; then
    echo "mirror is up to date"
    exit 0
  fi
  echo "mirror is stale; run ./publish.sh $dst" >&2
  exit 1
fi

[[ -z "$(git -C "$dst" status --porcelain)" ]] \
  || die "$dst has uncommitted changes; commit or discard them first"
if [[ -n "$local_head" && -n "$remote_head" && "$local_head" != "$remote_head" ]]; then
  die "$dst has commits that were never pushed; push or reset them first"
fi

rsync -a --delete --exclude=.git "$payload"/ "$dst"/

if [[ -z "$(git -C "$dst" status --porcelain)" ]]; then
  echo "mirror already matches; nothing to commit"
  exit 0
fi

# Stage exactly the payload's paths plus the mirror's tracked paths, so a stray
# file in the checkout can never be swept in by `git add -A`.
manifest="$workspace/manifest"
{
  (cd "$payload" && find . -mindepth 1 -type f -print0 | sed -z 's|^\./||')
  git -C "$dst" ls-files -z
} | sort -zu > "$manifest"

# Never run the mirror's own hooks: a checkout is not a trusted place to execute code.
hooks="$workspace/hooks"
mkdir -p "$hooks"
# The public mirror commits under the maintainer's GitHub noreply address, never
# a personal mailbox; both are overridable.
commit_name="${REELBOLT_PLUGIN_COMMIT_NAME:-Tommaso Celano}"
commit_email="${REELBOLT_PLUGIN_COMMIT_EMAIL:-vecchiotom@users.noreply.github.com}"
git -c core.hooksPath="$hooks" -C "$dst" add -A \
  --pathspec-from-file="$manifest" --pathspec-file-nul
git -c user.name="$commit_name" -c user.email="$commit_email" \
  -c core.hooksPath="$hooks" -C "$dst" commit \
  -m "Publish ReelBolt Claude Code plugin $(date -u +%Y-%m-%d)"
git -c core.hooksPath="$hooks" -C "$dst" push -u origin HEAD
echo "published to $origin"
