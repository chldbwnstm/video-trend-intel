#!/usr/bin/env bash
# Keep the collector's SQLite store (data/store.sqlite) in a GitHub Release asset. OWNER: deploy.
#
#   deploy/ci/store-release.sh restore [--force]   download store.sqlite.gz (fallback store.prev.sqlite.gz) into $STORE_DB
#   deploy/ci/store-release.sh save                guard + upload $STORE_DB as store.sqlite.gz (previous -> store.prev.sqlite.gz)
#   deploy/ci/store-release.sh seed <file.gz> [--force]
#                                                  one-time upload of a local store (deploy/bootstrap.sh); never overwrites
#                                                  an existing remote store unless --force
#   deploy/ci/store-release.sh status              list the release assets
#
# Release layout (tag $STORE_TAG, default "data-store"; a pre-release that is never marked latest):
#   store.sqlite.gz        current store (gzip -9 -n of the checkpointed SQLite file)
#   store.prev.sqlite.gz   the store of the previous run (fallback when the current asset is missing or corrupt)
#
# Guards (a failed guard exits 1 and uploads nothing):
#   - `restore` never silently starts empty when a store asset exists but cannot be downloaded or verified
#     (sha256 digest, gzip -t, SQLite quick_check); set STORE_ALLOW_EMPTY=1 to start over deliberately.
#   - `save` refuses a store that fails quick_check, is more than STORE_MAX_SHRINK_PCT (20) % smaller than the
#     restored one, or has fewer videos / observations than it (the store is append-only); STORE_ALLOW_SHRINK=1
#     overrides. It also refuses when store.sqlite.gz changed on the release since `restore` (someone else uploaded).
#
# Environment: GH_TOKEN (or a logged-in gh), GH_REPO (owner/name; default: the git remote), STORE_TAG,
#   STORE_DB (data/store.sqlite), STORE_WORK (work dir, default $RUNNER_TEMP/vti-store), STORE_MAX_SHRINK_PCT,
#   STORE_ALLOW_SHRINK, STORE_ALLOW_EMPTY. Tokens are never printed.
set -euo pipefail

TAG="${STORE_TAG:-data-store}"
DB="${STORE_DB:-data/store.sqlite}"
WORK="${STORE_WORK:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/vti-store}"
MAX_SHRINK_PCT="${STORE_MAX_SHRINK_PCT:-20}"
ALLOW_SHRINK="${STORE_ALLOW_SHRINK:-0}"
ALLOW_EMPTY="${STORE_ALLOW_EMPTY:-0}"
CUR="store.sqlite.gz"
PREV="store.prev.sqlite.gz"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSPECT="$SCRIPT_DIR/../lib/store-inspect.mjs"
RELEASE_TITLE="Data store"

in_actions() { [ "${GITHUB_ACTIONS:-}" = "true" ]; }
log() { printf 'store: %s\n' "$*" >&2; }
notice() { if in_actions; then printf '::notice title=store::%s\n' "$*" >&2; else log "$*"; fi; }
warn() { if in_actions; then printf '::warning title=store::%s\n' "$*" >&2; else log "WARNING: $*"; fi; }
die() {
  if in_actions; then printf '::error title=store::%s\n' "$*" >&2; else log "ERROR: $*"; fi
  exit 1
}
output() { # key=value lines for later workflow steps
  local kv
  for kv in "$@"; do
    if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s\n' "$kv" >>"$GITHUB_OUTPUT"; fi
  done
}
summary() { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$*" >>"$GITHUB_STEP_SUMMARY"; fi; }

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed"; }

# Run the SQLite inspector; prints KEY=VALUE lines. Extra args: --checkpoint / --require-ok.
inspect() {
  node --disable-warning=ExperimentalWarning "$INSPECT" "$@" --env
}

# Read KEY=VALUE lines (from inspect or the state file) into shell variables. Only STORE_* / BASE_* keys are
# accepted; declare them `local` in the caller to keep them scoped.
load_kv() { # <text>
  local line key value
  while IFS= read -r line; do
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      *[!A-Z0-9_]*) continue ;;
      STORE_?* | BASE_?*) printf -v "$key" '%s' "$value" ;;
    esac
  done <<<"$1"
}

