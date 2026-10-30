#!/usr/bin/env bash
# Show IPs currently banned by Cinder's Fail2ban jail.
#
#   sudo bash deploy/fail2ban-status.sh

set -euo pipefail

JAIL="cinder-unlock"
FAILED_MSG=""

say() { printf '%s\n' "$*"; }
die() {
  FAILED_MSG="$*"
  printf 'error: %s\n' "$*" >&2
  exit 1
}

trap 'status=$?; if [[ $status -ne 0 && -z "$FAILED_MSG" ]]; then printf "error: fail2ban status stopped near line %s (exit %s).\n" "$LINENO" "$status" >&2; fi' EXIT

usage() {
  cat << 'EOF'
Usage: sudo bash deploy/fail2ban-status.sh

Shows the IPs currently banned by the cinder-unlock Fail2ban jail.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi
[[ $# -eq 0 ]] || die "Unknown argument: $1 (try --help)"

if [[ $EUID -ne 0 ]]; then
  exec sudo bash "$0" "$@"
fi

command -v fail2ban-client >/dev/null 2>&1 || die "fail2ban-client is not installed. Run deploy/install.sh first."
systemctl is-active --quiet fail2ban || die "Fail2ban is not running."

status=$(fail2ban-client status "$JAIL" 2>/dev/null) || die "Fail2ban jail ${JAIL} is not loaded."
banned=$(printf '%s\n' "$status" | awk -F': ' '/Banned IP list:/ { print $2 }')

if [[ -z "$banned" ]]; then
  say "No IPs are currently banned by ${JAIL}."
  exit 0
fi

say "IPs currently banned by ${JAIL}:"
for ip in $banned; do
  say "  ${ip}"
done
