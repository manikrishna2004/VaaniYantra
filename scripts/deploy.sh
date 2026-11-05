#!/usr/bin/env bash
# Deploy VaaniYantra. RUNS ON THE VM, not on a dev machine.
#
#   From the dev machine:
#     git archive --format=tar.gz -o vaani-src.tar.gz <sha>
#     gcloud compute scp vaani-src.tar.gz vaani-vm:~/ --zone us-east1-b
#   Then on the VM:
#     bash ~/vaani/scripts/deploy.sh --tarball ~/vaani-src.tar.gz
#     bash ~/vaani/scripts/deploy.sh --rollback   # restore the previous build
#
# THIS VM HAS NO GIT and ~/vaani is not a clone — deploys have always been
# tar + scp (ROADMAP §6). The --ref/git path is kept for a box that does have a
# clone, but it is not the path used here.
#
# Invoke with `bash`, not `./` — tarball deploys strip the execute bit, which is
# how the nightly backup silently died for two days in August 2026
# (docs/DISASTER_RECOVERY.md §3.5).
#
# ─── Why this script is shaped the way it is ────────────────────────────────
#
# Every step below is a lesson from a real failure. Do not "simplify" one
# without reading its comment first.
#
#  1. BUILD ON THE VM. A locally-built .next is not portable: Turbopack bakes a
#     content-hashed reference to the resolved Prisma client into the server
#     chunks, and a Windows dev box generates different engines than this Linux
#     box. Shipping a local build kills every route at startup with
#     "Cannot find module @prisma/client-<hash>". Cost a failed deploy 2026-08-09.
#
#  2. BUILD IN A SEPARATE DIRECTORY so production keeps serving from its own
#     .next throughout. The swap at the end is near-instant.
#
#  3. HARDLINK node_modules with `cp -al`. A symlink fails — Turbopack rejects
#     one pointing outside the project root.
#
#  4. `next build`, NEVER `npm run build`. The npm script runs `prisma generate`
#     first, which rewrites the generated client the RUNNING build resolves —
#     breaking production mid-build and taking the rollback path with it.
#
#  5. CAP THE BUILD HEAP. Shared vCPUs with swap; the cap makes the OOM
#     killer prefer the build over the live server.
#
#  5b. DO NOT DEPLOY FROM AN e2-micro. The build shares this box with
#     production, and on 1 GB it no longer fits: on 2026-08-25 it ran past 56
#     minutes, wrote its .next/BUILD_ID, then never exited — thrashing with
#     1.2 GB in swap at ~0.2% CPU. That starved the live site to 19-SECOND
#     responses with /api/health returning 503, and had to be killed by hand.
#     This VM is an e2-medium (4 GB) for that reason and the same build now
#     takes ~80 seconds. If it is ever sized down, resize up for the deploy and
#     back afterwards — and note e2-micro is the SMALLEST of the three
#     (micro 1 GB < small 2 GB < medium 4 GB), which is easy to get backwards.
#
#  6. VERIFY THE ARTIFACT BEFORE TOUCHING PRODUCTION.
#
#  7. HEALTH-GATE BOTH SERVICES and roll back automatically. The web app and the
#     voice server fail independently; a green :3000 says nothing about :8080.
set -euo pipefail

# ─── Run from a private copy ────────────────────────────────────────────────
# Bash does not read a script into memory: it reads incrementally, by byte
# offset, as it executes. `git pull` below rewrites THIS FILE, so on any deploy
# that changes deploy.sh, bash would resume partway through the new content and
# execute whatever happens to sit at that offset — arbitrary fragments of shell,
# mid-deploy, with production half-swapped.
#
# So copy ourselves to /tmp and re-exec from there before touching git. The copy
# is then unlinked immediately: Linux keeps it readable through the descriptor
# bash already holds, so this both works and leaves nothing behind.
if [[ "${VAANI_DEPLOY_REEXEC:-}" != "1" ]]; then
  _self_copy="$(mktemp /tmp/vaani-deploy.XXXXXX.sh)"
  cat "${BASH_SOURCE[0]}" > "$_self_copy"
  VAANI_DEPLOY_REEXEC=1 exec bash "$_self_copy" "$@"
fi
case "${BASH_SOURCE[0]}" in /tmp/vaani-deploy.*) rm -f "${BASH_SOURCE[0]}" ;; esac

