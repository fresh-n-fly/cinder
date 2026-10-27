# Cinder

Cinder is a private file drop. A visitor locks one or more files with a password in their browser, then gets a link to send. The files are deleted when the expiry date is reached, or after they have been downloaded the allowed number of times.

File bytes, file names, and file types are locked in the browser. The password never leaves the sender’s (or recipient’s) browser. The server keeps the locked bytes, fixed-size locked copies of the names and types, and a check value used to confirm the password. Expiry, download limits, and the size of each locked piece stay visible to the operator so files can be deleted on time.

This document is the operator’s guide. It covers a local try-out and a production install on Ubuntu 24.04 LTS or Debian 12.

## What you are installing

| Piece | Role |
| --- | --- |
| Node.js 22 | Runs the Cinder process |
| PostgreSQL 14 or newer | Stores locked files and metadata |
| Nginx | TLS termination and reverse proxy |
| systemd | Starts Cinder on boot and restarts it if it exits |

The application itself is this directory. Encrypted file contents live in PostgreSQL, so the database disk is the storage you need to size and back up.

Limits, as shipped:

- Any file type
- Any size per file
- 100 files in one seal
- 10 GB combined for everything stored on the service at once, including uploads still in progress
- Password: at least 12 characters, with a number and a special character
- Expiry: up to 30 days, entered as day/month/year in GMT

## Requirements

A small virtual machine is enough for light use. Suggested starting point:

- 2 CPU, 2 GB RAM, 40 GB disk
- A public IPv4 address
- A DNS name pointing at that address (needed for HTTPS)
- Root or sudo access

Cinder listens on localhost only. Do not open port 3000 on the firewall.

## Quick look on your own machine

You can run Cinder without PostgreSQL. In that mode it uses an in-memory database that is wiped when the process stops. That is fine for reading the code and clicking through the interface. It is not fine for real files.

```bash
# Node.js 22 or newer
node -v

cp .env.example .env
# Leave DATABASE_URL commented out, or omit it, for the in-memory database.

npm ci --legacy-peer-deps
npm run dev
```

`npm ci` without `--legacy-peer-deps` fails on this lockfile, because `ajv` is pinned at two major versions. Do not run `npm install`; that rewrites `package-lock.json`.

Open <http://127.0.0.1:3000>. Stop with Ctrl+C.

## Install on Ubuntu or Debian

Unpack the archive on the server and run the installer:

```bash
tar -xzf cinder-source.tar.gz
cd cinder
sudo bash deploy/install.sh
```

The script installs Node.js 22, PostgreSQL, and Nginx, builds the app, and serves it on ports 80 and 443. Node listens only on `127.0.0.1:3000`. That port is the application. PostgreSQL listens only on `127.0.0.1:5432`.

Run the same command again to update Cinder. The database and `/opt/cinder/.env` are kept. The script does not print the database password.

When a DNS name already points at this server and port 80 is reachable from the internet:

```bash
sudo bash deploy/install.sh --domain files.example.com --email you@example.com
```

Let’s Encrypt is tried once. If it cannot issue a certificate, the site still answers on HTTP and on HTTPS with a self-signed certificate. Browsers warn about that certificate until it is trusted. A private IP address cannot get a public certificate.

If `/etc/letsencrypt/live/` already contains a certificate, the installer uses that certificate and the domain name of its directory. `--domain` is not required in that case. When more than one certificate is there, pass `--domain` to choose it. A domain saved from an earlier run is kept when its certificate is still present.

`--prefix /opt/cinder` changes the install directory. The default is `/opt/cinder`.

The installer does not open port 3000. If UFW is already on, it allows OpenSSH and Nginx. If UFW is off, it leaves the firewall alone. It does not delete an existing database.

The steps below are the same install, run by hand.

## Manual production install (Ubuntu 24.04 LTS or Debian 12)

The steps below assume a fresh server. Commands are the same on both distributions unless noted.

Replace `files.example.com` with your hostname throughout.

