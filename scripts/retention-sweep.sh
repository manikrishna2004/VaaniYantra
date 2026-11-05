#!/usr/bin/env bash
# Daily data-retention sweep for the VaaniYantra VM.
#
# POSTs to /api/admin/retention with the cron secret. The endpoint calls the same
# tickRetention() the voice-server runs in-process, and that function guards
# re-entry with its own flag, so running both is safe and running this twice is
# safe.
#
# Why it exists: retention used to be ONLY a 6h setInterval inside the
# voice-server. If that process was down, every org's retention window silently
# stopped being enforced and nothing said so. This makes the sweep independent of
# any one long-lived process.
#
# Install on the VM (run once):
#   1. Add to the app's .env (and restart vaani-web):
#        RETENTION_CRON_SECRET="<openssl rand -hex 32>"
#   2. crontab -e   # add (invoke through bash -- tarball deploys reset file modes):
#      40 3 * * * bash /path/to/app/scripts/retention-sweep.sh >> $HOME/retention-sweep.log 2>&1
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_URL="${APP_URL:-https://vaaniyantra.com}"

# RETENTION_CRON_SECRET: environment wins; otherwise read it from the app's .env
# (this script lives in <app>/scripts/, so ../.env is the app root).
if [[ -z "${RETENTION_CRON_SECRET:-}" ]]; then
  APP_ENV_FILE="${APP_ENV_FILE:-$SCRIPT_DIR/../.env}"
  if [[ -f "$APP_ENV_FILE" ]]; then
    RETENTION_CRON_SECRET="$(grep -E '^RETENTION_CRON_SECRET=' "$APP_ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  fi
fi
if [[ -z "${RETENTION_CRON_SECRET:-}" ]]; then
  echo "[retention-sweep] ERROR: RETENTION_CRON_SECRET not set and not found in ${APP_ENV_FILE:-<unset>}" >&2
  exit 1
fi

echo "[retention-sweep] $(date -u +%FT%TZ) sweeping via $APP_URL"
RESPONSE="$(curl -fsS -X POST \
  -H "Authorization: Bearer $RETENTION_CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{}' \
  --max-time 300 \
  "$APP_URL/api/admin/retention")"
echo "[retention-sweep] response: $RESPONSE"