APP_DIR="${APP_DIR:-$HOME/vaani}"
BUILD_DIR="${BUILD_DIR:-$HOME/vaani-build}"
# Build heap cap — HALF of physical RAM, so it scales with the box.
#
# It was a hardcoded 700 (sized for the original 1 GB e2-micro) and stayed 700
# through two resizes, which is the whole reason for computing it: a number
# tuned to a machine goes stale silently the moment that machine changes, and
# nothing fails loudly enough to notice. Half leaves ample room for the build's
# non-heap RSS plus the live web and voice servers, so note 5 still holds — the
# OOM killer reaches the build before it reaches production.
#
# Falls back to the old 700 on a 1 GB box or if /proc/meminfo can't be read.
# An explicit HEAP_MB in the environment always wins.
#
# The gate is 1536, not 2048: a nominally "2 GB" e2-small actually reports
# MemTotal ≈ 2004 MB once the kernel takes its share, so a 2048 threshold would
# quietly drop e2-small back to the 700 fallback. Nominal size is never the
# reported figure — compare against something safely below it.
_mem_total_mb=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null || echo 0)
if [[ "${_mem_total_mb:-0}" -ge 1536 ]]; then
  HEAP_MB="${HEAP_MB:-$(( _mem_total_mb / 2 ))}"
else
  HEAP_MB="${HEAP_MB:-700}"
fi
WEB_URL="${WEB_URL:-http://localhost:3000/api/health}"
VOICE_URL="${VOICE_URL:-http://localhost:8080/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_SLEEP="${HEALTH_SLEEP:-2}"
LOCK_FILE="/tmp/vaani-deploy.lock"
LOG_FILE="${LOG_FILE:-$HOME/vaani-deploy.log}"

# Off-VM backup destination for the pre-deploy dump. The nightly cron sets this
# in its own environment, which a deploy does NOT inherit — so without it here,
# the one backup taken immediately before a risky change was the one backup that
# existed only on the disk we were about to change. Set to empty to opt out.
GCS_BUCKET="${GCS_BUCKET:-gs://vaaniyantra-db-backups}"
export GCS_BUCKET

REF=""
TARBALL=""
DRY_RUN=0
ROLLBACK=0
STATUS=0
SKIP_BACKUP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="${2:-}"; shift 2 ;;
    --tarball) TARBALL="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --status) STATUS=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    # Not `sed "$0"` — we re-exec from a copy that is then unlinked, so there is
    # no file left to read our own comments out of.
    -h|--help)
      cat <<'USAGE'
Deploy VaaniYantra. RUNS ON THE VM, not on a dev machine.

  bash deploy.sh --tarball ~/vaani-src.tar.gz    deploy an uploaded source tarball
  bash deploy.sh --ref BRANCH                    deploy a git ref (needs git on this box)
  bash deploy.sh --dry-run                       build + verify, do not swap
  bash deploy.sh --rollback                      restore the previous build
  bash deploy.sh --status                        is a deploy running? + recent log
  bash deploy.sh --skip-backup                   skip the pre-deploy pg_dump

This VM has no git and ~/vaani is not a clone, so --tarball is the real path
here. Build it on the dev machine with:

  git archive --format=tar.gz -o vaani-src.tar.gz <sha>
  gcloud compute scp vaani-src.tar.gz vaani-vm:~/ --zone us-east1-b

Invoke with `bash`, not `./` — tarball deploys strip the execute bit.
USAGE
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\n\033[1m[deploy %s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\033[33m[deploy] WARNING: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m[deploy] FATAL: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] && die "do not run as root — pm2 and the app run as your user"
[[ -d "$APP_DIR" ]] || die "APP_DIR not found: $APP_DIR"

# ─── Status ─────────────────────────────────────────────────────────────────
# Must run BEFORE the lock is taken below, since it only *tests* the lock.
#
# ⚠ Do NOT reimplement this with `pgrep -f deploy`. A pattern like that matches
# the shell running the check itself — the command line contains the pattern —
# so it reports a deploy in progress forever. That is not hypothetical: it is
# exactly what happened while watching the 2026-08-11 deploy, which reported
# RUNNING for 13 minutes after it had finished. The lock is the truth: it is
# held for precisely as long as a deploy is running, and by nothing else.
if [[ $STATUS -eq 1 ]]; then
  # Without flock we cannot tell, and MUST say so. Reporting a guess here would
  # repeat the bug this whole block exists to prevent — the danger is not being
  # uncertain, it is being confidently wrong.
  if ! command -v flock >/dev/null; then
    echo "cannot determine: flock is not installed on this box"
  else
    exec 8>"$LOCK_FILE"
    if flock -n 8; then
      echo "no deploy running"
      flock -u 8
    else
      echo "DEPLOY IN PROGRESS (lock held: $LOCK_FILE)"
    fi
  fi
  if [[ -f "$LOG_FILE" ]]; then
    echo "--- last 20 lines of $LOG_FILE ---"
    tail -20 "$LOG_FILE"
  else
    echo "(no log at $LOG_FILE yet)"
  fi
  exit 0
fi

# One deploy at a time. Two concurrent runs would race on the .next swap and
# could leave production with no .next at all.
#
# Checked separately so a MISSING flock reports itself, rather than surfacing as
# the confusing "another deploy is already running" on a box where none is.
command -v flock >/dev/null || die "flock not found — refusing to deploy without the concurrency lock"
exec 9>"$LOCK_FILE"
flock -n 9 || die "another deploy is already running (lock: $LOCK_FILE)"

# Everything from here is a real run — record it. Without this the only log is
# whatever the caller happened to redirect, which is nothing when the deploy is
# launched over ssh and the session goes away.
exec > >(tee -a "$LOG_FILE") 2>&1
echo "=== deploy started $(date -Is) ==="

# ─── Health gate ────────────────────────────────────────────────────────────
# Polls until both services answer or the budget runs out. Returns non-zero on
# failure so the caller can roll back.
health_ok() {
  local i
  for ((i = 1; i <= HEALTH_RETRIES; i++)); do
    if curl -fsS --max-time 5 "$WEB_URL" >/dev/null 2>&1 &&
       curl -fsS --max-time 5 "$VOICE_URL" >/dev/null 2>&1; then
      echo "  both services healthy after ${i} attempt(s)"
      return 0
    fi
    sleep "$HEALTH_SLEEP"
  done
  echo "  still unhealthy after $((HEALTH_RETRIES * HEALTH_SLEEP))s"
  echo "  web  : $(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$WEB_URL" || echo unreachable)"
  echo "  voice: $(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$VOICE_URL" || echo unreachable)"
  return 1
}

