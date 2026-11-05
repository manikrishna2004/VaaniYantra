# Local development Postgres — start / stop / status.
#
# A portable PostgreSQL 15 cluster under the user profile, matching production's
# 15.18 (docs/DISASTER_RECOVERY.md §2). Deliberately NOT a Windows service and
# NOT an installed program: it needs no admin rights, and removing it is
# `Remove-Item -Recurse C:\Users\balij\pgsql15`.
#
# This is a DEV database only. Production lives on the VM in us-east1 and its
# credentials come from Secret Manager at deploy time — a laptop that can reach
# production Postgres is a liability, not a convenience.
#
#   .\scripts\local-db.ps1 start
#   .\scripts\local-db.ps1 stop
#   .\scripts\local-db.ps1 status
#   .\scripts\local-db.ps1 psql       # interactive shell against the vaani db
#
# The cluster does not survive a reboot on its own — run `start` again.

param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'status', 'psql')]
  [string]$Action = 'status'
)

$PgHome = 'C:\Users\balij\pgsql15'
$PgData = "$PgHome\data"
$PgPort = 5432
$LogFile = "$PgHome\server.log"

if (-not (Test-Path "$PgData\PG_VERSION")) {
  Write-Error "No cluster at $PgData. See docs/DEVELOPER_GUIDE.md - Local database."
  exit 1
}

switch ($Action) {
  'start' {
    & "$PgHome\bin\pg_ctl.exe" -D $PgData -l $LogFile -o "-p $PgPort" start
    Start-Sleep -Seconds 2
    & "$PgHome\bin\pg_isready.exe" -p $PgPort
  }
  'stop' {
    & "$PgHome\bin\pg_ctl.exe" -D $PgData -m fast stop
  }
  'status' {
    & "$PgHome\bin\pg_isready.exe" -p $PgPort
    & "$PgHome\bin\pg_ctl.exe" -D $PgData status
  }
  'psql' {
    $env:PGPASSWORD = 'vaani_local_dev'
    & "$PgHome\bin\psql.exe" -U vaani -p $PgPort -d vaani
  }
}
