#!/usr/bin/env bash
# One-time, idempotent setup of the live site on GitHub. OWNER: deploy.
# Run from Git Bash (Windows) or any bash, after committing the project:
#
#   bash deploy/bootstrap.sh [--repo owner/name] [--remote origin] [--branch main]
#                            [--no-store] [--force-store] [--secrets] [--no-push] [--no-run] [-h]
#
# Every step checks the current state first, so re-running is safe:
#   1. checks git, gh (logged in), node >= 22.13, gzip; HEAD must contain .github/workflows/collect-deploy.yml
#   2. creates the public repository (gh repo create) if it does not exist
#   3. adds the git remote if missing (an existing remote that points elsewhere is never rewritten)
#   4. uploads the local store (data/store.sqlite -> data/store.sqlite.gz) to the "data-store" release so the
#      first scheduled run continues the local history; an existing remote store is kept unless --force-store
#   5. --secrets: copies collector credentials from .env to repository secrets/variables (values never printed)
#   6. enables GitHub Pages with build_type=workflow (POST; PUT when Pages already exists)
#   7. pushes HEAD to main (fast-forward only, never forced) and makes main the default branch
#   8. triggers the collect-deploy workflow and prints the site URL
#
# Tokens are never printed: gh keeps its own credentials, secrets are piped on stdin.
set -euo pipefail

REPO="chldbwnstm/video-trend-intel"
REMOTE="origin"
BRANCH="main"
TAG="data-store"
WORKFLOW="collect-deploy.yml"
DO_STORE=1
FORCE_STORE=0
DO_SECRETS=0
DO_PUSH=1
DO_RUN=1

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
log() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mWARNING:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[31mERROR:\033[0m %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?--repo needs owner/name}"; shift 2 ;;
    --repo=*) REPO="${1#*=}"; shift ;;
    --remote) REMOTE="${2:?--remote needs a name}"; shift 2 ;;
    --remote=*) REMOTE="${1#*=}"; shift ;;
    --branch) BRANCH="${2:?--branch needs a name}"; shift 2 ;;
    --branch=*) BRANCH="${1#*=}"; shift ;;
    --no-store) DO_STORE=0; shift ;;
    --force-store) FORCE_STORE=1; shift ;;
    --secrets) DO_SECRETS=1; shift ;;
    --no-push) DO_PUSH=0; shift ;;
    --no-run) DO_RUN=0; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done
case "$REPO" in
  */*) ;;
  *) die "--repo must be owner/name (got '$REPO')" ;;
esac
OWNER="${REPO%%/*}"
NAME="${REPO#*/}"
SITE_URL="https://$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]').github.io/$NAME/"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
TMP="$(mktemp -d 2>/dev/null || mktemp -d -t vti-bootstrap)"
trap 'rm -rf "$TMP"' EXIT

# Remote URLs may embed credentials (https://user:token@github.com/...): never print them as-is.
redact_url() { printf '%s' "$1" | sed -E 's#(://)[^@/]+@#\1***@#'; }

# ---------------------------------------------------------------------------------------------- 1. checks
log "1/8 checking tools"
for tool in git gh node gzip; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' is not installed (gh: https://cli.github.com/)"
done
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "Node.js >= 22.13 is required (node:sqlite); found $(node -v)"
gh auth status --hostname github.com >/dev/null 2>&1 || die "gh is not logged in: run 'gh auth login'"
# Only the scopes line is kept (the status output also mentions the masked token; it is never echoed).
scopes="$(gh auth status --hostname github.com 2>&1 | grep -i 'token scopes' || true)"
if [ -n "$scopes" ] && ! grep -q "workflow" <<<"$scopes"; then
  warn "the gh token has no 'workflow' scope; pushing .github/workflows over HTTPS will fail. Run: gh auth refresh -h github.com -s workflow"
fi
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$ROOT is not a git repository"
git rev-parse --verify -q HEAD >/dev/null || die "no commits yet: commit the project first"
git cat-file -e "HEAD:.github/workflows/$WORKFLOW" 2>/dev/null \
  || die "HEAD does not contain .github/workflows/$WORKFLOW: commit it first"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  warn "uncommitted changes are not published (only HEAD is pushed)"