restart_services() {
  pm2 restart vaani-web vaani-voice --update-env
}

# ─── Rollback ───────────────────────────────────────────────────────────────
# Restores the previous build. Note what this does NOT undo: a schema change
# already applied by `prisma db push`. Our migrations are additive (new nullable
# columns), so an older build simply ignores the new columns and keeps working.
# A DESTRUCTIVE schema change would break that assumption — if you ever ship
# one, restore from the pre-deploy backup instead.
do_rollback() {
  cd "$APP_DIR"
  [[ -d .next.prev ]] || die "no .next.prev to roll back to"
  log "Rolling back to the previous build"
  rm -rf .next.failed
  [[ -d .next ]] && mv .next .next.failed
  mv .next.prev .next
  restart_services
  if health_ok; then
    log "Rollback complete and healthy. The bad build is in $APP_DIR/.next.failed"
  else
    die "ROLLED BACK AND STILL UNHEALTHY — this is not the new build's fault. Check: pm2 logs vaani-web --lines 100"
  fi
}

if [[ $ROLLBACK -eq 1 ]]; then
  do_rollback
  exit 0
fi

# ─── 0. Preflight ───────────────────────────────────────────────────────────
log "Preflight"
cd "$APP_DIR"

command -v pm2 >/dev/null || die "pm2 not found"
command -v npx >/dev/null || die "npx not found"
[[ -f .env ]] || die "no .env in $APP_DIR — restore it from Secret Manager first (DISASTER_RECOVERY §0)"

# next build inlines NEXT_PUBLIC_* at build time, and needs several MB of scratch.
AVAIL_MB=$(df -Pm . | awk 'NR==2 {print $4}')
echo "  disk available: ${AVAIL_MB} MB"
[[ "$AVAIL_MB" -lt 1500 ]] && warn "less than 1.5 GB free — the build may fail or invoke the OOM killer"

echo "  memory:"
free -m | sed 's/^/    /'

# ─── Source mode ────────────────────────────────────────────────────────────
# This VM has no git installed and $APP_DIR is not a clone — deploys have always
# been tar + scp (ROADMAP §6). So the tarball path is the real one here, and the
# git path is kept only for a box that does have a clone.
if [[ -n "$TARBALL" ]]; then
  SOURCE_MODE="tarball"
  [[ -f "$TARBALL" ]] || die "tarball not found: $TARBALL"
  log "Source: tarball $TARBALL ($(du -h "$TARBALL" | cut -f1))"
elif command -v git >/dev/null && [[ -d "$APP_DIR/.git" ]]; then
  SOURCE_MODE="git"
  log "Source: git"
  git fetch --all --prune
  [[ -n "$REF" ]] && git checkout "$REF"
  git pull --ff-only || warn "could not fast-forward — deploying the working tree as-is"
else
  die "no --tarball given, and this box has no git clone to build from. See --help."
fi

# ─── 1. Pre-deploy database backup ──────────────────────────────────────────
# Cheap insurance (the whole database is ~11 MB) and the only thing that makes a
# bad schema change survivable.
if [[ $SKIP_BACKUP -eq 0 && -f "$APP_DIR/scripts/backup-db.sh" ]]; then
  log "Pre-deploy database backup"
  bash "$APP_DIR/scripts/backup-db.sh" || die "backup failed — refusing to deploy. Use --skip-backup to override deliberately."
else
  warn "skipping pre-deploy backup"
fi