# Asset lines of the release: "name<TAB>size<TAB>id<TAB>digest". Returns 3 when the release does not exist.
release_assets() {
  local err="$WORK/gh-release-view.err" out
  if out="$(gh release view "$TAG" --json assets --jq '.assets[] | [.name, (.size | tostring), .id, (.digest // "-")] | @tsv' 2>"$err")"; then
    printf '%s' "$out"
    return 0
  fi
  if grep -qi 'release not found' "$err"; then return 3; fi
  cat "$err" >&2
  return 1
}

asset_line() { # <assets text> <name>
  printf '%s\n' "$1" | awk -F'\t' -v n="$2" '$1 == n { print; exit }'
}

field() { # <asset line> <1-based field>
  printf '%s\n' "$1" | awk -F'\t' -v i="$2" '{ print $i }'
}

sha256_of() { # read via stdin: sha256sum escapes file names that contain backslashes (Windows paths)
  if command -v sha256sum >/dev/null 2>&1; then sha256sum <"$1" | awk '{ print $1 }'; else shasum -a 256 <"$1" | awk '{ print $1 }'; fi
}

digest_ok() { # <file> <digest from the API or "-">
  case "$2" in
    sha256:*) [ "sha256:$(sha256_of "$1")" = "$2" ] ;;
    *) return 0 ;; # older assets have no digest
  esac
}

download_asset() { # <name> <dir>
  local name="$1" dir="$2" attempt
  mkdir -p "$dir"
  for attempt in 1 2 3; do
    rm -f "$dir/$name"
    if gh release download "$TAG" --pattern "$name" --dir "$dir" --clobber && [ -s "$dir/$name" ]; then return 0; fi
    log "download of $name failed (attempt $attempt/3)"
    sleep $((attempt * 5))
  done
  return 1
}

upload_asset() { # <file> (asset name = file name)
  local file="$1" attempt
  for attempt in 1 2 3; do
    if gh release upload "$TAG" "$file" --clobber; then return 0; fi
    log "upload of $(basename "$file") failed (attempt $attempt/3)"
    sleep $((attempt * 5))
  done
  return 1
}

