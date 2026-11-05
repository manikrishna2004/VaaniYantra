#!/usr/bin/env bash
# Monthly overage sweep for the VaaniYantra VM.
#
# POSTs to /api/admin/overage with the cron secret. The endpoint is idempotent
# (one OverageCharge per org per month), so running it more than once is safe —
# the crontab below fires on the 2nd AND 5th so a VM reboot or app downtime on
# one day doesn't skip the month.
#
# Install on the VM (run once):
#   1. Add to the app's .env (and restart vaani-web):
#        OVERAGE_CRON_SECRET="<openssl rand -hex 32>"
#   2. chmod +x scripts/overage-sweep.sh
#   3. crontab -e   # add:
#      25 3 2,5 * * /path/to/app/scripts/overage-sweep.sh >> $HOME/overage-sweep.log 2>&1
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_URL="${APP_URL:-https://vaaniyantra.com}"

# OVERAGE_CRON_SECRET: environment wins; otherwise read it from the app's .env
# (this script lives in <app>/scripts/, so ../.env is the app root).
if [[ -z "${OVERAGE_CRON_SECRET:-}" ]]; then
  APP_ENV_FILE="${APP_ENV_FILE:-$SCRIPT_DIR/../.env}"
  if [[ -f "$APP_ENV_FILE" ]]; then
    OVERAGE_CRON_SECRET="$(grep -E '^OVERAGE_CRON_SECRET=' "$APP_ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  fi
fi
if [[ -z "${OVERAGE_CRON_SECRET:-}" ]]; then
  echo "[overage-sweep] ERROR: OVERAGE_CRON_SECRET not set and not found in ${APP_ENV_FILE:-<unset>}" >&2
  exit 1
fi

echo "[overage-sweep] $(date -u +%FT%TZ) sweeping via $APP_URL"
RESPONSE="$(curl -fsS -X POST \
  -H "Authorization: Bearer $OVERAGE_CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{}' \
  --max-time 120 \
  "$APP_URL/api/admin/overage")"
echo "[overage-sweep] response: $RESPONSE"
