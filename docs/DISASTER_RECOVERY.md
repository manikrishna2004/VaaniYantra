# Disaster Recovery

**Scope:** VaaniYantra production — GCP project `callsera`, single VM `vaani-vm`.
**Restore path last verified:** 2026-08-09 (drill output in §5).
**Read §0 first.** It is the one thing that turns a 30-minute recovery into a
multi-day one, and no amount of database backup protects you from it.

---

## 0. Read this first — why the database backup alone is not enough

The nightly `pg_dump` protects the **database**. It does not protect the thing
the database is useless without: **`SECRET_ENC_KEY`**, held in
`/home/balij/vaani/.env`.

`src/lib/crypto.ts` derives an AES-256-GCM key from it to encrypt secrets at
rest. Encrypted columns are written by `connectors.ts`,
`telephony-accounts.ts`, `integrations.ts`, `platform.ts`, `calendar.ts`, and
the Twilio/Plivo signature modules — i.e. **every tenant's telephony
credentials, integration secrets and calendar OAuth tokens.**

> **Lose `SECRET_ENC_KEY` and a perfect database restore still leaves you with
> undecryptable ciphertext in every secret column.** There is no recovery path.
> Every organisation has to re-enter every credential by hand, and the app will
> refuse to boot at all until *some* key is set (`crypto.ts:14` throws in
> production by design).

**As of 2026-08-09 this is protected** — `.env` was previously on the VM disk
only. It is now also in Secret Manager as **`vaani-env`** (verified byte-for-byte,
5455 bytes), and the VM's service account holds `roles/secretmanager.secretAccessor`
so recovery works from the box itself:

```bash
# Retrieve during recovery. Use --out-file, never a pipe: gcloud on Windows
# rewrites line endings on stdout and you get a corrupt .env that looks fine.
gcloud secrets versions access latest --secret=vaani-env --project=callsera \
  --out-file=/home/balij/vaani/.env
chmod 600 /home/balij/vaani/.env
```

**After any credential rotation, add a new version** — otherwise this copy
silently goes stale, which is the same failure in slow motion:

```bash
gcloud secrets versions add vaani-env --project=callsera \
  --data-file=/home/balij/vaani/.env
```

One residual risk: the secret lives in the *same GCP project* as the VM. That
covers disk loss and VM loss, which are the realistic scenarios — it does not
cover losing the project itself (deletion, or billing disabled long enough for
resources to be reaped). A copy in a password manager outside GCP closes that
last gap and takes two minutes.

---

## 1. Verified inventory

Everything below was confirmed live on 2026-08-09, not copied from older docs.

| Item | Value |
|---|---|
| GCP project | `callsera` (number `759068589507`) |
| VM | `vaani-vm` · `e2-micro` · `us-east1-b` · Debian 12 (bookworm) · 30 GB `pd-standard` |
| Static IP | `vaani-ip` = `34.138.86.231` (reserved, `IN_USE` — survives VM deletion) |
| Canonical host | `vaaniyantra.com` (+ `34.138.86.231.sslip.io`; `www` 301s to apex) |
| App path | `/home/balij/vaani` (owner `balij`) |
| Processes | pm2 `vaani-web` → `npm run start` (:3000), `vaani-voice` → `npm run voice-server` (:8080) |
| pm2 boot persistence | `pm2-balij` systemd unit **enabled**; `~/.pm2/dump.pm2` present |
| Reverse proxy | Caddy v2.11.4 (`/etc/caddy/Caddyfile`, backup at `Caddyfile.bak`) |
| Runtime | Node v20.20.2, npm 10.8.2 (nodesource apt repo) |
| Database | PostgreSQL 15.18, db `vaani`, login roles `vaani` + `postgres`, port 5432, **~11 MB** |
| Backups (database) | `gs://vaaniyantra-db-backups`, nightly 02:17, 60-day lifecycle |
| Backups (disk) | snapshot schedule `vaani-daily` — 03:00 daily, 14-day retention, attached to disk `vaani-vm`; baseline `vaani-vm-manual-20260809` |
| Secrets | `.env` mirrored to Secret Manager `vaani-env`; file mode `600` |
| VM service account | `759068589507-compute@developer.gserviceaccount.com`, scope `cloud-platform` (this is what lets the VM write to GCS and Cloud Logging) |
| Firewall | `allow-web` tcp:80,443 · `default-allow-ssh` tcp:22 |
| Crons | 02:17 backup · 03:25 on 2nd/5th overage sweep · 04:00 backup-freshness check · 05:00 on the 1st restore drill |