fi
for f in data/store.sqlite.gz apps/web/public/data/dataset.json; do
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    warn "$f is committed; it is generated data and should stay out of git"
  fi
done

# ---------------------------------------------------------------------------------------------- 2. repository
log "2/8 repository $REPO"
if gh repo view "$REPO" --json name >/dev/null 2>&1; then
  visibility="$(gh repo view "$REPO" --json visibility --jq .visibility 2>/dev/null || echo unknown)"
  echo "    exists ($visibility)"
  if [ "$visibility" != "PUBLIC" ]; then
    warn "the repository is not public: GitHub Pages on private repositories needs a paid plan, and the published site is public anyway"
  fi
else
  gh repo create "$REPO" --public \
    --description "Video Trend Intel — 기간·플랫폼·분야별 인기 영상과 크리에이터 인텔리전스 (Tubular형, 공개 데이터 기반)" \
    --homepage "$SITE_URL" >/dev/null
  echo "    created (public)"
fi

# ---------------------------------------------------------------------------------------------- 3. remote
log "3/8 git remote '$REMOTE'"
# The configured URL as written (git remote get-url would apply url.*.insteadOf rewrites).
remote_url="$(git config --get "remote.$REMOTE.url" 2>/dev/null || true)"
if [ -z "$remote_url" ]; then
  git remote add "$REMOTE" "https://github.com/$REPO.git"
  echo "    added https://github.com/$REPO.git"
else
  normalized="$(printf '%s' "$remote_url" | sed -E 's#^(https?://([^@/]+@)?github\.com/|ssh://git@github\.com/|git@github\.com:)##; s#\.git$##; s#/$##' | tr '[:upper:]' '[:lower:]')"
  wanted="$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')"
  [ "$normalized" = "$wanted" ] || die "remote '$REMOTE' points to $(redact_url "$remote_url"), not $REPO (use --remote <other name>)"
  echo "    $(redact_url "$remote_url")"
fi

# ---------------------------------------------------------------------------------------------- 4. store
log "4/8 SQLite store -> release '$TAG'"
if [ "$DO_STORE" = 0 ]; then
  echo "    skipped (--no-store)"
elif [ ! -f data/store.sqlite ]; then
  warn "no local data/store.sqlite: the first workflow run collects from scratch"
else
  if [ ! -s data/store.sqlite.gz ] || [ data/store.sqlite -nt data/store.sqlite.gz ]; then
    echo "    checking and compressing data/store.sqlite (stop a running collector/server first)"
    node --disable-warning=ExperimentalWarning deploy/lib/store-inspect.mjs data/store.sqlite --checkpoint --require-ok >"$TMP/inspect.json" \
      || die "data/store.sqlite failed the SQLite check: $(cat "$TMP/inspect.json")"
    gzip -9 -n -c data/store.sqlite >data/store.sqlite.gz.tmp
    mv -f data/store.sqlite.gz.tmp data/store.sqlite.gz
  fi
  echo "    data/store.sqlite.gz: $(wc -c <data/store.sqlite.gz | tr -d ' ') bytes"
  git check-ignore -q data/store.sqlite.gz \
    || warn "data/store.sqlite.gz is not git-ignored: do not commit it (add 'data/*.sqlite.gz' to .gitignore)"
  # A release needs its tag on GitHub. Before main exists there, push the tag from HEAD
  # (tag pushes do not trigger the workflows, which run on branch pushes only).
  if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 \
    && ! git ls-remote --exit-code --tags "$REMOTE" "refs/tags/$TAG" >/dev/null 2>&1; then
    git push "$REMOTE" "HEAD:refs/tags/$TAG"
  fi
  seed_args=(seed data/store.sqlite.gz)
  if [ "$FORCE_STORE" = 1 ]; then seed_args+=(--force); fi
  GH_REPO="$REPO" STORE_TAG="$TAG" STORE_WORK="$TMP/store" bash deploy/ci/store-release.sh "${seed_args[@]}"
fi