### 1. Update the system

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y ca-certificates curl gnupg ufw git unzip
```

### 2. Create a dedicated user

Cinder should not run as root.

```bash
sudo adduser --system --group --home /opt/cinder cinder
sudo mkdir -p /opt/cinder
sudo chown cinder:cinder /opt/cinder
```

### 3. Install Node.js 22

The copies of Node in the default Ubuntu and Debian repositories are often too old. The NodeSource repository tracks current releases.

Inspect the setup script if you prefer, then:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource.sh
# Read /tmp/nodesource.sh, then:
sudo bash /tmp/nodesource.sh
sudo apt install -y nodejs
node -v   # should print v22.x
npm -v
```

If NodeSource is not acceptable in your environment, install Node 22 from the official Linux binaries on <https://nodejs.org> and put `node` on the `cinder` user’s `PATH`. The systemd unit below assumes `/usr/bin/node`.

### 4. Install PostgreSQL

```bash
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql
```

Create a database and a role that can use only that database. Pick a long random password and keep it off the shell history if you can (type it in `psql`, or read it from a file).

```bash
sudo -u postgres psql <<'SQL'
CREATE USER cinder WITH PASSWORD 'choose-a-long-password';
CREATE DATABASE cinder OWNER cinder;
REVOKE ALL ON DATABASE cinder FROM PUBLIC;
GRANT ALL ON DATABASE cinder TO cinder;
SQL
```

On PostgreSQL 15 and 16 you may also want:

```bash
sudo -u postgres psql -d cinder -c 'REVOKE ALL ON SCHEMA public FROM PUBLIC;'
sudo -u postgres psql -d cinder -c 'GRANT ALL ON SCHEMA public TO cinder;'
```

Confirm you can log in:

```bash
psql "postgres://cinder:choose-a-long-password@127.0.0.1:5432/cinder" -c 'select 1'
```

### 5. Unpack Cinder

Copy this directory onto the server as `/opt/cinder`. From the machine that holds the archive:

```bash
# on your laptop
scp cinder-source.tar.gz user@files.example.com:/tmp/

# on the server
sudo tar -xzf /tmp/cinder-source.tar.gz -C /opt
sudo chown -R cinder:cinder /opt/cinder
```

If you unpacked to a folder named `cinder` in the current directory, move it:

```bash
sudo mv cinder /opt/cinder
sudo chown -R cinder:cinder /opt/cinder
```

### 6. Configure the environment

```bash
sudo -u cinder cp /opt/cinder/.env.example /opt/cinder/.env
sudo -u cinder chmod 600 /opt/cinder/.env
sudo -u cinder nano /opt/cinder/.env
```

Set at least:

```
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
NITRO_HOST=127.0.0.1
NITRO_PORT=3000
DATABASE_URL=postgres://cinder:choose-a-long-password@127.0.0.1:5432/cinder
```

`HOST=127.0.0.1` keeps the Node process off the public interface. Set `NITRO_HOST` to the same address. Nitro reads both. Nginx will be the only listener on 80 and 443. Port 3000 is the application, not PostgreSQL.

### 7. Build

```bash
cd /opt/cinder
sudo -u cinder env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --legacy-peer-deps
sudo -u cinder -E bash -lc 'set -a; . /opt/cinder/.env; set +a; npm run build'
```

Use `--legacy-peer-deps`, as in the local try-out. Do not run `npm install`. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` skips a browser download the server does not need.

`npm run build` compiles the site and applies the SQL migrations in `migrations/` to `DATABASE_URL`. It is safe to run again; already-applied files are skipped.

If the build prints that `DATABASE_URL` is not set, the environment file was not loaded. Stop and fix that before continuing. An in-memory database in production would lose every file on restart.

After a successful build you should have `/opt/cinder/.output/server/index.mjs`.

### 8. systemd

```bash
sudo cp /opt/cinder/deploy/cinder.service /etc/systemd/system/cinder.service
sudo systemctl daemon-reload
sudo systemctl enable --now cinder
sudo systemctl status cinder
```

Useful checks:

```bash
curl -I http://127.0.0.1:3000/
journalctl -u cinder -e
```

You want HTTP 200 from the curl, and no stack traces in the journal.

### 9. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

Do not allow port 3000. PostgreSQL should listen on localhost only (the default).

### 10. Nginx and TLS

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo mkdir -p /var/www/certbot
```