**Caddy route split** — `/api/telephony/twilio/*`, `/api/telephony/plivo/*`,
`/twilio`, `/exotel`, `/plivo`, `/health` → :8080. Everything else → :3000.
These paths **must stay public**; Twilio cannot send credentials.

---

## 2. What you can actually promise

| | Value | Why |
|---|---|---|
| **RPO** (data you can lose) | **up to ~24 h** | Backups are nightly at 02:17. A 01:00 failure loses ~23 h of calls, appointments and transcripts. There is no WAL archiving or PITR. |
| **RTO — app/process failure** | ~2 min | pm2 restart (§3.1) |
| **RTO — VM stopped** | ~5 min | `instances start` (§3.2) |
| **RTO — database restore** | ~10 min | verified drill took well under a minute at 11 MB (§5) |
| **RTO — total VM loss, from snapshot** | **~20 min** | Create a disk from the newest `vaani-daily` snapshot (§6.1). Loses ≤24 h of OS-level change. Untested. |
| **RTO — total VM loss, full rebuild** | **4–8 h** | Only needed if snapshots are also gone. §6.2. Untested. |

Both VM-loss rows are estimates, not measurements — §8's quarterly drill is what
would turn them into real numbers.

---

## 3. Scenario playbooks

### 3.1 Site down, VM reachable

```bash
gcloud compute ssh vaani-vm --project callsera --zone us-east1-b

pm2 list                      # who is stopped/errored?
pm2 logs vaani-web --lines 80 --nostream
pm2 logs vaani-voice --lines 80 --nostream
pm2 restart vaani-web         # or vaani-voice, or `pm2 restart all`
```

Then verify (§4). If pm2 is healthy but the site is not, suspect Caddy:

```bash
systemctl status caddy
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

If `/api/health` returns 503, the app is up but Postgres is not — go to §3.4.

### 3.2 VM stopped or unresponsive

```bash
gcloud compute instances describe vaani-vm --project callsera --zone us-east1-b \
  --format="value(status)"

# TERMINATED/SUSPENDED:
gcloud compute instances start vaani-vm --project callsera --zone us-east1-b

# RUNNING but not answering — inspect boot output before rebooting blindly:
gcloud compute instances get-serial-port-output vaani-vm \
  --project callsera --zone us-east1-b | tail -50
gcloud compute instances reset vaani-vm --project callsera --zone us-east1-b
```

pm2 is `enabled` at boot, so both services should come back on their own.
Confirm with §4 rather than assuming.

**If the cause is disabled billing**, nothing above works until billing is
re-enabled on the project — Compute suspends instances and the API refuses
requests. Re-enable at
`https://console.cloud.google.com/billing/enable?project=callsera`, wait a few
minutes for propagation, then `instances start`.

### 3.3 Rolling back a bad deploy

Deploys are manual (tar → scp → build → `pm2 restart`), so there is no deploy
history to roll back to. Recover by rebuilding from the last-good git commit:

```bash
git checkout <last-good-sha>
npm run build
# then the normal deploy flow from DEVELOPER_GUIDE.md §9
```

If the bad deploy also ran `prisma db push` and dropped or altered columns,
treat it as data loss → §3.4.

### 3.4 Database corrupted, or bad data written

This is the verified path (§5). It **overwrites the live database** — take a
safety dump first, always.

