#!/usr/bin/env bash
# Stop Cinder, delete every stored file, then start Cinder again.
#
#   sudo bash deploy/purge.sh --yes
#
# The database password stays in PREFIX/.env. This script does not print it.
# A pg_dump, the write-ahead log, and freed disk blocks can still hold copies.

set -euo pipefail

PREFIX="/opt/cinder"
YES=0
FAILED_MSG=""

say() { printf '%s\n' "$*"; }
die() {
  FAILED_MSG="$*"
  printf 'error: %s\n' "$*" >&2
  exit 1
}

trap 'status=$?; if [[ $status -ne 0 && -z "$FAILED_MSG" ]]; then printf "error: purge stopped near line %s (exit %s).\n" "$LINENO" "$status" >&2; fi' EXIT

usage() {
  cat << 'EOF'
Usage: sudo bash deploy/purge.sh --yes [--prefix DIR]

Stops the cinder service, runs scripts/purge.mjs, then starts cinder again.
Without --yes the script refuses and leaves the service running.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes)
      YES=1
      shift
      ;;
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

if [[ "$YES" != 1 ]]; then
  die "Refusing to wipe the database without --yes."
fi

if [[ $EUID -ne 0 ]]; then
  exec sudo bash "$0" "$@"
fi
[[ "$PREFIX" == /* ]] || die "--prefix must be an absolute path."
[[ "$PREFIX" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--prefix may contain only letters, numbers, and . _ / -"
[[ -f "${PREFIX}/.env" ]] || die "Missing ${PREFIX}/.env. Run deploy/install.sh first."
[[ -f "${PREFIX}/scripts/purge.mjs" ]] || die "Missing ${PREFIX}/scripts/purge.mjs."

# The expiry and compaction jobs connect to the database on their own timers.
# Stop them too, so the purge has the database to itself.
# Only timers that were running are started again afterwards; a manual
# install may not have them at all.
TIMERS_WERE_ACTIVE=()
for unit in cinder-expire.timer cinder-compact.timer; do
  if systemctl is-active --quiet "$unit"; then TIMERS_WERE_ACTIVE+=("$unit"); fi
done
say "Stopping Cinder and its scheduled jobs."
systemctl stop cinder
for unit in cinder-expire.timer cinder-compact.timer cinder-expire.service cinder-compact.service; do
  if systemctl cat "$unit" >/dev/null 2>&1; then systemctl stop "$unit"; fi
done

say "Deleting stored files."
if ! sudo -u cinder bash -lc "set -a; . '${PREFIX}/.env'; set +a; cd '${PREFIX}' && PATH=\"/usr/local/bin:/usr/bin:\$PATH\" node scripts/purge.mjs --yes"; then
  die "Purge failed. Cinder and its timers are still stopped; start them with: systemctl start cinder ${TIMERS_WERE_ACTIVE[*]:-}"
fi

say "Starting Cinder."
systemctl start cinder
if [[ ${#TIMERS_WERE_ACTIVE[@]} -gt 0 ]]; then systemctl start "${TIMERS_WERE_ACTIVE[@]}"; fi
systemctl is-active --quiet cinder
say "Cinder is running. Live table files no longer contain the deleted rows."
