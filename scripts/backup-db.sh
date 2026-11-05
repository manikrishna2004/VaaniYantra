#!/usr/bin/env bash
# Nightly Postgres backup for the VaaniYantra VM.
#
# Dumps the app database (pg_dump custom format — compressed, restorable with
# pg_restore), keeps a local rotation, and optionally uploads to a GCS bucket.
#
# Install on the VM (run once):
#   chmod +x scripts/backup-db.sh
#   crontab -e   # add:
#   17 2 * * * /path/to/app/scripts/backup-db.sh >> $HOME/db-backups/backup.log 2>&1
#
# Off-VM copies (strongly recommended — the VM disk is the only copy otherwise):
#   gsutil mb -l us-east1 gs://vaaniyantra-db-backups        # once
#   gsutil lifecycle set scripts/gcs-backup-lifecycle.json gs://vaaniyantra-db-backups
#   export GCS_BUCKET=gs://vaaniyantra-db-backups            # or set below/in cron
#
# Restore (example):
#   pg_restore --clean --if-exists --dbname="$DATABASE_URL" vaani-YYYYMMDD-HHMMSS.dump
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$HOME/db-backups}"
GCS_BUCKET="${GCS_BUCKET:-}"          # e.g. gs://vaaniyantra-db-backups (empty = local only)
KEEP_LOCAL_DAYS="${KEEP_LOCAL_DAYS:-14}"

# DATABASE_URL: environment wins; otherwise read it from the app's .env
# (this script lives in <app>/scripts/, so ../.env is the app root).
if [[ -z "${DATABASE_URL:-}" ]]; then
  APP_ENV_FILE="${APP_ENV_FILE:-$SCRIPT_DIR/../.env}"
  if [[ -f "$APP_ENV_FILE" ]]; then
    DATABASE_URL="$(grep -E '^DATABASE_URL=' "$APP_ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  fi
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[backup-db] ERROR: DATABASE_URL not set and not found in $APP_ENV_FILE" >&2
  exit 1
fi

# pg_dump rejects Prisma-only URI params (e.g. ?schema=public) — strip the query string.
PG_URL="${DATABASE_URL%%\?*}"

STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$BACKUP_DIR/vaani-$STAMP.dump"
mkdir -p "$BACKUP_DIR"

echo "[backup-db] $(date -Is) dumping to $FILE"
pg_dump --format=custom --no-owner --dbname="$PG_URL" --file="$FILE"

# A dump of an empty/unreachable DB would be tiny — treat that as failure so
# cron mail / the log shows it instead of silently rotating good backups away.
BYTES=$(stat -c%s "$FILE" 2>/dev/null || stat -f%z "$FILE")
if [[ "$BYTES" -lt 10240 ]]; then
  echo "[backup-db] ERROR: dump is suspiciously small ($BYTES bytes) — keeping it for inspection, marking run failed" >&2
  exit 1
fi
echo "[backup-db] dump OK ($BYTES bytes)"

if [[ -n "$GCS_BUCKET" ]]; then
  echo "[backup-db] uploading to $GCS_BUCKET"
  gsutil -q cp "$FILE" "$GCS_BUCKET/"
  echo "[backup-db] upload OK"
else
  echo "[backup-db] GCS_BUCKET not set — local copy only (set it for off-VM safety)"
fi

# Rotate local copies (GCS retention is handled by the bucket lifecycle rule).
find "$BACKUP_DIR" -name 'vaani-*.dump' -mtime +"$KEEP_LOCAL_DAYS" -delete
echo "[backup-db] done; local copies older than $KEEP_LOCAL_DAYS days pruned"