```bash
gcloud compute ssh vaani-vm --project callsera --zone us-east1-b

# 0. Stop writes so the restore is not racing the app.
pm2 stop vaani-web vaani-voice

# 1. Safety dump of the CURRENT state (even if you think it is garbage).
GCS_BUCKET= bash /home/balij/vaani/scripts/backup-db.sh || \
  pg_dump --format=custom --no-owner \
    --dbname="$(grep -E '^DATABASE_URL=' /home/balij/vaani/.env | cut -d= -f2- | tr -d '"'"'"'"' | sed 's/?.*//')" \
    --file="$HOME/db-backups/pre-restore-$(date +%Y%m%d-%H%M%S).dump"

# 2. Pick the dump to restore.
gcloud storage ls gs://vaaniyantra-db-backups/ | tail -5
gcloud storage cp gs://vaaniyantra-db-backups/vaani-YYYYMMDD-HHMMSS.dump /tmp/restore.dump

# 3. Restore. --clean --if-exists drops existing objects first.
DB_URL="$(grep -E '^DATABASE_URL=' /home/balij/vaani/.env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
pg_restore --clean --if-exists --no-owner --dbname="${DB_URL%%\?*}" /tmp/restore.dump

# 4. Bring it back.
pm2 start vaani-web vaani-voice
rm -f /tmp/restore.dump
```

Then verify with §4.

**To inspect a backup without touching prod** — restore into a throwaway
database instead (this is exactly what the drill does):

```bash
sudo -u postgres createdb -O vaani vaani_inspect
pg_restore --no-owner --dbname="${DB_URL%/*}/vaani_inspect" /tmp/restore.dump
sudo -u postgres psql vaani_inspect -c '\dt'
sudo -u postgres dropdb vaani_inspect        # when done
```

### 3.5 Backups have gone stale

`check-backup-freshness.sh` alerts to Cloud Logging (`db-backup-freshness`,
severity ERROR) when the newest dump is >36 h old. It exists because the cron
silently died for two days in August 2026 when a deploy stripped the execute bit.

```bash
tail -30 ~/db-backups/backup.log        # what did the nightly run say?
tail -30 ~/db-backups/freshness.log
crontab -l                              # all three entries still present?
bash /home/balij/vaani/scripts/backup-db.sh   # run manually; note: `bash`, never ./
gcloud storage ls -l gs://vaaniyantra-db-backups/ | tail -3
```

Crons invoke these through `bash` precisely so tarball deploys resetting file
modes cannot break them again. Keep it that way.

---

## 4. Verification checklist — run after every recovery

```bash
# App + database
curl -s https://vaaniyantra.com/api/health          # {"ok":true,"db":"up","uptimeSec":N}
# Voice server (Caddy → :8080)
curl -s https://vaaniyantra.com/health              # ok
# Canonical redirect
curl -sI https://www.vaaniyantra.com | head -1      # 301
# Processes
gcloud compute ssh vaani-vm --project callsera --zone us-east1-b --command="pm2 list"
```

Then, because health checks do not prove the encryption key survived:

- Open an org's telephony or integration settings in the dashboard and confirm a
  **saved secret still decrypts**. If it errors, `SECRET_ENC_KEY` does not match
  the data — stop and restore the correct `.env` before anyone re-enters
  credentials.
- Place a test call to **+1 662 439 4745** and confirm audio both ways.

---

## 5. Restore drill — verified 2026-08-09

The newest GCS dump was restored into a throwaway database on the VM using the
exact §3.4 command, then row-counted against production and dropped. The live
`vaani` database was never touched.

```
=== 1. newest dump: gs://vaaniyantra-db-backups/vaani-20260809-021702.dump
=== 2. download: 147679 bytes
=== 5. pg_restore --clean --if-exists --dbname=<url>: exit 0 (clean)
    --- restore stderr: empty ---
=== 6. restored: 38 tables | prod: 38 tables
=== 7. row counts, restored vs prod: 38/38 tables identical
        Agent 6 | Appointment 9 | AuditLog 71 | Call 38 | Organization 10
        TranscriptTurn 267 | User 10 | Workspace 11 | ...
    tables differing from prod: 0
=== 8. dropped throwaway db
```

**Conclusion: the database backup is genuinely restorable.** `pg_restore` exits
0 with empty stderr and reproduces the schema and every row.

Two things the drill also proved, both worth knowing:

