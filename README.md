# Cinder

Cinder is a private file drop. A visitor locks one or more files with a password in their browser, then gets a link to send. The files are deleted when the expiry date is reached, or after they have been downloaded the allowed number of times.

File bytes, file names, and file types are locked in the browser. The password never leaves the sender’s (or recipient’s) browser. The server keeps the locked bytes, fixed-size locked copies of the names and types, and a check value used to confirm the password. Expiry, download limits, and the size of each locked piece stay visible to the operator so files can be deleted on time.

This document is the operator’s guide. It covers a local try-out and a production install on Ubuntu 24.04 LTS or Debian 12.

## Security + Privacy

Cinder locks the files in the browser and keeps the server from learning the password, the file names, or the file types.

**The password never leaves the browser.** The sender’s password is stretched with PBKDF2-SHA-256, 210,000 times, into an AES-256-GCM key. That key encrypts each 4 MB piece of each file before upload. A second salt produces a proof the server can check. The server stores a SHA-256 of that proof and compares it with a constant-time check. A correct proof returns the encryption salt and a 15-minute download ticket. The password itself is not sent, stored, or recoverable. There is no operator account and no password reset. The minimum is 12 characters, including a number and a symbol.

**Names and types are locked too.** Each file name is padded to 1,024 bytes and each type to 128 bytes before encryption, so the stored length does not reveal how long the original was. Before the password is accepted, the page is told only the proof salt, the expiry, the download counters, whether the seal is locked, and how many files it holds. After a correct password, the browser decrypts the names and the file pieces. Each piece is bound to its position, so one piece cannot be swapped for another.

**The link is unguessable, and use is limited.** A seal address is 32 random hex characters. The sender chooses an expiry, from 15 minutes up to 30 days, and a download count from 1 to 100. Twelve wrong passwords lock the seal until that expiry. When the expiry passes, or the downloads are used up and the 15-minute ticket has ended, a job running about once a minute overwrites the secret columns, deletes the rows, and rewrites those table files. The same wipe is available by hand with `deploy/purge.sh --yes`.

**The host is kept small.** The installer puts PostgreSQL and the Node app on `127.0.0.1` only. Nginx is the service on ports 80 and 443; port 80 redirects to HTTPS, using an existing Let’s Encrypt certificate or a self-signed certificate. The database password is a new 48-character random value, written to `/opt/cinder/.env` mode `600`, and the install script does not print it. Download tickets are sent in the request body, and those responses are marked not to be cached.

**What a database copy still shows.** Expiry, download counts, salts, the proof hash, the per-piece initialization vectors, and the byte length of each locked piece. That length is close to the original file size. A backup, the write-ahead log, and freed disk blocks can still hold ciphertext after a row is gone. Full-disk encryption is what covers those leftover blocks.

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

The script installs Node.js 22, PostgreSQL, Nginx, and Fail2ban, builds the app, and serves it on HTTPS port 443 while port 80 redirects to HTTPS. Node listens only on `127.0.0.1:3000`. That port is the application. PostgreSQL listens only on `127.0.0.1:5432`.

Run the same command again to update Cinder. The database and `/opt/cinder/.env` are kept. The script does not print the database password.

When a DNS name already points at this server and port 80 is reachable from the internet:

```bash
sudo bash deploy/install.sh --domain files.example.com --email you@example.com
```

Let’s Encrypt is tried once. If it cannot issue a certificate, HTTP still redirects to HTTPS with a self-signed certificate. Browsers warn about that certificate until it is trusted. A private IP address cannot get a public certificate.

If `/etc/letsencrypt/live/` already contains a certificate, the installer uses that certificate and the domain name of its directory. `--domain` is not required in that case. When more than one certificate is there, pass `--domain` to choose it. A domain saved from an earlier run is kept when its certificate is still present.

`--prefix /opt/cinder` changes the install directory. The default is `/opt/cinder`.

The installer does not open port 3000. If UFW is already on, it allows OpenSSH and Nginx. If UFW is off, it leaves the firewall alone. It does not delete an existing database.

The generated Nginx site rate-limits only JSON unlock attempts on `/api/open` to 10 requests per minute per IP with a short burst allowance. Multipart chunk downloads are not counted by that limit. The installer also enables a `cinder-unlock` Fail2ban jail that bans an IP for 30 minutes after 10 logged wrong-password attempts in 10 minutes.

To see or clear those bans:

```bash
sudo bash deploy/fail2ban-status.sh
sudo bash deploy/fail2ban-flush.sh --yes
```

The steps below are the same install, run by hand.

## Manual production install (Ubuntu 24.04 LTS or Debian 12)

The steps below assume a fresh server. Commands are the same on both distributions unless noted.

Replace `files.example.com` with your hostname throughout.

### 1. Update the system

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y ca-certificates curl gnupg ufw git unzip fail2ban python3-systemd
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

### Check that expired files are gone

```bash
sudo bash deploy/verify.sh
```

The script reads the database password from `/opt/cinder/.env` and does not print it. It lists what is still stored, then lists seals past their expiry, used-up seals whose download ticket has ended, uploads abandoned for more than two hours, and chunks left without a file. Exit 0 means those are gone from the live tables. A seal locked by wrong passwords, or one whose 15-minute download ticket is still valid, is supposed to remain.

### Purge every stored file

Stop Cinder first. The purge rewrites the table files, and it refuses to start while Cinder, or any other database client, is still connected.

```bash
sudo bash deploy/purge.sh --yes
```

That stops Cinder, runs the wipe, and starts Cinder again. Without `--yes` it refuses and leaves the service running.

The script requires `--yes`. It overwrites each secret column with zeros, deletes the row, then runs `VACUUM FULL` on `sealed_file_chunks`, `sealed_files`, `sealed_batches`, and `upload_chunks`. `VACUUM FULL` builds a new table file that contains only the rows still present and drops the old file.

Expired seals, seals that have used their downloads, and uploads left unfinished for more than two hours are cleared on a timer, about once a minute, whether or not anyone opens the site. A used-up seal stays until its 15-minute download ticket has ended. Each pass clears every due row, then rewrites the table files that changed. That rewrite takes an exclusive lock, so uploads and downloads wait until it finishes. The installer enables `cinder-expire.timer`. Run it once by hand with `sudo systemctl start cinder-expire.service`.

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
│   ├── verify.sh         # check that expired rows are gone
│   ├── purge.sh          # overwrite and delete every stored file
│   ├── cinder.service    # systemd unit for the site
│   ├── cinder-expire.service
│   ├── cinder-expire.timer  # deletes expired seals every minute
│   └── nginx.conf        # reverse proxy example
├── migrations/           # PostgreSQL schema
├── public/               # favicon and share image
├── scripts/              # database migrator and expiry job
└── src/                  # application
```

## Licence

Use and modify this copy for your own service. You are responsible for how you run it and for the files people send through it.