release_notes() {
  cat <<EOF
Collector SQLite store for the scheduled GitHub Actions pipeline (.github/workflows/collect-deploy.yml).
수집기 SQLite 저장소(원본 관측 이력). 3시간마다 워크플로가 내려받아 수집을 이어 가고 다시 올립니다.

- \`$CUR\`: current store (gzip of data/store.sqlite)
- \`$PREV\`: store of the previous run (automatic fallback)

Do not delete these assets: they hold the only copy of the accumulated observation history.
Contains public video/channel metadata and counters only (credentials are never stored).

${1:-}
EOF
}

ensure_release() {
  local rc=0
  release_assets >/dev/null || rc=$?
  if [ "$rc" -eq 0 ]; then return 0; fi
  if [ "$rc" -ne 3 ]; then die "cannot read release '$TAG'"; fi
  log "creating release '$TAG'"
  gh release create "$TAG" --title "$RELEASE_TITLE" --notes "$(release_notes)" --prerelease --latest=false >/dev/null \
    || die "could not create release '$TAG'"
}

write_state() { # from bytes videos observations cur_id cur_digest
  mkdir -p "$WORK"
  cat >"$WORK/state.env" <<EOF
BASE_FROM=$1
BASE_BYTES=$2
BASE_VIDEOS=$3
BASE_OBSERVATIONS=$4
BASE_CUR_ID=$5
BASE_CUR_DIGEST=$6
EOF
}

cmd_restore() {
  local force="${1:-}"
  mkdir -p "$WORK" "$(dirname "$DB")"
  if [ -e "$DB" ] && [ "$force" != "--force" ]; then
    die "$DB already exists; refusing to overwrite it (pass --force)"
  fi
  local assets rc=0
  assets="$(release_assets)" || rc=$?
  if [ "$rc" -eq 3 ]; then
    notice "release '$TAG' not found: starting with an empty store (it is created on the first save)"
    write_state none 0 0 0 - -
    output restored=false source=none bytes=0 videos=0
    summary "- Store: release \`$TAG\` not found, started empty"
    return 0
  fi
  [ "$rc" -eq 0 ] || die "cannot list release '$TAG' (not starting empty: that could overwrite the stored history)"

  local cur_line cur_id="-" cur_digest="-" tried=0 name line digest info
  cur_line="$(asset_line "$assets" "$CUR")"
  if [ -n "$cur_line" ]; then
    cur_id="$(field "$cur_line" 3)"
    cur_digest="$(field "$cur_line" 4)"
  fi
  for name in "$CUR" "$PREV"; do
    line="$(asset_line "$assets" "$name")"
    [ -n "$line" ] || continue
    tried=1
    digest="$(field "$line" 4)"
    log "restoring $name ($(field "$line" 2) bytes)"
    download_asset "$name" "$WORK/dl" || die "could not download $name from release '$TAG' (not starting empty: that could overwrite the stored history)"
    if ! digest_ok "$WORK/dl/$name" "$digest"; then warn "$name: sha256 digest mismatch, skipping"; continue; fi
    if ! gzip -t "$WORK/dl/$name" 2>/dev/null; then warn "$name: not a valid gzip file, skipping"; continue; fi
    rm -f "$DB.restore"
    gzip -dc "$WORK/dl/$name" >"$DB.restore"
    if info="$(inspect "$DB.restore" --require-ok)"; then
      rm -f "$DB" "$DB-wal" "$DB-shm"
      mv "$DB.restore" "$DB"
      local STORE_BYTES=0 STORE_VIDEOS=0 STORE_OBSERVATIONS=0
      load_kv "$info"
      write_state "$name" "$STORE_BYTES" "${STORE_VIDEOS:-0}" "${STORE_OBSERVATIONS:-0}" "$cur_id" "$cur_digest"
      [ "$name" = "$CUR" ] || warn "restored the PREVIOUS store ($PREV): $CUR was missing or unusable"
      log "restored $name -> $DB: $STORE_BYTES bytes, ${STORE_VIDEOS:-0} videos, ${STORE_OBSERVATIONS:-0} observations"
      output restored=true "source=$name" "bytes=$STORE_BYTES" "videos=${STORE_VIDEOS:-0}"
      summary "- Store: restored \`$name\` ($STORE_BYTES bytes, ${STORE_VIDEOS:-0} videos, ${STORE_OBSERVATIONS:-0} observations)"
      return 0
    fi
    warn "$name failed the SQLite check, skipping"
    rm -f "$DB.restore"
  done

  if [ "$tried" -eq 1 ]; then
    if [ "$ALLOW_EMPTY" = "1" ]; then
      warn "no usable store asset; starting EMPTY because STORE_ALLOW_EMPTY=1"
      write_state none 0 0 0 "$cur_id" "$cur_digest"
      output restored=false source=none bytes=0 videos=0
      summary "- Store: no usable asset, started empty (STORE_ALLOW_EMPTY=1)"
      return 0
    fi
    die "release '$TAG' has store assets but none passed verification; fix or delete them, or run with STORE_ALLOW_EMPTY=1 to start over"
  fi
  notice "release '$TAG' has no store asset yet: starting with an empty store"
  write_state none 0 0 0 "$cur_id" "$cur_digest"
  output restored=false source=none bytes=0 videos=0
  summary "- Store: release \`$TAG\` has no store asset yet, started empty"
}

cmd_save() {
  [ -f "$WORK/state.env" ] || die "no restore state at $WORK/state.env: run '$0 restore' first"
  local BASE_FROM=none BASE_BYTES=0 BASE_VIDEOS=0 BASE_OBSERVATIONS=0 BASE_CUR_ID=- BASE_CUR_DIGEST=-
  load_kv "$(cat "$WORK/state.env")"
  [ -f "$DB" ] || die "no store at $DB; nothing to upload"

  local info STORE_BYTES=0 STORE_VIDEOS=0 STORE_OBSERVATIONS=0 STORE_CHECK="" STORE_ERROR=""
  info="$(inspect "$DB" --checkpoint --require-ok)" || {
    load_kv "$info"
    die "$DB failed the SQLite check (${STORE_ERROR:-$STORE_CHECK}); not uploading"
  }
  load_kv "$info"
  STORE_VIDEOS="${STORE_VIDEOS:-0}"
  STORE_OBSERVATIONS="${STORE_OBSERVATIONS:-0}"
  log "collected store: $STORE_BYTES bytes, $STORE_VIDEOS videos, $STORE_OBSERVATIONS observations (restored: $BASE_BYTES bytes, $BASE_VIDEOS videos, $BASE_OBSERVATIONS observations from $BASE_FROM)"

  # Corruption guard: the store only grows (videos and observations are never deleted).
  if [ "$ALLOW_SHRINK" != "1" ] && [ "$BASE_BYTES" -gt 0 ]; then
    if [ $((STORE_BYTES * 100)) -lt $((BASE_BYTES * (100 - MAX_SHRINK_PCT))) ]; then
      die "store shrank from $BASE_BYTES to $STORE_BYTES bytes (more than $MAX_SHRINK_PCT%); not uploading (STORE_ALLOW_SHRINK=1 overrides)"
    fi
    if [ "$STORE_VIDEOS" -lt "$BASE_VIDEOS" ] || [ "$STORE_OBSERVATIONS" -lt "$BASE_OBSERVATIONS" ]; then
      die "store lost rows (videos $BASE_VIDEOS -> $STORE_VIDEOS, observations $BASE_OBSERVATIONS -> $STORE_OBSERVATIONS); not uploading (STORE_ALLOW_SHRINK=1 overrides)"
    fi
  fi

  mkdir -p "$WORK/up" "$WORK/prev"
  rm -f "$WORK/up/$CUR"
  gzip -9 -n -c "$DB" >"$WORK/up/$CUR"
  gzip -t "$WORK/up/$CUR" || die "gzip of $DB is not valid"
  local gz_bytes gz_sha
  gz_bytes="$(wc -c <"$WORK/up/$CUR" | tr -d ' ')"
  gz_sha="$(sha256_of "$WORK/up/$CUR")"

  # The release must still be in the state we restored from (the workflow's concurrency group serializes runs;
  # this catches a manual upload or a bootstrap seed that happened in between).
  local assets rc=0 cur_line now_id="-" now_digest="-"
  assets="$(release_assets)" || rc=$?
  if [ "$rc" -eq 3 ]; then
    [ "$BASE_FROM" = "none" ] || die "release '$TAG' disappeared since restore; not uploading"
    ensure_release
    assets=""
  elif [ "$rc" -ne 0 ]; then
    die "cannot read release '$TAG'; not uploading"
  fi
  cur_line="$(asset_line "$assets" "$CUR")"
  if [ -n "$cur_line" ]; then
    now_id="$(field "$cur_line" 3)"
    now_digest="$(field "$cur_line" 4)"
  fi
  if [ "$now_id" != "$BASE_CUR_ID" ] || [ "$now_digest" != "$BASE_CUR_DIGEST" ]; then
    die "$CUR on release '$TAG' changed since restore (another upload?); not overwriting it. Re-run the workflow."
  fi

  # Keep the store we started from as the fallback copy.
  if [ "$BASE_FROM" = "$CUR" ] && [ -s "$WORK/dl/$CUR" ]; then
    cp "$WORK/dl/$CUR" "$WORK/prev/$PREV"
    upload_asset "$WORK/prev/$PREV" || die "could not upload $PREV; current store left untouched"
  fi
  upload_asset "$WORK/up/$CUR" || die "could not upload $CUR ($PREV still holds the previous store)"

  # Verify what landed on the release.
  assets="$(release_assets)" || die "cannot re-read release '$TAG' after upload"
  cur_line="$(asset_line "$assets" "$CUR")"
  [ -n "$cur_line" ] || die "$CUR is missing after upload"
  [ "$(field "$cur_line" 2)" = "$gz_bytes" ] || die "$CUR size on the release ($(field "$cur_line" 2)) differs from the local file ($gz_bytes)"
  case "$(field "$cur_line" 4)" in
    sha256:*) [ "$(field "$cur_line" 4)" = "sha256:$gz_sha" ] || die "$CUR digest on the release differs from the local file" ;;
  esac

  local stamp run_url=""
  stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ -n "${GITHUB_RUN_ID:-}" ]; then run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/$GITHUB_RUN_ID"; fi
  gh release edit "$TAG" --notes "$(release_notes "Last update: $stamp · videos $STORE_VIDEOS · observations $STORE_OBSERVATIONS · $STORE_BYTES bytes (gzip $gz_bytes)${run_url:+ · run $run_url}")" >/dev/null \
    || warn "could not update the release notes (the store itself was uploaded)"

  log "uploaded $CUR: $gz_bytes bytes gzip ($STORE_BYTES bytes raw)"
  output uploaded=true "bytes=$STORE_BYTES" "gzip_bytes=$gz_bytes" "videos=$STORE_VIDEOS" "observations=$STORE_OBSERVATIONS"
  summary "- Store: uploaded \`$CUR\` ($STORE_BYTES bytes raw, $gz_bytes gzip; $STORE_VIDEOS videos, $STORE_OBSERVATIONS observations)"
}

cmd_seed() {
  local gz="${1:-}" force="${2:-}"
  [ -n "$gz" ] || die "usage: $0 seed <store.sqlite.gz> [--force]"
  [ -s "$gz" ] || die "$gz not found or empty"
  gzip -t "$gz" || die "$gz is not a valid gzip file"
  mkdir -p "$WORK/seed"
  local check="$WORK/seed/check.sqlite" info STORE_BYTES=0 STORE_VIDEOS=0 STORE_OBSERVATIONS=0 STORE_ERROR="" STORE_CHECK=""
  rm -f "$check"
  gzip -dc "$gz" >"$check"
  info="$(inspect "$check" --require-ok)" || {
    load_kv "$info"
    rm -f "$check"
    die "$gz does not contain a healthy SQLite store (${STORE_ERROR:-$STORE_CHECK})"
  }
  rm -f "$check"
  load_kv "$info"

  ensure_release
  local assets cur_line
  assets="$(release_assets)" || die "cannot read release '$TAG'"
  cur_line="$(asset_line "$assets" "$CUR")"
  if [ -n "$cur_line" ] && [ "$force" != "--force" ]; then
    log "release '$TAG' already has $CUR ($(field "$cur_line" 2) bytes); keeping it (pass --force to replace it with the local store)"
    return 0
  fi
  if [ -n "$cur_line" ]; then
    download_asset "$CUR" "$WORK/dl" || die "could not download the existing $CUR to keep it as $PREV"
    mkdir -p "$WORK/prev"
    cp "$WORK/dl/$CUR" "$WORK/prev/$PREV"
    upload_asset "$WORK/prev/$PREV" || die "could not upload $PREV"
  fi
  mkdir -p "$WORK/up"
  cp "$gz" "$WORK/up/$CUR"
  upload_asset "$WORK/up/$CUR" || die "could not upload $CUR"
  gh release edit "$TAG" --notes "$(release_notes "Seeded from a local collection: $(date -u +%Y-%m-%dT%H:%M:%SZ) · videos ${STORE_VIDEOS:-0} · observations ${STORE_OBSERVATIONS:-0} · $STORE_BYTES bytes")" >/dev/null || true
  log "uploaded $CUR to release '$TAG' (${STORE_VIDEOS:-0} videos, ${STORE_OBSERVATIONS:-0} observations)"
}

cmd_status() {
  local assets rc=0
  assets="$(release_assets)" || rc=$?
  if [ "$rc" -eq 3 ]; then
    log "release '$TAG' not found"
    return 0
  fi
  [ "$rc" -eq 0 ] || die "cannot read release '$TAG'"
  if [ -z "$assets" ]; then
    log "release '$TAG' has no assets"
    return 0
  fi
  printf '%s\n' "$assets" | awk -F'\t' '{ printf "%-24s %12s bytes  %s\n", $1, $2, $4 }'
}

main() {
  need gh
  need node
  need gzip
  mkdir -p "$WORK"
  local cmd="${1:-}"
  [ $# -gt 0 ] && shift
  case "$cmd" in
    restore) cmd_restore "$@" ;;
    save) cmd_save ;;
    seed) cmd_seed "$@" ;;
    status) cmd_status ;;
    *)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
      exit 2
      ;;
  esac
}

main "$@"
