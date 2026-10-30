#!/usr/bin/env bash
# Remove every IP currently banned by Cinder's Fail2ban jail.
#
#   sudo bash deploy/fail2ban-flush.sh --yes

set -euo pipefail

JAIL="cinder-unlock"
YES=0
FAILED_MSG=""

say() { printf '%s\n' "$*"; }
die() {
  FAILED_MSG="$*"
  printf 'error: %s\n' "$*" >&2
  exit 1
}

trap 'status=$?; if [[ $status -ne 0 && -z "$FAILED_MSG" ]]; then printf "error: fail2ban flush stopped near line %s (exit %s).\n" "$LINENO" "$status" >&2; fi' EXIT

usage() {
  cat << 'EOF'
Usage: sudo bash deploy/fail2ban-flush.sh --yes

Removes every IP currently banned by the cinder-unlock Fail2ban jail.
Without --yes the script refuses to make changes.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes)
      YES=1
      shift
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
  die "Refusing to flush bans without --yes."
fi

if [[ $EUID -ne 0 ]]; then
  exec sudo bash "$0" "$@"
fi

command -v fail2ban-client >/dev/null 2>&1 || die "fail2ban-client is not installed. Run deploy/install.sh first."
systemctl is-active --quiet fail2ban || die "Fail2ban is not running."
fail2ban-client status "$JAIL" >/dev/null 2>&1 || die "Fail2ban jail ${JAIL} is not loaded."

fail2ban-client set "$JAIL" unbanip --all >/dev/null
say "Cleared all IP bans from ${JAIL}."
