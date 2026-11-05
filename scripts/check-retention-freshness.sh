#!/usr/bin/env bash
#
# Alert when the data-retention sweep has not completed recently.
#
# Same lesson as check-backup-freshness.sh, applied to the other job that can die
# without anyone noticing. Retention ran only as an in-process interval inside the
# voice-server; if that process was down, org retention windows silently stopped
# being enforced. A retention job that fails quietly looks exactly like one that
# has nothing to purge.
#
# So this checks the OUTCOME -- the server-side marker stamped at the END of a
# completed sweep (PlatformConfig `retention.lastSweepAt`) -- not whether some
# process reported success. A sweeper that starts, throws halfway and exits 0
# never advances the marker.
#
# When stale it writes an ERROR to Cloud Logging under `retention-freshness`;
# a Monitoring alert policy turns that into an email.
#
# Invoke through bash, never as ./script -- tarball deploys reset file modes:
#   30 4 * * * bash /home/balij/vaani/scripts/check-retention-freshness.sh >> /home/balij/retention-freshness.log 2>&1

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_URL="${APP_URL:-https://vaaniyantra.com}"
# 48h, not 24h: the sweep runs daily, so 24h would flap on ordinary jitter.
# 48h means "we have definitively missed one".
MAX_AGE_HOURS="${MAX_AGE_HOURS:-48}"
LOG_NAME="${LOG_NAME:-retention-freshness}"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

alert() {
  local msg="$1"
  echo "[retention-freshness] $(stamp) ALERT: ${msg}"
  # Never let a logging failure mask the alert in the local log above.
  gcloud logging write "${LOG_NAME}" "RETENTION_STALE: ${msg}" --severity=ERROR >/dev/null 2>&1 \
    || echo "[retention-freshness] WARNING: could not write to Cloud Logging"
}

if [[ -z "${RETENTION_CRON_SECRET:-}" ]]; then
  APP_ENV_FILE="${APP_ENV_FILE:-$SCRIPT_DIR/../.env}"
  if [[ -f "$APP_ENV_FILE" ]]; then
    RETENTION_CRON_SECRET="$(grep -E '^RETENTION_CRON_SECRET=' "$APP_ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  fi
fi
if [[ -z "${RETENTION_CRON_SECRET:-}" ]]; then
  alert "RETENTION_CRON_SECRET not set and not found in ${APP_ENV_FILE:-<unset>} -- cannot check freshness"
  exit 1
fi

RESPONSE="$(curl -fsS -H "Authorization: Bearer $RETENTION_CRON_SECRET" \
  --max-time 60 "$APP_URL/api/admin/retention" 2>/dev/null)"

if [ -z "${RESPONSE}" ]; then
  # App down, secret wrong, or Caddy not routing. All are emergencies and all
  # look identical from here -- say so rather than guessing which.
  alert "no response from ${APP_URL}/api/admin/retention (app down, or secret rejected)"
  exit 1
fi

# {"lastSweepAt":"...","ageHours":12.3,...} -- null when the sweep has never run.
age_h="$(printf '%s' "${RESPONSE}" | grep -oE '"ageHours":[0-9]+(\.[0-9]+)?' | cut -d: -f2)"

if [ -z "${age_h}" ]; then
  alert "retention has never completed a sweep (no lastSweepAt marker). Response: ${RESPONSE}"
  exit 1
fi

# Integer-compare; the endpoint reports one decimal place.
age_int="${age_h%.*}"

if [ "${age_int}" -gt "${MAX_AGE_HOURS}" ]; then
  alert "last completed retention sweep was ${age_h}h ago, limit is ${MAX_AGE_HOURS}h"
  exit 1
fi

echo "[retention-freshness] $(stamp) OK: last sweep ${age_h}h ago (limit ${MAX_AGE_HOURS}h)"