Copy the example site and put your hostname in it:

```bash
sudo cp /opt/cinder/deploy/nginx.conf /etc/nginx/sites-available/cinder
sudo nano /etc/nginx/sites-available/cinder   # replace files.example.com
sudo ln -sf /etc/nginx/sites-available/cinder /etc/nginx/sites-enabled/cinder
sudo rm -f /etc/nginx/sites-enabled/default
```

The example file expects certificates that do not exist yet. For the first certificate, temporarily serve HTTP only, or use certbot’s nginx plugin and let it write the SSL server block.

A reliable first-certificate sequence:

1. In `/etc/nginx/sites-available/cinder`, keep only the `listen 80` server, with `location /` proxying to `http://127.0.0.1:3000` (no redirect yet).
2. `sudo nginx -t && sudo systemctl reload nginx`
3. `sudo certbot --nginx -d files.example.com`
4. Confirm that certbot added a 443 server and a redirect from 80.

`client_max_body_size` must stay at least `8m`. Uploads are split into pieces of about 4 MB; a 1 MB default in Nginx will break them.

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Visit `https://files.example.com`. The browser should show Cinder, with a valid padlock.

## Day-to-day operation

### Stop the site

```bash
sudo systemctl stop cinder
```

The Node process exits. Nginx keeps listening on ports 80 and 443, and visitors see a gateway error until Cinder is started again. To close those ports as well:

```bash
sudo systemctl stop nginx
```

Bring Cinder back:

```bash
sudo systemctl start cinder
```

If Nginx was stopped:

```bash
sudo systemctl start nginx
```

### Purge every stored file

Stop Cinder first. The purge rewrites the table files, and it refuses to start while Cinder, or any other database client, is still connected.

```bash
sudo systemctl stop cinder
sudo -u cinder bash -lc 'set -a; . /opt/cinder/.env; set +a; cd /opt/cinder && node scripts/purge.mjs --yes'
sudo systemctl start cinder
```

The script requires `--yes`. It overwrites each secret column with zeros, deletes the row, then runs `VACUUM FULL` on `sealed_file_chunks`, `sealed_files`, `sealed_batches`, and `upload_chunks`. `VACUUM FULL` builds a new table file that contains only the rows still present and drops the old file.

The same overwrite, delete, and rewrite runs while the service is up, for a seal whose expiry has passed, a seal that has used its downloads, and an upload left unfinished for more than two hours. Up to 50 seals are cleared on one pass. The rewrite takes an exclusive lock on those tables, so other uploads and downloads wait until it finishes.

Copies can remain in three places after either kind of delete:

- A `pg_dump` taken earlier. Delete those dumps when the purge has to be final.
- The write-ahead log, until PostgreSQL recycles those segments.
- Disk blocks the operating system has not reused yet. Full-disk encryption (LUKS), noted under Security notes, protects those blocks.

When `DATABASE_URL` is unset, files live only in the Cinder process. Stop the process (`sudo systemctl stop cinder`, or Ctrl+C on `npm run dev`) and they are gone. The purge script exits with an error in that case, because there is no PostgreSQL database to rewrite.

### Logs

```bash
journalctl -u cinder -f
sudo tail -f /var/log/nginx/cinder.error.log
```

### Restart after a config change

```bash
sudo systemctl restart cinder
```

### Update Cinder

Unpack the new archive and run the installer again. It keeps `/opt/cinder/.env` and the database.

```bash
sudo bash deploy/install.sh
```