# ─── 2. Build, in a separate directory ──────────────────────────────────────
log "Preparing build directory: $BUILD_DIR"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Tracked source only; node_modules, .next and .env are handled separately.
if [[ "$SOURCE_MODE" == "tarball" ]]; then
  tar -xzf "$TARBALL" -C "$BUILD_DIR"
else
  git archive HEAD | tar -x -C "$BUILD_DIR"
fi

# next build inlines NEXT_PUBLIC_* at build time, so the build needs the real
# environment. The tarball never contains .env — it is gitignored, and shipping
# production secrets through a scp'd archive would be a bad habit to build.
cp "$APP_DIR/.env" "$BUILD_DIR/.env"

DEPLOY_SHA="$(cat "$BUILD_DIR/.deploy-sha" 2>/dev/null || echo unknown)"
DEPLOY_REF="$SOURCE_MODE"
echo "  deploying: $DEPLOY_SHA"

# Hardlink, NOT symlink — see note 3 at the top.
cp -al "$APP_DIR/node_modules" "$BUILD_DIR/node_modules"

cd "$BUILD_DIR"

log "Generating Prisma client (in the build dir only)"
# Safe here precisely because it is the BUILD copy: the running app keeps
# resolving its own client in $APP_DIR. This is why `npm run build` is banned.
npx prisma generate

log "Building (~80s on e2-medium; several minutes on e2-small) — heap cap ${HEAP_MB} MB"
NODE_OPTIONS="--max-old-space-size=${HEAP_MB}" npx next build

# ─── 3. Verify the artifact BEFORE touching production ──────────────────────
log "Verifying the build artifact"
[[ -f "$BUILD_DIR/.next/BUILD_ID" ]] || die "no .next/BUILD_ID — the build did not complete"
[[ -d "$BUILD_DIR/.next/server/app" ]] || die "no .next/server/app — the build is incomplete"
echo "  BUILD_ID: $(cat "$BUILD_DIR/.next/BUILD_ID")"
echo "  routes built: $(find "$BUILD_DIR/.next/server/app" -maxdepth 1 -name '*.html' | wc -l) static pages"

if [[ $DRY_RUN -eq 1 ]]; then
  log "--dry-run: build verified, production untouched. Artifact left in $BUILD_DIR"
  exit 0
fi

# ─── 4. Refresh the production source tree ──────────────────────────────────
# The web app serves from the built .next and never reads source at runtime, but
# the VOICE SERVER runs its TypeScript directly through tsx — so $APP_DIR source
# is what it will load on restart. Skipping this would restart the voice server
# on old code while the web app served new code (ROADMAP §6 step 5).
#
# Extracting over the tree leaves .env, node_modules and .next alone (the
# archive contains none of them). It does not remove files deleted since the
# last deploy; stale source is harmless here because nothing globs it, but a
# rename that leaves both copies is worth remembering if something looks odd.
if [[ "$SOURCE_MODE" == "tarball" ]]; then
  log "Refreshing $APP_DIR source"
  tar -xzf "$TARBALL" -C "$APP_DIR"
fi

# ─── 5. Schema ──────────────────────────────────────────────────────────────
# Run against production only after the build has proved itself. `prisma db push`
# is additive here; it will REFUSE anything destructive without
# --accept-data-loss, which this script deliberately never passes.
log "Applying schema changes"
cd "$APP_DIR"
npx prisma db push
npx prisma generate

# ─── 6. Swap and restart ────────────────────────────────────────────────────
log "Swapping in the new build"
rm -rf "$APP_DIR/.next.prev"
[[ -d "$APP_DIR/.next" ]] && mv "$APP_DIR/.next" "$APP_DIR/.next.prev"
mv "$BUILD_DIR/.next" "$APP_DIR/.next"

log "Restarting services"
restart_services

log "Health check"
if health_ok; then
  log "Deployed ${DEPLOY_REF} @ ${DEPLOY_SHA} successfully."
  echo "  previous build kept at $APP_DIR/.next.prev (roll back: bash scripts/deploy.sh --rollback)"
  rm -rf "$BUILD_DIR"
else
  warn "health check FAILED — rolling back automatically"
  do_rollback
  die "deploy of ${DEPLOY_SHA} failed its health check and was rolled back. Logs: pm2 logs vaani-web --lines 100"
fi

# ─── 7. Post-deploy notes ───────────────────────────────────────────────────
# Not failures, just things worth seeing immediately after a restart.
log "Post-deploy checks"
if pm2 logs vaani-web --nostream --lines 200 2>/dev/null | grep -q 'createSessionCookie failed'; then
  warn "Sessions are running on the 1-hour ID-token fallback."
  warn "Grant roles/iam.serviceAccountTokenCreator to this VM's service account for 14-day sessions."
else
  echo "  session cookies: no fallback warning seen"
fi
echo "  done."
