#!/usr/bin/env bash
# Install or update Cinder on Debian and Ubuntu.
#
# From the unpacked source tree:
#   sudo bash deploy/install.sh
#   sudo bash deploy/install.sh --domain files.example.com --email you@example.com
#
# The Node process listens on 127.0.0.1:3000. That port is the application,
# not PostgreSQL. PostgreSQL stays on 127.0.0.1:5432. Nginx is the only
# service on ports 80 and 443.
#
# Running the script again keeps the database and /opt/cinder/.env.
# It does not print the database password.

set -euo pipefail

PREFIX="/opt/cinder"
DOMAIN=""
DOMAIN_FROM_CLI=0
EMAIL=""
STATE_FILE="/etc/cinder/install.env"
NODE_DIST_INDEX="https://nodejs.org/dist/latest-v22.x"
FAILED_MSG=""

say() { printf '%s\n' "$*"; }
die() {
  FAILED_MSG="$*"
  printf 'error: %s\n' "$*" >&2
  exit 1
}

trap 'status=$?; if [[ $status -ne 0 && -z "$FAILED_MSG" ]]; then printf "error: install stopped near line %s (exit %s).\n" "$LINENO" "$status" >&2; fi' EXIT

usage() {
  cat << 'EOF'
Usage: sudo bash deploy/install.sh [options]

Options:
  --domain NAME   Public hostname for this server
  --email ADDR    Contact email for a Let's Encrypt certificate
  --prefix DIR    Install directory (default: /opt/cinder)
  -h, --help      Show this help

With no options the site is served on HTTPS port 443 and HTTP redirects there. If
/etc/letsencrypt/live/ already holds a certificate, that certificate and its
domain name are used. Otherwise HTTPS uses a self-signed certificate.
Pass --domain and --email when a DNS name already points here and port 80
is reachable from the internet. If Let's Encrypt cannot issue a certificate,
HTTP still redirects to self-signed HTTPS. When more than one certificate is
already present, pass --domain to choose it.
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
    --domain)
      [[ $# -ge 2 ]] || die "--domain needs a hostname"
      DOMAIN=$2
      DOMAIN_FROM_CLI=1
      shift 2
      ;;
    --email)
      [[ $# -ge 2 ]] || die "--email needs an address"
      EMAIL=$2
      shift 2
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

[[ -d /run/systemd/system ]] || die "systemd is required. This installer supports Debian and Ubuntu servers."

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
else
  die "Cannot read /etc/os-release. This installer supports Debian and Ubuntu."
fi
case "${ID:-}" in
  ubuntu|debian) ;;
  *)
    case " ${ID_LIKE:-} " in
      *" debian "*|*" ubuntu "*) ;;
      *) die "This installer supports Debian and Ubuntu (this system is ${ID:-unknown})." ;;
    esac
    ;;
esac

