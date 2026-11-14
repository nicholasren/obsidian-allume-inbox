#!/usr/bin/env bash
# ./go — the single entry point for developing, releasing and maintaining
# the Allume Inbox Obsidian plugin. Run `./go help` for the commands.
set -euo pipefail

cd "$(dirname "$0")"

REPO="nicholasren/obsidian-allume-inbox"
PLUGIN_ID="$(node -p 'require("./manifest.json").id' 2>/dev/null || echo allume-inbox)"
ASSETS=(main.js manifest.json styles.css)

# ------------------------------------------------------------------ helpers

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '\033[36m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed. $2"; }

version() { node -p 'require("./manifest.json").version'; }

ensure_deps() {
  if [ ! -d node_modules ]; then
    info "Installing dependencies"
    npm ci --no-audit --no-fund
  fi
}

ensure_clean() {
  [ -z "$(git status --porcelain)" ] || die "Working tree has uncommitted changes. Commit or stash them first."
}

ensure_main() {
  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  [ "$branch" = "main" ] || die "Releases are made from main (you're on $branch)."
}

# ------------------------------------------------------------------ commands

cmd_help() {
  cat <<EOF
$(bold "./go — Allume Inbox plugin")

Develop
  setup                 Install dependencies (npm ci)
  dev                   Rebuild main.js on every change
  test                  Run the test suite
  lint                  Run Obsidian's lint rules (same family as the directory's review)
  build                 Type-check and build main.js
  check                 lint + test + build: everything a release needs
  install [vault]       Build, then copy the plugin into a vault
                        (vault path, or \$OBSIDIAN_VAULT). Reload the plugin afterwards.

Release
  status                Current version, latest GitHub release, unreleased commits
  bump <patch|minor|major|x.y.z>
                        Set the version in manifest.json, package.json and versions.json
  release [patch|minor|major|x.y.z]
                        check → bump (optional) → commit → tag → push → GitHub release
                        with main.js, manifest.json and styles.css attached.
                        Obsidian picks up the new version from the release.

Maintain
  outdated              Show outdated dependencies
  update                Update dependencies within their ranges, then run check
  clean                 Remove build output and node_modules

Examples
  ./go check
  ./go install ~/Documents/MyVault
  ./go release patch
EOF
}

cmd_setup() { npm ci --no-audit --no-fund; ok "Dependencies installed"; }

cmd_dev() { ensure_deps; npm run dev; }

cmd_test() { ensure_deps; npm test; }

cmd_lint() { ensure_deps; npx eslint .; ok "Lint passed"; }

cmd_build() { ensure_deps; npm run build; ok "Built main.js ($(wc -c <main.js | tr -d ' ') bytes)"; }

cmd_check() {
  ensure_deps
  info "Lint";  npx eslint .
  info "Test";  npm test --silent >/tmp/allume-inbox-test.log 2>&1 || { cat /tmp/allume-inbox-test.log; die "Tests failed"; }
  grep -E '^# (pass|fail)' /tmp/allume-inbox-test.log || true
  info "Build"; npm run build --silent
  ok "All checks passed for $(version)"
}

cmd_install() {
  local vault="${1:-${OBSIDIAN_VAULT:-}}"
  [ -n "$vault" ] || die "Give a vault path, or set OBSIDIAN_VAULT."
  [ -d "$vault/.obsidian" ] || die "$vault doesn't look like an Obsidian vault (no .obsidian folder)."
  cmd_build
  local dest="$vault/.obsidian/plugins/$PLUGIN_ID"
  mkdir -p "$dest"
  cp "${ASSETS[@]}" "$dest/"
  ok "Installed $(version) into $dest"
  info "In Obsidian: Settings → Community plugins → turn Allume Inbox off and on to reload."
}

cmd_status() {
  local v latest
  v="$(version)"
  echo "Version in manifest: $v"
  if command -v gh >/dev/null 2>&1; then
    latest="$(gh release view --repo "$REPO" --json tagName -q .tagName 2>/dev/null || echo none)"
    echo "Latest GitHub release: $latest"
    if [ "$latest" != "none" ] && git rev-parse -q --verify "refs/tags/$latest" >/dev/null; then
      echo "Commits since $latest:"
      git log --oneline "$latest"..HEAD | sed 's/^/  /' || true
    fi
  fi
  git status --short --branch
}

# Write a new version into manifest.json, package.json(+lock) and versions.json.
cmd_bump() {
  local kind="${1:-}"
  [ -n "$kind" ] || die "Usage: ./go bump <patch|minor|major|x.y.z>"
  local next
  next="$(node -e '
    const [maj, min, pat] = require("./manifest.json").version.split(".").map(Number);
    const k = process.argv[1];
    if (/^\d+\.\d+\.\d+$/.test(k)) console.log(k);
    else if (k === "patch") console.log(`${maj}.${min}.${pat + 1}`);
    else if (k === "minor") console.log(`${maj}.${min + 1}.0`);
    else if (k === "major") console.log(`${maj + 1}.0.0`);
    else process.exit(1);
  ' "$kind")" || die "Unknown version kind: $kind"
  npm version "$next" --no-git-tag-version --allow-same-version >/dev/null
  npm_package_version="$next" node version-bump.mjs
  ok "Version is now $next"
}

cmd_release() {
  need gh "Install it with: brew install gh"
  gh auth status >/dev/null 2>&1 || die "gh isn't signed in. Run: gh auth login"
  ensure_main
  ensure_clean

  info "Syncing with origin"
  git pull --ff-only --quiet

  if [ -n "${1:-}" ]; then
    cmd_bump "$1"
  fi
  local v
  v="$(version)"
  git rev-parse -q --verify "refs/tags/$v" >/dev/null && die "Tag $v already exists. Bump the version: ./go release patch"
  gh release view "$v" --repo "$REPO" >/dev/null 2>&1 && die "Release $v already exists on GitHub."

  cmd_check

  if [ -n "$(git status --porcelain)" ]; then
    git add manifest.json package.json package-lock.json versions.json
    git commit --quiet -m "Release $v"
    ok "Committed version $v"
  fi

  # Obsidian requires the tag to equal the manifest version, with no "v" prefix.
  git tag -a "$v" -m "$v"
  git push --quiet origin main "$v"
  ok "Pushed main and tag $v"

  gh release create "$v" "${ASSETS[@]}" --repo "$REPO" --title "$v" --generate-notes --verify-tag
  ok "Released $v: https://github.com/$REPO/releases/tag/$v"
}

cmd_outdated() { ensure_deps; npm outdated || true; }

cmd_update() {
  ensure_deps
  npm update --no-audit --no-fund
  cmd_check
  info "Review the changes in package-lock.json, then commit them."
}

cmd_clean() { rm -rf node_modules main.js; ok "Cleaned"; }

# ------------------------------------------------------------------ dispatch

command="${1:-help}"
shift || true
case "$command" in
  help|-h|--help) cmd_help ;;
  setup|dev|test|lint|build|check|install|status|bump|release|outdated|update|clean)
    "cmd_$command" "$@" ;;
  *) cmd_help; echo; die "Unknown command: $command" ;;
esac
