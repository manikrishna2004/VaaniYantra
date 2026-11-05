#!/usr/bin/env bash
# Pull billable minutes back from the reseller voice platform (OmniDimension)
# into the usage ledger.
#
# This is the billing source of truth for any org served by the reseller. It is
# a PULL on purpose: a deployment running in a client's own cloud can be turned
# off, firewalled or patched, and none of that changes what the provider says we
# owe or what the client owes us.
#
# Idempotent — the ledger is keyed on (source, externalId, seq), so a replayed
# run converges on the same rows.
#
# ── Two modes, and you need BOTH ────────────────────────────────────────────
#
#   incremental (default)  pages newest-first and stops at the cursor. Cheap.
#   --full-month=YYYY-MM   re-reads the whole listing for that month.
#
# The full re-pull is not an optimisation you can skip. Their /calls/logs takes
# no date filter and a call record carries no updated-at field, so a duration
# revised after we first read it is INVISIBLE to the incremental path. The only
# way to find one is to read the call again — and it has to happen before the
# overage sweep closes the month, because OverageCharge is unique per
# (org, month) and a shortfall there is permanent.
#
# Install on the VM (run once):
#   1. Add to the app's .env (and restart vaani-web):
#        RECONCILE_CRON_SECRET="<openssl rand -hex 32>"
#   2. chmod +x scripts/omni-reconcile.sh
#   3. crontab -e   # add BOTH lines:
#      */15 * * * *   bash /path/to/app/scripts/omni-reconcile.sh >> $HOME/omni-reconcile.log 2>&1
#      10 2 1,2 * *   bash /path/to/app/scripts/omni-reconcile.sh --full-last-month >> $HOME/omni-reconcile.log 2>&1
#
#   The full pull runs on the 1st AND 2nd, and the overage sweep runs on the
#   2nd and 5th — so the month is always fully read before it is closed, and a
#   reboot on any single day does not skip either.
#
#   Invoke with `bash`, not `./`: a tarball deploy strips the execute bit, which
#   is how the nightly backup silently died for two days.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_URL="${APP_URL:-https://vaaniyantra.com}"

BODY='{}'
for arg in "$@"; do
  case "$arg" in
    --full-last-month)
      MONTH="$(date -u -d 'last month' +%Y-%m 2>/dev/null || date -u -v-1m +%Y-%m)"
      BODY="{\"fullMonth\":\"${MONTH}\"}"
      ;;
    --full-month=*)
      BODY="{\"fullMonth\":\"${arg#--full-month=}\"}"
      ;;
    *)
      echo "[omni-reconcile] unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

# RECONCILE_CRON_SECRET: environment wins; otherwise read it from the app's .env
# (this script lives in <app>/scripts/, so ../.env is the app root).
if [[ -z "${RECONCILE_CRON_SECRET:-}" ]]; then
  APP_ENV_FILE="${APP_ENV_FILE:-$SCRIPT_DIR/../.env}"
  if [[ -f "$APP_ENV_FILE" ]]; then
    RECONCILE_CRON_SECRET="$(grep -E '^RECONCILE_CRON_SECRET=' "$APP_ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  fi
fi
if [[ -z "${RECONCILE_CRON_SECRET:-}" ]]; then
  echo "[omni-reconcile] ERROR: RECONCILE_CRON_SECRET not set and not found in ${APP_ENV_FILE:-<unset>}" >&2
  exit 1
fi

echo "[omni-reconcile] $(date -u +%FT%TZ) pulling via $APP_URL body=$BODY"
RESPONSE="$(curl -fsS -X POST \
  -H "Authorization: Bearer $RECONCILE_CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  --max-time 300 \
  "$APP_URL/api/admin/usage/reconcile")"
echo "[omni-reconcile] response: $RESPONSE"

# A failed account leaves its cursor where it was, so the next run re-reads —
# but a run that keeps failing means the month cannot be closed (the sweep
# blocks on it), so exit non-zero and let cron mail it.
FAILED="$(printf '%s' "$RESPONSE" | grep -oE '"failedAccounts":[0-9]+' | cut -d: -f2)"
if [[ -n "${FAILED:-}" && "$FAILED" -gt 0 ]]; then
  echo "[omni-reconcile] ERROR: $FAILED account(s) failed to reconcile -- the monthly sweep will refuse to close their month until this clears" >&2
  exit 1
fi