if [[ -n "$DOMAIN" ]]; then
  [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "The domain must be a hostname, not a URL."
  [[ "$DOMAIN" == *.* ]] || die "The domain must contain a dot."
fi
if [[ -n "$EMAIL" ]]; then
  [[ "$EMAIL" == *@*.* ]] || die "The email address does not look usable."
fi
[[ "$PREFIX" == /* ]] || die "--prefix must be an absolute path."
[[ "$PREFIX" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--prefix may contain only letters, numbers, and . _ / -"
case "$PREFIX" in
  /|/usr|/usr/*|/bin|/bin/*|/sbin|/sbin/*|/lib|/lib/*|/etc|/etc/*|/boot|/boot/*|/home|/home/*|/root|/root/*|/var|/var/*|/tmp|/tmp/*)
    die "Refusing to install into ${PREFIX}."
    ;;
esac

if [[ -f "$STATE_FILE" ]]; then
  if [[ -z "$DOMAIN" ]]; then
    DOMAIN=$(grep -E '^DOMAIN=' "$STATE_FILE" | tail -n 1 | cut -d= -f2- || true)
  fi
  if [[ -z "$EMAIL" ]]; then
    EMAIL=$(grep -E '^EMAIL=' "$STATE_FILE" | tail -n 1 | cut -d= -f2- || true)
  fi
  [[ -z "$DOMAIN" || "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || DOMAIN=""
  [[ -z "$EMAIL" || "$EMAIL" == *@*.* ]] || EMAIL=""
fi

SOURCE=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
[[ -f "$SOURCE/package.json" && -f "$SOURCE/package-lock.json" ]] || die "Run this script from an unpacked Cinder tree. package.json is not next to deploy/."

mkdir -p "$(dirname "$PREFIX")"
avail_kb=$(df -Pk "$(dirname "$PREFIX")" | awk 'NR==2 {print $4}')
[[ "${avail_kb:-0}" -ge 1500000 ]] || die "Need at least 1.5 GB free on the disk that will hold ${PREFIX}."

if [[ -r /proc/meminfo ]]; then
  mem_kb=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
  if [[ "${mem_kb:-0}" -lt 1000000 ]]; then
    say "Warning: less than 1 GB of memory is free. The build may be killed."
  fi
fi

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=l
export APT_LISTCHANGES_FRONTEND=none
APT_OPTS=(-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

say "Installing packages."
updated=0
for _ in 1 2 3 4 5; do
  if apt-get update; then
    updated=1
    break
  fi
  sleep 3
done
[[ "$updated" == 1 ]] || die "apt-get update failed."
# --no-upgrade installs anything missing and leaves packages that are already
# installed at their current version. A Cinder install should not upgrade libc.
apt-get install -y --no-upgrade "${APT_OPTS[@]}" \
  ca-certificates curl xz-utils openssl nginx postgresql rsync iproute2 fail2ban python3-systemd

as_user() {
  local user=$1
  shift
  /usr/sbin/runuser -u "$user" -- "$@"
}

node_major() {
  "$1" -p "Number(process.versions.node.split('.')[0])"
}

install_node() {
  local current=""
  if command -v node >/dev/null 2>&1; then
    current=$(command -v node)
    if [[ "$(node_major "$current")" -ge 22 ]]; then
      say "Using $( "$current" -v ) at ${current}."
      return
    fi
    say "Found $( "$current" -v ). Cinder needs Node.js 22 or newer."
  fi

  local arch node_arch
  arch=$(uname -m)
  case "$arch" in
    x86_64) node_arch=x64 ;;
    aarch64|arm64) node_arch=arm64 ;;
    *) die "No Node.js 22 build is prepared for ${arch}. Install Node.js 22 and run this script again." ;;
  esac

  local tmp file
  tmp=$(mktemp -d)
  say "Downloading Node.js 22."
  curl -fsSL --retry 5 --retry-delay 2 -o "$tmp/SHASUMS256.txt" "${NODE_DIST_INDEX}/SHASUMS256.txt" \
    || die "Could not download Node.js checksums from ${NODE_DIST_INDEX}."
  file=$(awk -v arch="$node_arch" '$2 ~ "^node-v22\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$" { print $2; exit }' "$tmp/SHASUMS256.txt")
  [[ -n "$file" ]] || die "The Node.js 22 index has no Linux tarball for ${node_arch}."
  curl -fsSL --retry 5 --retry-delay 2 -o "$tmp/$file" "${NODE_DIST_INDEX}/$file" \
    || die "Could not download ${file}."
  (
    cd "$tmp"
    grep -F "  ${file}" SHASUMS256.txt | sha256sum -c -
  ) || die "The Node.js download did not match its published checksum."
  tar -xJf "$tmp/$file" -C /usr/local --strip-components=1
  rm -rf "$tmp"
  hash -r
  command -v node >/dev/null 2>&1 || die "Node.js installed, but node is not on PATH."
  [[ "$(node_major "$(command -v node)")" -ge 22 ]] || die "Node.js 22 did not become the node on PATH."
  say "Installed $(node -v)."
}

install_node
NODE_BIN=$(readlink -f "$(command -v node)")
[[ -x "$NODE_BIN" ]] || die "Cannot resolve the node binary."

say "Starting PostgreSQL."
systemctl enable postgresql
systemctl start postgresql
ready=0
for _ in $(seq 1 40); do
  if as_user postgres pg_isready -q; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" == 1 ]] || die "PostgreSQL did not become ready. journalctl -u postgresql -e"

pg_num=$(as_user postgres psql -tAc 'SHOW server_version_num' | tr -d '[:space:]')
[[ "${pg_num:-0}" -ge 140000 ]] || die "PostgreSQL 14 or newer is required."

if ! getent passwd cinder >/dev/null; then
  say "Creating the cinder system user."
  useradd --system --home-dir "$PREFIX" --shell /usr/sbin/nologin --user-group cinder
fi
getent group cinder >/dev/null || groupadd --system cinder

if systemctl cat cinder.service >/dev/null 2>&1; then
  if systemctl is-active --quiet cinder; then
    say "Stopping Cinder for the update."
  fi
  systemctl stop cinder || true
fi

mkdir -p "$PREFIX"
if [[ "$SOURCE" != "$PREFIX" ]]; then
  say "Copying Cinder to ${PREFIX}."
  rsync -a --delete \
    --exclude '.env' \
    --exclude 'node_modules' \
    --exclude '.output' \
    --exclude '.npm' \
    --exclude '.git' \
    --exclude '.DS_Store' \
    "$SOURCE"/ "$PREFIX"/
fi

env_get() {
  local key=$1 file=$2 line
  [[ -f "$file" ]] || return 0
  line=$(grep -E "^${key}=" "$file" | tail -n 1 || true)
  printf '%s' "${line#"${key}"=}"
}

assert_safe_env_path() {
  local file=$1
  [[ ! -L "$file" ]] || die "Refusing to use symlinked environment file: ${file}"
  [[ ! -e "$file" || -f "$file" ]] || die "Environment path is not a regular file: ${file}"
}

upsert_env() {
  local file=$1 key=$2 value=$3 tmp
  assert_safe_env_path "$file"
  tmp=$(mktemp /etc/cinder/.env.XXXXXX)
  if [[ -f "$file" ]] && grep -q "^${key}=" "$file"; then
    awk -v k="$key" -v v="$value" '$0 ~ "^" k "=" { print k "=" v; next } { print }' "$file" > "$tmp"
  else
    [[ ! -f "$file" ]] || cat "$file" > "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  chmod 600 "$tmp"
  mv -Tf "$tmp" "$file"
}

install -d -m 755 /etc/cinder
assert_safe_env_path "$PREFIX/.env"
db_url=$(env_get DATABASE_URL "$PREFIX/.env")
case "$db_url" in
  *change-me*|*choose-a-long-password*|"")
    db_url=""
    ;;
esac

replace_db_url=0
if [[ -z "$db_url" ]]; then
  replace_db_url=1
  say "Creating the PostgreSQL role and database."
  db_pass=$(openssl rand -hex 24)
  # Hex only, so this can be placed in SQL and in systemd's environment file
  # without quoting surprises. psql does not expand :'var' inside a DO block.
  [[ "$db_pass" =~ ^[0-9a-f]{48}$ ]] || die "Could not generate a database password."
  as_user postgres psql -v ON_ERROR_STOP=1 << SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cinder') THEN
    CREATE ROLE cinder LOGIN PASSWORD '${db_pass}';
  ELSE
    ALTER ROLE cinder WITH LOGIN PASSWORD '${db_pass}';
  END IF;
END
\$\$;
SQL
  if ! as_user postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'cinder'" | grep -q 1; then
    as_user postgres createdb -O cinder cinder
  fi
  db_url="postgres://cinder:${db_pass}@127.0.0.1:5432/cinder"
  unset db_pass
else
  say "Keeping the database password already stored in ${PREFIX}/.env."
fi

as_user postgres psql -v ON_ERROR_STOP=1 << 'SQL'
ALTER DATABASE cinder OWNER TO cinder;
REVOKE ALL ON DATABASE cinder FROM PUBLIC;
GRANT ALL ON DATABASE cinder TO cinder;
SQL
as_user postgres psql -d cinder -v ON_ERROR_STOP=1 << 'SQL'
ALTER SCHEMA public OWNER TO cinder;
GRANT ALL ON SCHEMA public TO cinder;
SQL

umask 077
if [[ ! -f "$PREFIX/.env" ]]; then
  env_tmp=$(mktemp /etc/cinder/.env.XXXXXX)
  cat > "$env_tmp" << EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
NITRO_HOST=127.0.0.1
NITRO_PORT=3000
DATABASE_URL=${db_url}
EOF
  chmod 600 "$env_tmp"
  mv -Tf "$env_tmp" "$PREFIX/.env"
fi
umask 022
upsert_env "$PREFIX/.env" NODE_ENV production
upsert_env "$PREFIX/.env" HOST 127.0.0.1
upsert_env "$PREFIX/.env" PORT 3000
upsert_env "$PREFIX/.env" NITRO_HOST 127.0.0.1
upsert_env "$PREFIX/.env" NITRO_PORT 3000
if [[ "$replace_db_url" == 1 ]] || ! grep -q '^DATABASE_URL=postgres' "$PREFIX/.env"; then
  upsert_env "$PREFIX/.env" DATABASE_URL "$db_url"
fi
chown cinder:cinder "$PREFIX/.env"
chmod 600 "$PREFIX/.env"
db_url=$(env_get DATABASE_URL "$PREFIX/.env")
[[ -n "$db_url" ]] || die "DATABASE_URL is missing from ${PREFIX}/.env."

allow_db_login() {
  local hba marker tmp
  hba=$(as_user postgres psql -tAc 'SHOW hba_file' | tr -d '[:space:]')
  [[ -n "$hba" && -f "$hba" ]] || die "Could not find pg_hba.conf."
  marker="cinder installer: localhost password login"
  if grep -F -q "$marker" "$hba"; then
    return
  fi
  tmp=$(mktemp)
  cat > "$tmp" << EOF
# ${marker}
host cinder cinder 127.0.0.1/32 scram-sha-256
host cinder cinder ::1/128 scram-sha-256
EOF
  cat "$hba" >> "$tmp"
  cat "$tmp" > "$hba"
  rm -f "$tmp"
  systemctl reload postgresql
  sleep 1
}

db_ok=0
for _ in 1 2; do
  if psql -w -v ON_ERROR_STOP=1 "$db_url" -c 'SELECT 1' >/dev/null 2>/tmp/cinder-psql.err; then
    db_ok=1
    break
  fi
  allow_db_login
done
if [[ "$db_ok" != 1 ]]; then
  say "PostgreSQL refused the configured login. The password was not printed."
  tail -n 20 /tmp/cinder-psql.err >&2 || true
  rm -f /tmp/cinder-psql.err
  die "Fix DATABASE_URL in ${PREFIX}/.env, or move that file aside and run the installer again to create a new password."
fi
rm -f /tmp/cinder-psql.err

say "Giving the application tree to the cinder user."
chown -R cinder:cinder "$PREFIX"

lock_sum=$(sha256sum "$PREFIX/package-lock.json" | awk '{print $1}')
say "Installing npm packages. This often takes a few minutes."
# The lockfile pins ajv 6 and ajv 8 together. npm ci rejects that unless
# --legacy-peer-deps is set. npm install would rewrite the lockfile.
as_user cinder env \
  HOME="$PREFIX" \
  CI=true \
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  npm_config_cache="$PREFIX/.npm" \
  bash -c "cd \"$PREFIX\" && npm ci --legacy-peer-deps --no-audit --no-fund" \
  || die "npm ci failed."
new_sum=$(sha256sum "$PREFIX/package-lock.json" | awk '{print $1}')
[[ "$lock_sum" == "$new_sum" ]] || die "npm ci changed package-lock.json. That should not happen."

say "Building the site and applying database migrations."
build_script=$(mktemp)
cat > "$build_script" << EOF
#!/bin/bash
set -euo pipefail
set -a
# shellcheck disable=SC1091
. "$PREFIX/.env"
set +a
cd "$PREFIX"
if [[ -z "\${DATABASE_URL:-}" ]]; then
  printf '%s\n' "DATABASE_URL is empty" >&2
  exit 1
fi
npm run build
EOF
chown cinder:cinder "$build_script"
chmod 700 "$build_script"
build_log=/var/log/cinder-build.log
if ! as_user cinder env HOME="$PREFIX" npm_config_cache="$PREFIX/.npm" bash "$build_script" > "$build_log" 2>&1; then
  tail -n 50 "$build_log" >&2 || true
  rm -f "$build_script"
  die "Build failed. The full log is ${build_log}."
fi
rm -f "$build_script"
if grep -q 'DATABASE_URL not set' "$build_log"; then
  die "The build skipped database migrations because DATABASE_URL was empty."
fi
if ! grep -q '\[migrate\]' "$build_log"; then
  die "The build log has no migration result. See ${build_log}."
fi
[[ -f "$PREFIX/.output/server/index.mjs" ]] || die "The build did not produce .output/server/index.mjs."
chown -R root:root "$PREFIX"
chown cinder:cinder "$PREFIX/.env"
chmod 600 "$PREFIX/.env"

say "Installing the systemd service."
sed \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=${PREFIX}|" \
  -e "s|^EnvironmentFile=.*|EnvironmentFile=${PREFIX}/.env|" \
  -e "s|^ExecStart=.*|ExecStart=${NODE_BIN} .output/server/index.mjs|" \
  -e "s|^ReadWritePaths=.*|ReadWritePaths=${PREFIX}|" \
  -e "s|^Documentation=.*|Documentation=file://${PREFIX}/README.md|" \
  "$PREFIX/deploy/cinder.service" > /etc/systemd/system/cinder.service
sed \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=${PREFIX}|" \
  -e "s|^EnvironmentFile=.*|EnvironmentFile=${PREFIX}/.env|" \
  -e "s|^ExecStart=.*|ExecStart=${NODE_BIN} scripts/expire.mjs|" \
  -e "s|^Documentation=.*|Documentation=file://${PREFIX}/README.md|" \
  "$PREFIX/deploy/cinder-expire.service" > /etc/systemd/system/cinder-expire.service
cp "$PREFIX/deploy/cinder-expire.timer" /etc/systemd/system/cinder-expire.timer

say "Configuring Fail2ban."
install -D -m 644 "$PREFIX/deploy/fail2ban/cinder-unlock.conf" /etc/fail2ban/filter.d/cinder-unlock.conf
install -D -m 644 "$PREFIX/deploy/fail2ban/cinder.local" /etc/fail2ban/jail.d/cinder.local
fail2ban-client -t || die "Fail2ban rejected the Cinder jail configuration."

systemctl daemon-reload
systemctl enable cinder
systemctl enable cinder-expire.timer
systemctl enable fail2ban
systemctl reset-failed cinder || true
systemctl restart cinder
systemctl restart cinder-expire.timer
systemctl restart fail2ban || die "Fail2ban did not start. Check: journalctl -u fail2ban -e"
fail2ban-client status cinder-unlock >/dev/null || die "Fail2ban did not load the cinder-unlock jail."
systemctl start cinder-expire.service || die "Could not delete expired seals. Check: journalctl -u cinder-expire.service"

app_up=0
for _ in $(seq 1 30); do
  if curl -sf --max-time 3 -o /dev/null http://127.0.0.1:3000/; then
    app_up=1
    break
  fi
  sleep 1
done
if [[ "$app_up" != 1 ]]; then
  journalctl -u cinder -n 40 --no-pager >&2 || true
  die "Cinder did not answer on 127.0.0.1:3000."
fi

# Skip container bridges. docker0 and br-* are not addresses other machines use.
mapfile -t ips < <(ip -4 -o addr show scope global | awk '$2 != "docker0" && $2 !~ /^(br-|veth|docker)/ { split($4, a, "/"); print a[1] }' | sort -u)
mapfile -t ip6s < <(ip -6 -o addr show scope global 2>/dev/null | awk '$2 != "docker0" && $2 !~ /^(br-|veth|docker)/ { split($4, a, "/"); print a[1] }' | sort -u || true)
host_short=$(hostname -s 2>/dev/null || hostname)
host_fqdn=$(hostname -f 2>/dev/null || true)
[[ "$host_fqdn" == "$host_short" ]] && host_fqdn=""

# Certificate directories created by certbot. The directory name is the domain.
list_live_domains() {
  local root=${1:-/etc/letsencrypt/live} dir name
  [[ -d "$root" ]] || return 0
  shopt -s nullglob
  for dir in "$root"/*; do
    [[ -d "$dir" ]] || continue
    name=$(basename "$dir")
    [[ "$name" == "README" ]] && continue
    [[ "$name" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || continue
    [[ "$name" == *.* ]] || continue
    [[ -f "$dir/fullchain.pem" && -f "$dir/privkey.pem" ]] || continue
    printf '%s\n' "$name"
  done
  shopt -u nullglob
}

# Echo the domain to use. Empty output means there is no certificate to adopt.
# Exit 2 when several certificates exist and neither the saved domain nor the
# hostname picks one. Those names are printed, one per line.
adopt_live_domain() {
  local requested=$1 host=$2 root=${3:-/etc/letsencrypt/live}
  local -a found=()
  local live_name
  mapfile -t found < <(list_live_domains "$root" | sort -u)
  if [[ -n "$requested" ]]; then
    for live_name in "${found[@]+"${found[@]}"}"; do
      if [[ "$live_name" == "$requested" ]]; then
        printf '%s\n' "$requested"
        return 0
      fi
    done
  fi
  if [[ -n "$host" ]]; then
    for live_name in "${found[@]+"${found[@]}"}"; do
      if [[ "$live_name" == "$host" ]]; then
        printf '%s\n' "$live_name"
        return 0
      fi
    done
  fi
  if [[ ${#found[@]} -eq 1 ]]; then
    printf '%s\n' "${found[0]}"
    return 0
  fi
  if [[ ${#found[@]} -gt 1 ]]; then
    printf '%s\n' "${found[@]}"
    return 2
  fi
  return 0
}

cert_dns_names() {
  local crt=$1
  [[ -f "$crt" ]] || return 0
  openssl x509 -in "$crt" -noout -text 2>/dev/null | awk '
    /Subject Alternative Name/ { found = 1; next }
    found && /DNS:/ {
      n = split($0, parts, ",")
      for (i = 1; i <= n; i++) {
        if (match(parts[i], /DNS:\*?[A-Za-z0-9.-]+/)) {
          print substr(parts[i], RSTART + 4, RLENGTH - 4)
        }
      }
      exit
    }
    found { exit }
  '
}

# A domain passed on the command line wins. Otherwise use a certificate that
# is already on disk, and take the domain from that directory.
if [[ "$DOMAIN_FROM_CLI" != 1 ]]; then
  adopt_status=0
  adopted=$(adopt_live_domain "$DOMAIN" "$host_fqdn") || adopt_status=$?
  if [[ "$adopt_status" -eq 2 ]]; then
    say "More than one certificate is in /etc/letsencrypt/live/."
    while IFS= read -r live_name; do
      [[ -n "$live_name" ]] && printf '  %s\n' "$live_name"
    done <<< "$adopted"
    die "Pass --domain to choose which certificate Cinder should use."
  fi
  [[ "$adopt_status" -eq 0 ]] || die "Could not read /etc/letsencrypt/live/."
  if [[ -n "$adopted" ]]; then
    DOMAIN=$adopted
  fi
fi

CERT_DNS=()
if [[ -n "$DOMAIN" && -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]]; then
  mapfile -t CERT_DNS < <(cert_dns_names "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem")
fi

san_parts=()
for ip in "${ips[@]+"${ips[@]}"}"; do
  [[ -n "$ip" ]] && san_parts+=("IP:${ip}")
done
for ip in "${ip6s[@]+"${ip6s[@]}"}"; do
  [[ -n "$ip" ]] && san_parts+=("IP:${ip}")
done
[[ -n "$host_short" ]] && san_parts+=("DNS:${host_short}")
[[ -n "$host_fqdn" ]] && san_parts+=("DNS:${host_fqdn}")
[[ -n "$DOMAIN" ]] && san_parts+=("DNS:${DOMAIN}")
[[ ${#san_parts[@]} -gt 0 ]] || die "Could not find a name or address for the certificate."
san=$(IFS=,; printf '%s' "${san_parts[*]}")
cn=${DOMAIN:-}
[[ -n "$cn" ]] || cn=${ips[0]:-}
[[ -n "$cn" ]] || cn=${host_fqdn:-$host_short}

nginx_user=$(awk '$1 == "user" { gsub(/;/, "", $2); print $2; exit }' /etc/nginx/nginx.conf)
nginx_user=${nginx_user:-www-data}
install -d -m 755 -o root -g "$nginx_user" /etc/nginx/ssl
cert=/etc/nginx/ssl/cinder.crt
key=/etc/nginx/ssl/cinder.key
need_cert=0
if [[ ! -f "$cert" || ! -f "$key" ]]; then
  need_cert=1
else
  cert_text=$(openssl x509 -in "$cert" -noout -text 2>/dev/null || true)
  for part in "${san_parts[@]}"; do
    if [[ "$part" == IP:* ]]; then
      grep -q "IP Address:${part#IP:}" <<<"$cert_text" || need_cert=1
    else
      grep -q "$part" <<<"$cert_text" || need_cert=1
    fi
  done
fi
if [[ "$need_cert" == 1 ]]; then
  say "Writing a self-signed certificate for ${cn}."
  openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
    -keyout "$key" -out "$cert" \
    -subj "/CN=${cn}" \
    -addext "subjectAltName=${san}" \
    >/dev/null 2>&1 \
    || die "openssl could not write the self-signed certificate."
fi
chown root:"$nginx_user" "$key" "$cert"
chmod 640 "$key"
chmod 644 "$cert"

nginx_ver=$(nginx -v 2>&1 | sed -n 's|.*nginx/||p')
oldest=$(printf '%s\n%s\n' "1.25.1" "$nginx_ver" | sort -V | head -n 1)
if [[ "$oldest" == "1.25.1" ]]; then
  NGINX_HTTP2_ON=1
else
  NGINX_HTTP2_ON=0
fi
WANT_IPV6=0
if [[ -r /proc/sys/net/ipv6/conf/all/disable_ipv6 ]] && [[ $(cat /proc/sys/net/ipv6/conf/all/disable_ipv6) == 0 ]]; then
  WANT_IPV6=1
fi

names=()
add_server_name() {
  local candidate=$1 existing
  [[ -n "$candidate" ]] || return 0
  for existing in "${names[@]+"${names[@]}"}"; do
    [[ "$existing" == "$candidate" ]] && return 0
  done
  names+=("$candidate")
}
add_server_name "$DOMAIN"
for cert_name in "${CERT_DNS[@]+"${CERT_DNS[@]}"}"; do
  add_server_name "$cert_name"
done
for ip in "${ips[@]+"${ips[@]}"}"; do
  add_server_name "$ip"
done
add_server_name "$host_fqdn"
add_server_name "$host_short"
[[ ${#names[@]} -gt 0 ]] || names=("_")
server_names="${names[*]}"

write_nginx() {
  local mode=$1 default_flag=$2
  local listen80 listen443 listen80_6 listen443_6 http2_line site flag
  flag=""
  [[ -n "$default_flag" ]] && flag=" ${default_flag}"
  listen80="listen 80${flag};"
  listen443="listen 443 ssl${flag};"
  http2_line=""
  if [[ "$NGINX_HTTP2_ON" == 1 ]]; then
    http2_line="    http2 on;"
  else
    listen443="listen 443 ssl http2${flag};"
  fi
  listen80_6=""
  listen443_6=""
  if [[ "$WANT_IPV6" == 1 ]]; then
    listen80_6="    listen [::]:80${flag};"
    if [[ "$NGINX_HTTP2_ON" == 1 ]]; then
      listen443_6="    listen [::]:443 ssl${flag};"
    else
      listen443_6="    listen [::]:443 ssl http2${flag};"
    fi
  fi
  site=/etc/nginx/sites-available/cinder
  {
    printf '%s\n' "# Written by deploy/install.sh. Run that script again to replace this file."
    printf '%s\n' "# Uploads arrive in pieces of about 4 MB. client_max_body_size must stay at least 8m."
    printf '%s\n' "# JSON POSTs to /api/open are unlock attempts; multipart chunk downloads are not rate-limited."
    printf '%s\n' "map \$http_content_type \$cinder_unlock_key {"
    printf '%s\n' "    default \"\";"
    printf '%s\n' "    ~*^application/json \$binary_remote_addr;"
    printf '%s\n' "}"
    printf '%s\n' "limit_req_zone \$cinder_unlock_key zone=cinder_unlock:10m rate=10r/m;"
    printf '%s\n' "upstream cinder {"
    printf '%s\n' "    server 127.0.0.1:3000;"
    printf '%s\n' "    keepalive 16;"
    printf '%s\n' "}"
    if [[ "$mode" == "letsencrypt" ]]; then
      local le_ssl=""
      if [[ -f /etc/letsencrypt/options-ssl-nginx.conf ]]; then
        le_ssl=$'    include /etc/letsencrypt/options-ssl-nginx.conf;\n'
      else
        le_ssl=$'    ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_prefer_server_ciphers off;\n'
      fi
      if [[ -f /etc/letsencrypt/ssl-dhparams.pem ]]; then
        le_ssl+=$'    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;\n'
      fi
      cat << EOF
server {
    ${listen80}
${listen80_6}
    server_name ${server_names};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$server_name\$request_uri;
    }
}

server {
    ${listen443}
${listen443_6}
${http2_line}
    server_name ${server_names};

    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
${le_ssl}

    client_max_body_size 8m;
    access_log /var/log/nginx/cinder.access.log combined;
    error_log  /var/log/nginx/cinder.error.log;

    location = /api/open {
        limit_req zone=cinder_unlock burst=5 nodelay;
        limit_req_status 429;

        proxy_pass http://cinder;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection        "";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location / {
        proxy_pass http://cinder;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection        "";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
EOF
    else
      cat << EOF
server {
    ${listen80}
${listen80_6}
    server_name ${server_names};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$server_name\$request_uri;
    }
}

server {
    ${listen443}
${listen443_6}
${http2_line}
    server_name ${server_names};

    ssl_certificate     ${cert};
    ssl_certificate_key ${key};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:10m;

    client_max_body_size 8m;
    access_log /var/log/nginx/cinder.access.log combined;
    error_log  /var/log/nginx/cinder.error.log;

    location = /api/open {
        limit_req zone=cinder_unlock burst=5 nodelay;
        limit_req_status 429;

        proxy_pass http://cinder;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection        "";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location / {
        proxy_pass http://cinder;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection        "";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
EOF
    fi
  } > "$site"
}

enable_site() {
  mkdir -p /etc/nginx/sites-available
  if [[ -d /etc/nginx/sites-enabled ]]; then
    ln -sfn /etc/nginx/sites-available/cinder /etc/nginx/sites-enabled/cinder
    if [[ -e /etc/nginx/sites-enabled/default ]]; then
      rm -f /etc/nginx/sites-enabled/default
      say "Removed Nginx's stock welcome site so this address serves Cinder."
    fi
  elif [[ -d /etc/nginx/conf.d ]]; then
    ln -sfn /etc/nginx/sites-available/cinder /etc/nginx/conf.d/cinder.conf
  else
    die "Nginx has neither sites-enabled nor conf.d."
  fi
}

install -d -m 755 /var/www/certbot
previous_site=$(mktemp)
if [[ -f /etc/nginx/sites-available/cinder ]]; then
  cp /etc/nginx/sites-available/cinder "$previous_site"
fi

apply_nginx() {
  local mode=$1
  local err
  err=$(mktemp)
  write_nginx "$mode" "default_server"
  enable_site
  if nginx -t > "$err" 2>&1; then
    rm -f "$err"
    return 0
  fi
  if grep -q 'duplicate default server' "$err"; then
    write_nginx "$mode" ""
    if nginx -t > "$err" 2>&1; then
      rm -f "$err"
      return 0
    fi
  fi
  if grep -qiE 'ipv6|Address family not supported' "$err" && [[ "$WANT_IPV6" == 1 ]]; then
    WANT_IPV6=0
    write_nginx "$mode" ""
    if nginx -t > "$err" 2>&1; then
      rm -f "$err"
      return 0
    fi
  fi
  cat "$err" >&2 || true
  if [[ -s "$previous_site" ]]; then
    cp "$previous_site" /etc/nginx/sites-available/cinder
    nginx -t >/dev/null 2>&1 || true
  fi
  rm -f "$err"
  return 1
}

say "Configuring Nginx."
apply_nginx selfsigned || die "Nginx rejected the Cinder site."
cp /etc/nginx/sites-available/cinder "$previous_site"
systemctl enable nginx
systemctl restart nginx || die "Nginx did not start. Check: ss -ltnp | grep -E ':80|:443'"

page_ok() {
  local url=$1 body code attempt
  body=$(mktemp)
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    code=$(curl -skL --max-time 10 -o "$body" -w '%{http_code}' "$url" || true)
    if [[ "$code" == "200" ]] && grep -a -q 'Cinder' "$body"; then
      rm -f "$body"
      return 0
    fi
    sleep 1
  done
  rm -f "$body"
  return 1
}

page_ok "http://127.0.0.1/" || die "Nginx is up, but HTTP did not redirect to the Cinder page."
page_ok "https://127.0.0.1/" || die "HTTPS on port 443 is not serving Cinder."

le_cert=""
le_key=""
if [[ -n "$DOMAIN" ]]; then
  le_cert="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
  le_key="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
fi

if [[ -n "$DOMAIN" && -n "$EMAIL" && ! -f "$le_cert" ]]; then
  say "Requesting a Let's Encrypt certificate for ${DOMAIN}."
  apt-get install -y --no-upgrade "${APT_OPTS[@]}" certbot
  if certbot certonly --webroot -w /var/www/certbot \
    --non-interactive --agree-tos --email "$EMAIL" \
    --domain "$DOMAIN" --keep-until-expiring; then
    say "Let's Encrypt issued a certificate."
  else
    say "Let's Encrypt did not issue a certificate. Keeping the self-signed HTTPS certificate and HTTP redirect."
    say "A private address cannot get a public certificate. A public name has to point here, and port 80 has to be reachable from the internet."
  fi
fi

tls_kind="selfsigned"
tls_note="self-signed certificate; browsers will warn until it is trusted"
if [[ -n "$le_cert" && -f "$le_cert" && -f "$le_key" ]]; then
  say "Using the certificate already issued for ${DOMAIN}."
  if apply_nginx letsencrypt; then
    systemctl reload nginx
    if page_ok "https://127.0.0.1/"; then
      tls_kind="letsencrypt"
      tls_note="Let's Encrypt certificate for ${DOMAIN}"
      install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
      cat > /etc/letsencrypt/renewal-hooks/deploy/cinder-reload.sh << 'EOF'
#!/bin/sh
systemctl reload nginx
EOF
      chmod 755 /etc/letsencrypt/renewal-hooks/deploy/cinder-reload.sh
    else
      say "The Let's Encrypt site did not serve Cinder. Restoring self-signed HTTPS."
      apply_nginx selfsigned || die "Could not restore the self-signed Nginx site."
      systemctl reload nginx
    fi
  else
    say "Nginx rejected the Let's Encrypt site. Keeping the self-signed certificate."
    apply_nginx selfsigned || die "Could not restore the self-signed Nginx site."
    systemctl reload nginx
  fi
fi
rm -f "$previous_site"

install -d -m 755 /etc/cinder
umask 077
cat > "$STATE_FILE" << EOF
DOMAIN=${DOMAIN}
EMAIL=${EMAIL}
EOF
umask 022
chmod 644 "$STATE_FILE"

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q 'Status: active'; then
  say "UFW is on. Allowing SSH and Nginx, and not allowing port 3000."
  ufw allow OpenSSH >/dev/null || say "Warning: could not add the OpenSSH UFW rule."
  ufw allow 'Nginx Full' >/dev/null || say "Warning: could not add the Nginx Full UFW rule."
  ufw delete allow 3000/tcp >/dev/null 2>&1 || true
  ufw status
else
  say "UFW is not active, so the installer left the firewall alone."
fi

bad_app=$(ss -ltn | awk '$4 ~ /:3000$/ { print $4 }' | grep -vE '^(127\.0\.0\.1|\[::1\]):3000$' || true)
[[ -z "$bad_app" ]] || die "Node is listening beyond localhost (${bad_app}). Port 3000 must stay on 127.0.0.1."
if ss -ltn | awk '$4 ~ /:5432$/ { print $4 }' | grep -vE '^(127\.0\.0\.1|\[::1\]):5432$' >/dev/null; then
  say "Warning: PostgreSQL is not limited to localhost. Cinder itself does not need that."
fi

pid=$(systemctl show -p MainPID --value cinder)
if [[ -n "$pid" && "$pid" != 0 && -r "/proc/${pid}/environ" ]]; then
  app_host=$(tr '\0' '\n' < "/proc/${pid}/environ" | awk -F= '$1 == "HOST" { print $2 }' | tail -n 1)
  [[ "$app_host" == "127.0.0.1" ]] || die "The running process has HOST=${app_host}. It must be 127.0.0.1."
fi

for url in "http://127.0.0.1/" "https://127.0.0.1/"; do
  page_ok "$url" || die "Final check failed for ${url}."
done

say ""
say "Cinder is up."
if [[ ${#ips[@]} -eq 0 ]]; then
  say "  https://127.0.0.1/   ${tls_note}"
else
  for ip in "${ips[@]}"; do
    say "  https://${ip}/   ${tls_note}"
  done
fi
if [[ "$tls_kind" == "letsencrypt" && -n "$DOMAIN" ]]; then
  say "  https://${DOMAIN}/"
fi
say ""
say "Node listens on 127.0.0.1:3000. PostgreSQL listens on 127.0.0.1:5432."
say "The database password is in ${PREFIX}/.env (mode 600). This script does not print it."
say "Logs: journalctl -u cinder -e"
say "Update later by running this script again."
