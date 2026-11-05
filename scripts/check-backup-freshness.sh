#!/usr/bin/env bash
#
# Alert when the newest database backup in GCS is too old.
#
# The nightly pg_dump cron went silently dead for two days in August 2026 -- a
# deploy stripped the execute bit off backup-db.sh, cron wrote "Permission
# denied" into a log file nobody reads, and nothing else noticed. A backup that
# fails quietly is barely better than no backup at all, and you only discover it
# on the day you need to restore.
#
# So this checks the OUTCOME (is there a recent dump in the bucket?) rather than
# whether some process reported success. It cannot be fooled by a backup script
# that runs, exits 0, and uploads nothing.
#
# When stale it writes an ERROR to Cloud Logging under the `db-backup-freshness`
# log name; a Monitoring alert policy turns that into an email. Cloud Logging
# rather than a local file precisely because the local-file approach is what
# failed last time.
#
# Invoke through bash, never as ./script -- tarball deploys reset file modes:
#   0 4 * * * bash /home/balij/vaani/scripts/check-backup-freshness.sh >> /home/balij/db-backups/freshness.log 2>&1

set -uo pipefail

BUCKET="${GCS_BUCKET:-gs://vaaniyantra-db-backups}"
# 36h, not 24h: the backup runs daily at 02:17, so a 24h threshold would flap on
# ordinary jitter. 36h means "we have definitively missed one".
MAX_AGE_HOURS="${MAX_AGE_HOURS:-36}"
LOG_NAME="${LOG_NAME:-db-backup-freshness}"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

alert() {
  local msg="$1"
  echo "[backup-freshness] $(stamp) ALERT: ${msg}"
  # Never let a logging failure mask the alert in the local log above.
  gcloud logging write "${LOG_NAME}" "BACKUP_STALE: ${msg}" --severity=ERROR >/dev/null 2>&1 \
    || echo "[backup-freshness] WARNING: could not write to Cloud Logging"
}

# Newest .dump in the bucket, by the timestamp gsutil reports.
newest_ts="$(gsutil ls -l "${BUCKET}/" 2>/dev/null | grep -E '\.dump$' | awk '{print $2}' | sort | tail -1)"

if [ -z "${newest_ts}" ]; then
  # No backups at all, or the bucket is unreadable. Both are emergencies, and
  # both look identical from here -- say so rather than guessing which.
  alert "no backups found in ${BUCKET} (bucket empty, or unreadable from this host)"
  exit 1
fi

newest_epoch="$(date -d "${newest_ts}" +%s 2>/dev/null)"
if [ -z "${newest_epoch}" ]; then
  alert "could not parse the newest backup timestamp '${newest_ts}' from ${BUCKET}"
  exit 1
fi

age_h=$(( ( $(date +%s) - newest_epoch ) / 3600 ))

if [ "${age_h}" -gt "${MAX_AGE_HOURS}" ]; then
  alert "newest backup in ${BUCKET} is ${age_h}h old, limit is ${MAX_AGE_HOURS}h (newest: ${newest_ts})"
  exit 1
fi

echo "[backup-freshness] $(stamp) OK: newest backup is ${age_h}h old (limit ${MAX_AGE_HOURS}h)"