1. `sudo -u postgres pg_restore <file>` fails with **`Permission denied`** if the
   dump sits in a `700` directory such as `mktemp -d` output. Restore via
   `--dbname="$DATABASE_URL"` (as §3.4 does) and the problem disappears.
2. `gcloud secrets versions access ... | sha256sum` reports a **false mismatch**
   on Windows — gcloud rewrites line endings on stdout. Always use `--out-file`.

---

## 6. Total VM loss

Try §6.1 first. Fall back to §6.2 only if the snapshots are gone too.
Both are **untested** — follow them, then correct this document from what you
actually hit.

### 6.1 Restore from snapshot (preferred, ~20 min)

Daily snapshots of the whole boot disk have existed since 2026-08-09, so the OS,
Caddy config, crontab, pm2 state and `.env` all come back together.

```bash
# 1. Newest snapshot
gcloud compute snapshots list --project=callsera --filter="sourceDisk~vaani-vm" \
  --sort-by=~creationTimestamp --limit=5

# 2. Disk from that snapshot
gcloud compute disks create vaani-vm-restored --project=callsera --zone=us-east1-b \
  --source-snapshot=<SNAPSHOT_NAME> --type=pd-standard --size=30GB

# 3. New VM on that disk, re-attaching the reserved IP so DNS and every
#    Twilio/Exotel/Plivo webhook URL keep working.
gcloud compute instances create vaani-vm-new --project=callsera --zone=us-east1-b \
  --machine-type=e2-micro --disk=name=vaani-vm-restored,boot=yes,auto-delete=no \
  --address=34.138.86.231 --scopes=cloud-platform
```

The disk is at most 24 h stale, so **replay the gap from the database backup**:
run §3.4 with the newest dump. Then verify with §4 — including the decrypt check,
which is what proves `.env` came back intact.

### 6.2 Full rebuild from scratch (~4–8 h)

Only if no usable snapshot exists.
**Prerequisite: `.env` from Secret Manager (§0).** Without it, stop and read §0.

```bash
# 1. New VM, same name/zone/type. The reserved IP `vaani-ip` outlives the old VM,
#    so re-attaching it keeps DNS and all Twilio/Exotel/Plivo webhook URLs valid.
gcloud compute instances create vaani-vm \
  --project=callsera --zone=us-east1-b --machine-type=e2-micro \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-standard \
  --address=34.138.86.231 --scopes=cloud-platform

# 2. Firewall (only if the rules are gone too)
gcloud compute firewall-rules create allow-web --project=callsera \
  --allow=tcp:80,tcp:443 --direction=INGRESS

# 3. On the VM: runtime + services
sudo apt update && sudo apt install -y postgresql-15 git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
# Caddy: follow caddyserver.com/docs/install#debian-ubuntu-raspbian
sudo npm install -g pm2

# 4. Database + role (password must match the DATABASE_URL in your saved .env)
sudo -u postgres createuser --login --pwprompt vaani
sudo -u postgres createdb -O vaani vaani

# 5. App
git clone <repo> /home/balij/vaani && cd /home/balij/vaani
#    >>> restore .env from Secret Manager BEFORE building (§0): <<<
gcloud secrets versions access latest --secret=vaani-env --project=callsera \
  --out-file=/home/balij/vaani/.env && chmod 600 /home/balij/vaani/.env
npm ci && npx prisma generate && npx prisma db push && npm run build

# 6. Data
gcloud storage cp gs://vaaniyantra-db-backups/vaani-YYYYMMDD-HHMMSS.dump /tmp/restore.dump
pg_restore --clean --if-exists --no-owner --dbname="<DATABASE_URL minus query string>" /tmp/restore.dump

# 7. Caddy — recreate /etc/caddy/Caddyfile per §1's route split
sudo systemctl enable --now caddy

# 8. pm2
pm2 start npm --name vaani-web   -- run start
pm2 start npm --name vaani-voice -- run voice-server
pm2 save && pm2 startup    # run the command it prints

# 9. Crons — re-add all three from §1 (invoke via `bash`, absolute paths)
crontab -e
```

