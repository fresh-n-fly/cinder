#!/usr/bin/env bash
# Show what Cinder still stores, and fail if rows that should be gone are still there.
#
#   sudo bash deploy/verify.sh
#   sudo bash deploy/verify.sh --prefix /opt/cinder
#
# The database password is read from PREFIX/.env. This script does not print it.
# A seal locked by wrong passwords, or one whose 15-minute download ticket is
# still valid, is supposed to remain. Those rows are listed under "Still stored"
# and are not treated as a failure.

set -euo pipefail

PREFIX="/opt/cinder"
FAILED_MSG=""

say() { printf '%s\n' "$*"; }
die() {
  FAILED_MSG="$*"
  printf 'error: %s\n' "$*" >&2
  exit 1
}



usage() {
  cat << 'EOF'
Usage: sudo bash deploy/verify.sh [--prefix DIR]

Reads DATABASE_URL from PREFIX/.env (default /opt/cinder/.env) and checks the
live tables. Exit 0 means nothing overdue is still stored. Exit 1 means a seal
past its expiry, a used-up seal whose download ticket has ended, an upload
abandoned for more than two hours, or an orphan chunk is still present.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $EUID -ne 0 ]]; then
  exec sudo bash "$0" "$@"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      [[ $# -ge 2 ]] || die "--prefix needs a directory"
      PREFIX=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1 (try --help)"
      ;;
  esac
done

[[ "$PREFIX" == /* ]] || die "--prefix must be an absolute path."
[[ "$PREFIX" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--prefix may contain only letters, numbers, and . _ / -"
env_file="${PREFIX}/.env"
[[ -f "$env_file" ]] || die "Missing ${env_file}. Run deploy/install.sh first."

db_url=$(grep -E '^DATABASE_URL=' "$env_file" | tail -n 1 || true)
db_url=${db_url#DATABASE_URL=}
case "$db_url" in
  *change-me*|*choose-a-long-password*|"")
    die "DATABASE_URL in ${env_file} is empty or still a placeholder."
    ;;
  postgres://*|postgresql://*) ;;
  *)
    die "DATABASE_URL in ${env_file} must start with postgres:// or postgresql://."
    ;;
esac

rest=${db_url#postgres://}
rest=${rest#postgresql://}
userinfo=${rest%%@*}
hostpart=${rest#*@}
[[ "$userinfo" != "$rest" && "$hostpart" != "$rest" ]] || die "DATABASE_URL is missing a user or host."
db_user=${userinfo%%:*}
db_pass=${userinfo#*:}
[[ -n "$db_user" && "$db_user" != "$userinfo" && -n "$db_pass" ]] || die "DATABASE_URL is missing a password."
[[ "$db_pass" != *:* && "$db_pass" != *\\* ]] || die "DATABASE_URL password contains a character this script cannot pass to psql."
db_name=${hostpart#*/}
db_name=${db_name%%\?*}
hostport=${hostpart%%/*}
db_host=${hostport%%:*}
if [[ "$hostport" == *:* ]]; then
  db_port=${hostport#*:}
else
  db_port=5432
fi
[[ -n "$db_host" && -n "$db_name" && "$db_name" != */* ]] || die "DATABASE_URL is missing a database name."
unset db_url rest userinfo hostpart

command -v psql >/dev/null 2>&1 || die "psql is not installed."

pgpass=$(mktemp)
chmod 600 "$pgpass"
printf '%s:%s:%s:%s:%s\n' "$db_host" "$db_port" "$db_name" "$db_user" "$db_pass" > "$pgpass"
unset db_pass
export PGPASSFILE=$pgpass
trap 'status=$?; rm -f "$pgpass"; if [[ $status -ne 0 && -z "$FAILED_MSG" ]]; then printf "error: verify stopped near line %s (exit %s).\n" "$LINENO" "$status" >&2; fi' EXIT

# -w never prompts, so a bad password fails instead of waiting.
psql_cmd() {
  psql -w -v ON_ERROR_STOP=1 -h "$db_host" -p "$db_port" -U "$db_user" -d "$db_name" "$@"
}

say "Still stored"
psql_cmd << 'SQL'
SELECT b.id,
       b.expires_at,
       b.download_count,
       b.max_downloads,
       b.failed_attempts,
       count(DISTINCT f.id) AS files,
       count(c.chunk_index) AS chunks
FROM sealed_batches b
LEFT JOIN sealed_files f ON f.batch_id = b.id
LEFT JOIN sealed_file_chunks c ON c.file_id = f.id
GROUP BY b.id
ORDER BY b.expires_at;
SQL

say "Overdue seals"
psql_cmd << 'SQL'
SELECT id, expires_at, download_count, max_downloads, grant_expires_at
FROM sealed_batches
WHERE expires_at <= now()
   OR (
     download_count >= max_downloads
     AND (grant_expires_at IS NULL OR grant_expires_at <= now())
   )
ORDER BY expires_at;
SQL

say "Overdue legacy files"
psql_cmd << 'SQL'
SELECT id, expires_at, download_count, max_downloads
FROM sealed_files
WHERE batch_id IS NULL
  AND (expires_at <= now() OR download_count >= max_downloads)
ORDER BY expires_at;
SQL

say "Abandoned uploads older than 2 hours"
psql_cmd << 'SQL'
SELECT count(*) AS abandoned_uploads
FROM upload_chunks c
LEFT JOIN upload_sessions s ON s.id = c.upload_id
WHERE (s.id IS NULL AND c.created_at < now() - interval '2 hours')
   OR (s.id IS NOT NULL AND (s.state <> 'pending' OR s.updated_at < now() - interval '2 hours'));
SQL

say "Abandoned upload sessions older than 2 hours"
psql_cmd << 'SQL'
SELECT count(*) AS abandoned_upload_sessions
FROM upload_sessions
WHERE state <> 'pending'
   OR (had_chunks = false AND updated_at < now() - interval '5 minutes')
   OR (had_chunks = true AND updated_at < now() - interval '2 hours');
SQL

say "Chunks whose file row is gone"
psql_cmd << 'SQL'
SELECT count(*) AS orphan_chunks
FROM sealed_file_chunks c
WHERE NOT EXISTS (SELECT 1 FROM sealed_files f WHERE f.id = c.file_id);
SQL

due=$(psql_cmd -tA << 'SQL'
SELECT
  (SELECT count(*) FROM sealed_batches
    WHERE expires_at <= now()
       OR (
         download_count >= max_downloads
         AND (grant_expires_at IS NULL OR grant_expires_at <= now())
       ))
  + (SELECT count(*) FROM sealed_files
      WHERE batch_id IS NULL
        AND (expires_at <= now() OR download_count >= max_downloads))
  + (SELECT count(*) FROM upload_chunks c
      LEFT JOIN upload_sessions s ON s.id = c.upload_id
      WHERE (s.id IS NULL AND c.created_at < now() - interval '2 hours')
         OR (s.id IS NOT NULL AND (s.state <> 'pending' OR s.updated_at < now() - interval '2 hours')))
  + (SELECT count(*) FROM upload_sessions
      WHERE state <> 'pending'
         OR (had_chunks = false AND updated_at < now() - interval '5 minutes')
         OR (had_chunks = true AND updated_at < now() - interval '2 hours'))
  + (SELECT count(*) FROM sealed_file_chunks c
      WHERE NOT EXISTS (SELECT 1 FROM sealed_files f WHERE f.id = c.file_id));
SQL
)
due=${due//[[:space:]]/}

if [[ "$due" == "0" ]]; then
  say "Live tables have nothing that is due for deletion."
  exit 0
fi

say "Rows that should be gone are still present (${due})."
say "The expiry job removes them about once a minute. To remove them now: sudo systemctl start cinder-expire.service"
FAILED_MSG="due"
exit 1