# ---------------------------------------------------------------------------------------------- 5. secrets
log "5/8 repository secrets"
if [ "$DO_SECRETS" = 1 ]; then
  node deploy/lib/set-secrets.mjs --repo "$REPO" --env .env \
    || warn "some secrets/variables were not set (see above); add them under Settings > Secrets and variables > Actions"
else
  echo "    skipped (pass --secrets to copy YOUTUBE_API_KEY, TIKTOK_*, IG_*, X_*, TWITCH_* from .env)"
fi

# ---------------------------------------------------------------------------------------------- 6. pages
enable_pages() {
  local build_type
  if build_type="$(gh api "repos/$REPO/pages" --jq .build_type 2>/dev/null)"; then
    if [ "$build_type" = "workflow" ]; then
      echo "    already enabled (build_type workflow)"
      return 0
    fi
    gh api -X PUT "repos/$REPO/pages" -f build_type=workflow --silent || return 1
    echo "    switched from '$build_type' to build_type workflow"
    return 0
  fi
  if gh api -X POST "repos/$REPO/pages" -f build_type=workflow --silent 2>"$TMP/pages.err"; then
    echo "    enabled (build_type workflow)"
    return 0
  fi
  if grep -qiE '409|already' "$TMP/pages.err"; then
    gh api -X PUT "repos/$REPO/pages" -f build_type=workflow --silent || return 1
    echo "    already existed; set build_type workflow"
    return 0
  fi
  sed 's/^/    /' "$TMP/pages.err" >&2
  return 1
}
log "6/8 GitHub Pages (build_type workflow)"
pages_ok=1
enable_pages || pages_ok=0
if [ "$pages_ok" = 0 ]; then echo "    not yet (retried after the push)"; fi

# ---------------------------------------------------------------------------------------------- 7. push
log "7/8 push HEAD -> $REPO $BRANCH"
if [ "$DO_PUSH" = 1 ]; then
  git push "$REMOTE" "HEAD:refs/heads/$BRANCH" \
    || die "push failed. Non-fast-forward: pull/rebase first (this script never forces). HTTPS credentials: 'gh auth setup-git'. Workflow files need the 'workflow' token scope."
else
  echo "    skipped (--no-push)"
fi
if git ls-remote --exit-code --heads "$REMOTE" "refs/heads/$BRANCH" >/dev/null 2>&1; then
  default_branch="$(gh repo view "$REPO" --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null || true)"
  if [ -n "$default_branch" ] && [ "$default_branch" != "$BRANCH" ]; then
    # Scheduled workflows only run on the default branch.
    gh repo edit "$REPO" --default-branch "$BRANCH" >/dev/null && echo "    default branch: $default_branch -> $BRANCH"
  fi
fi
if [ "$pages_ok" = 0 ]; then
  enable_pages || warn "could not enable Pages: Settings > Pages > Build and deployment > Source: GitHub Actions"
fi

# ---------------------------------------------------------------------------------------------- 8. run
log "8/8 trigger $WORKFLOW"
if [ "$DO_RUN" = 1 ]; then
  # Re-enable in case GitHub disabled the schedule after 60 days without activity (404 before the first push: ignored).
  gh api -X PUT "repos/$REPO/actions/workflows/$WORKFLOW/enable" --silent >/dev/null 2>&1 || true
  triggered=0
  for attempt in 1 2 3 4 5 6; do
    if gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$BRANCH" >/dev/null 2>"$TMP/run.err"; then
      triggered=1
      break
    fi
    sleep $((attempt * 5)) # a freshly pushed workflow takes a moment to register
  done
  if [ "$triggered" = 1 ]; then
    echo "    started; follow it with: gh run watch --repo $REPO   (or https://github.com/$REPO/actions)"
  else
    sed 's/^/    /' "$TMP/run.err" >&2
    warn "could not trigger $WORKFLOW; start it from https://github.com/$REPO/actions/workflows/$WORKFLOW"
  fi
else
  echo "    skipped (--no-run)"
fi

url="$(gh api "repos/$REPO/pages" --jq .html_url 2>/dev/null || true)"
echo
log "site: ${url:-$SITE_URL}"
echo "    (the first deployment appears when the workflow finishes, usually within 10 minutes)"
echo "    API keys: Settings > Secrets and variables > Actions (see README), or re-run with --secrets"