To build by hand instead, from a tree already at `/opt/cinder`:

```bash
cd /opt/cinder
sudo chown -R cinder:cinder /opt/cinder
sudo -u cinder env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --legacy-peer-deps
sudo -u cinder -E bash -lc 'set -a; . /opt/cinder/.env; set +a; npm run build'
sudo systemctl restart cinder
```

Migrations run as part of `npm run build`. Do not skip that step.

### Backups

Encrypted files sit in PostgreSQL. A database dump is enough to restore the service. The dump still contains ciphertext; it is not readable without the passwords chosen by senders, but it is still sensitive. Store dumps the way you would store any confidential backup.

```bash
sudo -u postgres pg_dump -Fc cinder > /var/backups/cinder-$(date +%F).dump
```

Restore:

```bash
sudo -u postgres pg_restore --clean --if-exists -d cinder /var/backups/cinder-YYYY-MM-DD.dump
```

A dump taken before a seal is cleared still holds that ciphertext. Keep backup retention inside the deletion window you want. Clearing itself is described under "Purge every stored file".

### Disk

Plan database disk for the ciphertext. New seals are stored as encrypted chunks (`bytea`), one slice per row, so a download never loads a whole file into memory. Names and types are fixed-size ciphertext, so their length is hidden. The service refuses a new upload when everything already stored, combined, would pass 10 GB. Monitor `pg_database_size('cinder')`.

## Security notes

- Use HTTPS. The password never travels to the server. Download tickets do. File names and types do not: they are locked before upload.
- What stays readable in the database is operational: expiry, download counters, salts, per-chunk initialization vectors, and the byte length of each locked slice. That length is required to store and serve the slice. It is a close stand-in for the original size.
- Keep `DATABASE_URL` in `/opt/cinder/.env` with mode `600` and owner `cinder`.
- Do not put Cinder behind a cache that stores POST bodies or `/api/open` responses.
- There are no operator accounts and no way to recover a forgotten password. If a sender loses the password, the files cannot be opened.
- The in-memory database is only for local trials. Production must set `DATABASE_URL`.
- Full-disk encryption on the server (LUKS) is worth turning on if the host is a VPS you do not physically control.

## Troubleshooting

**The installer stopped.**  
Run `sudo bash deploy/install.sh` again. It keeps the database. The build log is `/var/log/cinder-build.log`.

**`npm run build` skips migrations.**  
`DATABASE_URL` was empty in that shell. Load `.env` as shown in step 7.

**`cinder.service` fails with `Cannot find module`.**  
The build did not produce `.output/server/index.mjs`. Run the build again as the `cinder` user from `/opt/cinder`.

**Nginx `413 Request Entity Too Large`.**  
Raise `client_max_body_size` in the site file (8m or more) and reload Nginx.

**502 Bad Gateway.**  
Cinder is not listening. `systemctl status cinder` and `journalctl -u cinder -e`. Confirm `HOST` and `PORT` match the upstream in Nginx (`127.0.0.1:3000`).

**Blank page, assets 404.**  
The process is running from the wrong working directory. The systemd unit sets `WorkingDirectory=/opt/cinder`. Do not start it by hand from another path.

**Files vanish after a reboot.**  
PostgreSQL is not in use. Set `DATABASE_URL` and rebuild.

**Cannot connect to Postgres.**  
Check `pg_hba.conf` allows `127.0.0.1` with a password, and that the role owns the database. `journalctl -u postgresql -e`.

## Layout

```
.
├── README.md
├── package.json
├── vite.config.ts
├── .env.example
├── deploy/
│   ├── install.sh        # Debian and Ubuntu installer
│   ├── cinder.service    # systemd unit
│   └── nginx.conf        # reverse proxy example
├── migrations/           # PostgreSQL schema
├── public/               # favicon and share image
├── scripts/              # database migrator
└── src/                  # application
```

## Licence

Use and modify this copy for your own service. You are responsible for how you run it and for the files people send through it.
