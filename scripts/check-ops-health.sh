#!/usr/bin/env bash
#
# Alert when the product is broken in a way that reports itself to nobody.
#
# Written after the 2026-08-27 outage: the model provider's credits ran out,
# every call failed for hours, and the first report came from a customer. The
# database had it exactly right the whole time — every one of those calls was
# `FAILED / no_conversation` — but nothing read that column.
#
# Same shape as check-retention-freshness.sh and check-backup-freshness.sh:
# check the OUTCOME via a server-side endpoint, not whether a process is up.
# A voice-server that answers HTTP while every call dies in silence is exactly
# the case a process check calls healthy.
#
# Four things, any one of which is an emergency:
#   - a high share of recent calls ended before anyone spoke
#   - the reminder dispatcher has not completed a pass recently
#   - the stale-call sweeper has not completed a pass recently
#   - webhook endpoints are failing repeatedly and nobody has looked
#
# Runs every 15 minutes. Writes ERROR to Cloud Logging under `ops-health`;
# a Monitoring alert policy turns that into an email.
#
# Invoke through bash, never as ./script -- tarball deploys reset file modes:
#   */15 * * * * bash /home/balij/vaani/scripts/check-ops-health.sh >> /home/balij/ops-health.log 2>&1

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_URL="${APP_URL:-https://vaaniyantra.com}"
# Percent of calls in the last hour that ended before anyone spoke. Some are
# normal (wrong numbers, instant hangups), so this is set well clear of the
# background rate -- it is meant to catch "the agent cannot speak at all".
MAX_NO_CONVERSATION_PCT="${MAX_NO_CONVERSATION_PCT:-60}"
# Both jobs tick far more often than this (5min and 1min); 2h means we have
# definitively missed many, not that one was slow.
MAX_JOB_AGE_HOURS="${MAX_JOB_AGE_HOURS:-2}"
LOG_NAME="${LOG_NAME:-ops-health}"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

FAILED=0
alert() {
  local msg="$1"
  FAILED=1
  echo "[ops-health] $(stamp) ALERT: ${msg}"
  gcloud logging write "${LOG_NAME}" "OPS_UNHEALTHY: ${msg}" --severity=ERROR >/dev/null 2>&1 \
    || echo "[ops-health] WARNING: could not write to Cloud Logging"
}

if [[ -z "${OPS_CRON_SECRET:-}" ]]; then
  APP_ENV_FILE="${APP_ENV_FILE:-$SCRIPT_DIR/../.env}"
  if [[ -f "$APP_ENV_FILE" ]]; then
    OPS_CRON_SECRET="$(grep -E '^OPS_CRON_SECRET=' "$APP_ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  fi
fi
if [[ -z "${OPS_CRON_SECRET:-}" ]]; then
  alert "OPS_CRON_SECRET not set and not found in ${APP_ENV_FILE:-<unset>} -- cannot check"
  exit 1
fi

RESPONSE="$(curl -fsS -H "Authorization: Bearer $OPS_CRON_SECRET" \
  --max-time 30 "$APP_URL/api/admin/ops-health" 2>/dev/null)"

if [ -z "${RESPONSE}" ]; then
  alert "no response from ${APP_URL}/api/admin/ops-health (app down, or secret rejected)"
  exit 1
fi

# Pull a numeric JSON field. Returns empty for null or absent.
field() { printf '%s' "${RESPONSE}" | grep -oE "\"$1\":[0-9]+(\.[0-9]+)?" | head -1 | cut -d: -f2; }

# ── 1. Calls failing before anyone speaks ────────────────────────────────────
# Absent when too few calls to rate -- a quiet hour is not an outage.
pct="$(field noConversationPct)"
if [ -n "${pct}" ]; then
  if [ "${pct%.*}" -ge "${MAX_NO_CONVERSATION_PCT}" ]; then
    total="$(field total)"
    alert "${pct}% of the last hour's ${total} calls ended with no conversation (limit ${MAX_NO_CONVERSATION_PCT}%) -- the agent is probably not speaking. Check the model provider's credits and key first."
  fi
fi

# ── 2 & 3. Background job liveness ───────────────────────────────────────────
# The endpoint emits these in a fixed order, so take them positionally.
ages="$(printf '%s' "${RESPONSE}" | grep -oE '"ageHours":(null|[0-9]+(\.[0-9]+)?)' | cut -d: -f2)"
reminder_age="$(printf '%s\n' "${ages}" | sed -n '1p')"
stale_age="$(printf '%s\n' "${ages}" | sed -n '2p')"

check_job() {
  local name="$1" age="$2"
  if [ "${age}" = "null" ] || [ -z "${age}" ]; then
    alert "${name} has never completed a pass (no marker) -- it may not be running at all"
  elif [ "${age%.*}" -gt "${MAX_JOB_AGE_HOURS}" ]; then
    alert "${name} last completed a pass ${age}h ago, limit is ${MAX_JOB_AGE_HOURS}h"
  fi
}
check_job "the reminder dispatcher" "${reminder_age}"
check_job "the stale-call sweeper" "${stale_age}"

# ── 4. Abandoned webhook endpoints ───────────────────────────────────────────
failing="$(field failing)"
if [ -n "${failing}" ] && [ "${failing}" -gt 0 ]; then
  alert "${failing} enabled webhook endpoint(s) are past the failure limit -- a customer's integration has been broken long enough to notice"
fi

# ── 5. The usage ledger, while it runs in shadow ─────────────────────────────
# Every billable minute is currently written twice: as Call.durationSec, which
# billing reads, and as a UsageEvent, which nothing reads yet. The second write
# is what will bill reseller and client-cloud minutes, and the only proof it is
# complete is that the two agree. A dual write that quietly stops working looks
# like nothing at all until an org is flipped onto the ledger and is billed from
# a table that is missing calls -- which is the same shape as the incident this
# whole script was written after.
drifting="$(field driftingOrgs)"
if [ -n "${drifting}" ] && [ "${drifting}" -gt 0 ]; then
  worst="$(field worstDeltaAbsMinutes)"
  alert "the usage ledger disagrees with the calls table for ${drifting} org(s) this month (worst ${worst:-?} min) -- do NOT move any org onto the ledger until this is zero"
fi

# ── 6. The reseller pull ─────────────────────────────────────────────────────
# For any org served by OmniDimension this pull IS the billing record -- our own
# calls table never saw those minutes. A poller that stops looks like nothing
# until the monthly sweep refuses to close the month.
stale_polls="$(field stalePolls)"
if [ -n "${stale_polls}" ] && [ "${stale_polls}" -gt 0 ]; then
  alert "${stale_polls} reseller account(s) have not been polled in over 2h -- billable minutes are not being collected"
fi

failing_accounts="$(field failingAccounts)"
if [ -n "${failing_accounts}" ] && [ "${failing_accounts}" -gt 0 ]; then
  alert "${failing_accounts} reseller account(s) are failing to reconcile -- the monthly sweep will refuse to close their month"
fi

# Revenue leakage: an active account whose volume has fallen off a cliff against
# its own trailing median is what it looks like when a client repoints their
# agents at their OWN reseller account. Nothing technical prevents that.
collapsed="$(field volumeCollapseAccounts)"
if [ -n "${collapsed}" ] && [ "${collapsed}" -gt 0 ]; then
  alert "${collapsed} reseller account(s) show a sudden volume collapse -- check whether the client has moved their agents elsewhere"
fi

if [ "${FAILED}" -eq 0 ]; then
  echo "[ops-health] $(stamp) OK: ${RESPONSE}"
fi
exit "${FAILED}"
