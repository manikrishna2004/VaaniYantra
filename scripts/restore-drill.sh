#!/usr/bin/env bash
#
# Restore drill — proves the nightly backup is actually restorable.
#
# A backup you have never restored is a hypothesis, not a backup. This restores
# the newest dump from GCS into a THROWAWAY database, compares its row counts
# against production table by table, and drops it. The live `vaani` database is
# never written to.
#
# It deliberately runs the SAME command docs/DISASTER_RECOVERY.md §3.4 tells you
# to run in an emergency (pg_restore --dbname="<url>"), so the drill cannot pass
# while the documented procedure is broken.
#
# Note the `--dbname=<url>` form rather than `sudo -u postgres pg_restore <file>`:
# the latter fails with "Permission denied" whenever the dump sits in a 0700
# directory (e.g. `mktemp -d`), which is a miserable thing to discover mid-outage.
#
# Invoke through bash, never as ./script -- tarball deploys reset file modes:
#   0 5 1 * * bash /home/balij/vaani/scripts/restore-drill.sh >> /home/balij/db-backups/drill.log 2>&1
set -uo pipefail

BUCKET="${GCS_BUCKET:-gs://vaaniyantra-db-backups}"
PROD_DB="${PROD_DB:-vaani}"
APP_ENV_FILE="${APP_ENV_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../.env}"
LOG_NAME="${LOG_NAME:-db-restore-drill}"
DRILL_DB="vaani_restore_drill_$$"
# Not mktemp -d: its 0700 mode is exactly the trap described above.
WORK="/tmp/restore-drill.$$"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

cleanup() {
  rm -rf "$WORK"
  # Drop the throwaway db even if we died halfway through the restore.
  sudo -u postgres psql -tAc "select 1 from pg_database where datname='$DRILL_DB';" 2>/dev/null \
    | grep -q 1 && sudo -u postgres dropdb "$DRILL_DB" 2>/dev/null
}
trap cleanup EXIT

alert() {
  echo "[restore-drill] $(stamp) ALERT: $1"
  gcloud logging write "$LOG_NAME" "RESTORE_DRILL_FAILED: $1" --severity=ERROR >/dev/null 2>&1 \
    || echo "[restore-drill] WARNING: could not write to Cloud Logging"
}

mkdir -p "$WORK" && chmod 755 "$WORK"

# --- 1. newest dump -----------------------------------------------------------
NEWEST="$(gcloud storage ls "$BUCKET/" 2>/dev/null | grep -E '\.dump$' | sort | tail -1)"
if [ -z "$NEWEST" ]; then
  alert "no dumps found in $BUCKET (empty, or unreadable from this host)"
  exit 1
fi
echo "[restore-drill] $(stamp) newest dump: $NEWEST"

# --- 2. download --------------------------------------------------------------
if ! gcloud storage cp "$NEWEST" "$WORK/drill.dump" >/dev/null 2>&1; then
  alert "could not download $NEWEST"
  exit 1
fi
chmod 644 "$WORK/drill.dump"
BYTES=$(stat -c%s "$WORK/drill.dump" 2>/dev/null || stat -f%z "$WORK/drill.dump")
echo "[restore-drill] downloaded $BYTES bytes"

# --- 3. throwaway database, owned by the app role -----------------------------
DB_URL="$(grep -E '^DATABASE_URL=' "$APP_ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
if [ -z "$DB_URL" ]; then
  alert "DATABASE_URL not found in $APP_ENV_FILE"
  exit 1
fi
PG_URL="${DB_URL%%\?*}"          # pg_* reject Prisma's ?schema=public
DRILL_URL="${PG_URL%/*}/$DRILL_DB"

if ! sudo -u postgres createdb -O vaani "$DRILL_DB"; then
  alert "could not create throwaway database $DRILL_DB"
  exit 1
fi

# --- 4. the actual restore (the runbook's command) ----------------------------
RESTORE_LOG="$WORK/restore.log"
if pg_restore --clean --if-exists --no-owner --dbname="$DRILL_URL" "$WORK/drill.dump" > "$RESTORE_LOG" 2>&1; then
  echo "[restore-drill] pg_restore exit 0"
else
  alert "pg_restore FAILED on $NEWEST -- $(head -3 "$RESTORE_LOG" | tr '\n' ' ')"
  exit 1
fi
[ -s "$RESTORE_LOG" ] && { echo "[restore-drill] restore stderr:"; head -15 "$RESTORE_LOG"; }

# --- 5. verify ----------------------------------------------------------------
DRILL_TABLES=$(sudo -u postgres psql -tAc "select count(*) from information_schema.tables where table_schema='public';" "$DRILL_DB")
PROD_TABLES=$(sudo -u postgres psql -tAc "select count(*) from information_schema.tables where table_schema='public';" "$PROD_DB")
echo "[restore-drill] tables restored: $DRILL_TABLES (prod: $PROD_TABLES)"

if [ "${DRILL_TABLES:-0}" -eq 0 ]; then
  alert "restore produced 0 tables from $NEWEST"
  exit 1
fi
if [ "$DRILL_TABLES" != "$PROD_TABLES" ]; then
  # Not fatal on its own -- a schema change since the dump looks like this too --
  # but it always deserves a human.
  alert "table count mismatch: restored $DRILL_TABLES vs prod $PROD_TABLES (schema drift since the dump?)"
fi

# Row counts. Differences are EXPECTED (the dump is hours old); this is a
# smoke test for a structurally intact restore, not a consistency proof.
echo "[restore-drill] row counts (restored vs prod):"
printf '  %-30s %9s %9s\n' TABLE RESTORED PROD
EMPTY_RESTORED=0
for t in $(sudo -u postgres psql -tAc "select table_name from information_schema.tables where table_schema='public' order by table_name;" "$DRILL_DB"); do
  d=$(sudo -u postgres psql -tAc "select count(*) from \"$t\";" "$DRILL_DB" 2>/dev/null || echo ERR)
  p=$(sudo -u postgres psql -tAc "select count(*) from \"$t\";" "$PROD_DB" 2>/dev/null || echo ERR)
  mark=""
  [ "$d" != "$p" ] && mark="  <- differs"
  [ "$d" = "0" ] && [ "$p" != "0" ] && { mark="  <- EMPTY, prod has rows"; EMPTY_RESTORED=$((EMPTY_RESTORED+1)); }
  printf '  %-30s %9s %9s%s\n' "$t" "$d" "$p" "$mark"
done

if [ "$EMPTY_RESTORED" -gt 0 ]; then
  alert "$EMPTY_RESTORED table(s) restored empty while prod has rows -- backup may be partial"
  exit 1
fi

echo "[restore-drill] $(stamp) OK: $NEWEST restored cleanly into $DRILL_TABLES tables"