Finish with the full §4 checklist, including the decrypt check and a test call.

---

## 7. Gap register

### Closed on 2026-08-09

| Gap | What was done |
|---|---|
| `.env` / `SECRET_ENC_KEY` existed **only** on the VM disk — a disk loss made every encrypted secret permanently unreadable | Mirrored to Secret Manager `vaani-env` (verified byte-for-byte); VM service account granted `roles/secretmanager.secretAccessor` so recovery works from the box. **Must be re-versioned on every credential rotation** — see §0. |
| **No disk snapshots at all** (0 snapshots, no schedule) — the whole non-database side of the box was unprotected | Schedule `vaani-daily` created (03:00, 14-day retention, `keep-auto-snapshots` on disk delete) and attached to disk `vaani-vm`; baseline snapshot `vaani-vm-manual-20260809` taken (2.44 GB stored). Cuts VM-loss RTO from 4–8 h to ~20 min. |
| **`.env` was world-readable** (`-rw-r--r--`), exposing `SECRET_ENC_KEY`, `TWILIO_AUTH_TOKEN`, `GEMINI_API_KEY`, `DEEPGRAM_API_KEY`, `GOOGLE_OAUTH_CLIENT_SECRET` to any local account | `chmod 600`. Verified the app was unaffected (no restart, `/api/health` still `ok`). |
| **Restore had never been tested**, and nothing kept it tested | `scripts/restore-drill.sh` added, deployed to the VM, and wired to cron (`0 5 1 * *`). Drilled successfully three times on 2026-08-09, including once through the exact cron command line. Alerts to Cloud Logging `db-restore-drill` (severity ERROR) on failure. |

### Still open

| # | Gap | Fix | Effort |
|---|---|---|---|
| 1 | **No Monitoring alert policy on `db-restore-drill`.** The drill writes ERROR to Cloud Logging, but nothing turns that into an email — a failed drill is currently as silent as the problem it exists to catch. | Create an alert policy on that log name and point it at the same notification channel `db-backup-freshness` uses. | ~15 min |
| 2 | **RPO is 24 h.** No WAL archiving; a pre-dawn failure loses a full day of calls, appointments and transcripts. | WAL archiving to GCS for PITR, or a second midday dump for a 12 h RPO. | 30 min (2nd dump) / ~4 h (PITR) |
| 3 | **Neither VM-loss path (§6.1, §6.2) has ever been executed.** The 20 min and 4–8 h figures are estimates. | The quarterly scratch-VM drill in §8. | ~half a day, once |
| 4 | **Secret Manager copy shares the VM's project.** Covers disk and VM loss; does not cover losing project `callsera` itself. | A copy in a password manager outside GCP. | 2 min |
| 5 | **`STORAGE_DIR=./storage` is in no backup.** Currently empty (documents live in the DB as `DocumentChunk` rows), so this is latent — but the day uploads start landing there, they are unprotected. | Add to the nightly job, or move uploads to GCS. | ~1 h, when it matters |
| 6 | **Single VM, no HA** — in-memory call sessions and an in-process rate limiter (`rate-limit.ts`), pm2 in *fork* not cluster mode. Any recovery is a full outage. Tracked as `AUDIT_REPORT.md` F-3.1. | Out of scope here; needs the stateless-voice-server work. | large |

---

## 8. Drill cadence

- **Monthly** — §5 restore drill. Automated: `0 5 1 * *` on the VM, logging to
  `~/db-backups/drill.log`. Non-destructive; no action needed unless it alerts.
- **Quarterly** — execute §6.1 into a scratch VM (`vaani-dr-test`), time it,
  correct this document, delete the VM. This is the only way that ~20 min stops
  being a guess. Exercise §6.2 annually, or whenever the stack changes materially.
- **On every credential rotation** — `gcloud secrets versions add vaani-env`
  (§0). A stale secret copy fails exactly like no copy at all.
- **After any infra change** — re-verify §1. This runbook was written because the
  previous reference table had drifted to a dead IP and the wrong GCP project,
  which sent a live investigation chasing an outage that was not happening.
