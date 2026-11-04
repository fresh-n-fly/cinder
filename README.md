# Cinder

Cinder is a private file drop. A visitor locks files with a password in their browser and gets a link to send. The files are deleted at the expiry date, or once they have been downloaded the allowed number of times.

Files, file names, and file types are encrypted in the browser; the password never leaves it. The server stores ciphertext, a proof hash for checking the password, and the metadata it needs to delete things on time.

This is the operator's guide: a local try-out, the installer, a manual install, and day-to-day operation.

## Security and privacy

- **Keys stay in the browser.** The password and a random salt go through Argon2id (64 MiB, 3 passes); HKDF-SHA-256 splits the result into an AES-256-GCM key and a proof under separate labels, so the proof never reveals the key whatever salt the server supplies. The cost settings are fixed in the page. Each 4 MB piece is encrypted before upload. The server keeps only SHA-256 of the proof and compares it in constant time. Seals made with the older PBKDF2 scheme still open until 15 December 2026; for those the page sends only a hash of the proof.
- **Names and types are encrypted too**, padded to 1,024 and 128 bytes so their length is hidden. Each piece is bound to its position and its file's piece count, and each file to its place and the file count, so pieces or files cannot be swapped, dropped, or cut off without decryption failing.
- **Before the password is accepted** the page learns only the key-derivation version and salt, the expiry, the download counters, whether the seal is locked, and how many files it holds.
- **Use is limited.** Seal addresses are 32 random hex characters. Expiry is 15 minutes to 30 days; downloads 1 to 100. For each seal, one connection (an IPv4 address or IPv6 /64) may enter a wrong password 5 times, and 30 wrong passwords in total lock it. A correct password returns a 15-minute download ticket, stored only as a hash, good for about two passes over the seal.
- **Passwords.** The page starts with a generated 16-character password. A typed one must be at least 12 characters and must not look like a common pattern (a word plus a year or symbol, a keyboard run, repeated characters). There are no operator accounts and no recovery.
- **Deletion.** About once a minute a job deletes seals that have expired or used up their downloads (after their last ticket ends) and abandoned uploads. Deleted rows stay in PostgreSQL's files until the space is reused; a daily job rewrites the tables to drop them. Backups, the write-ahead log, and freed disk blocks can still hold ciphertext afterwards, so use full-disk encryption.
- **What a database copy shows:** expiry and download counts, salts, proof hashes, per-piece IVs, the size of each encrypted piece (close to the file size), and keyed hashes of client networks (an HMAC under `CINDER_CLIENT_KEY_SECRET`, never the address).
- **The host.** Node and PostgreSQL listen on `127.0.0.1` only; Nginx serves 80 and 443. The app tree and `/opt/cinder/.env` are owned by root, so the app cannot change its own code or environment.

## Limits

| | |
| --- | --- |
| One seal | 100 files, 8 GB |
| One connection (IPv4 address or IPv6 /64) | about 8 GB stored at once |
| Whole service | 32 GB stored at once, including uploads in progress |
| Upload | must finish within 12 hours |
| Expiry | 15 minutes to 30 days, entered as day/month/year in GMT |

The values are in `src/lib/constants.ts`.

## Requirements

- Ubuntu 24.04, Debian 12, or Kali Rolling, with root or sudo; PostgreSQL 14 or newer
- 2 CPU, 2 GB RAM, and about 100 GB of disk (32 GB of seals, a temporary second copy while a seal finishes, and room for the daily table rewrite)
- For a public certificate: a DNS name pointing at the server, with port 80 reachable from the internet

## Try it locally

Without `DATABASE_URL`, Cinder uses an in-memory database that is lost when the process stops. Fine for trying it out, not for real files.

```bash
node -v                      # 22 or newer
npm ci --legacy-peer-deps    # the lockfile needs this flag; do not run npm install
npm run dev                  # http://127.0.0.1:3000
```

`npm run dev` listens on every interface, so other machines on your network can reach it.

## Install with the installer

```bash
tar -xzf cinder-source.tar.gz && cd cinder
sudo bash deploy/install.sh
```

It installs Node.js 22, PostgreSQL, Nginx, and Fail2ban, builds Cinder, sets up the systemd units and timers, and serves HTTPS on 443 with port 80 redirecting. It never prints the database password. Run it again to update; the database and `/opt/cinder/.env` are kept.

| Option | Effect |
| --- | --- |
| `--domain NAME --email ADDR` | Request a Let's Encrypt certificate. If that fails, HTTPS uses a self-signed certificate. An existing certificate in `/etc/letsencrypt/live/` is used automatically; with more than one there, pass `--domain` to choose. The domain is remembered. |
| `--bind ADDR` | Serve Cinder only on this IPv4 address; other Nginx sites keep every other address. Remembered for later runs; `--bind any` undoes it. |
| `--prefix DIR` | Install directory (default `/opt/cinder`). |

If UFW is on, the installer allows OpenSSH and Nginx; otherwise it leaves the firewall alone. Port 3000 is never opened. It disables Nginx's stock `default` site.

The generated Nginx site allows 10 unlock attempts per minute per IP, 40 requests at once per address, and bodies over 64 KB only on `/api/seal`, and refuses paths containing a percent-escape or backslash. The `cinder-unlock` Fail2ban jail bans an address for 30 minutes after 10 wrong passwords in 10 minutes.

### Internal hosts (no public certificate)

```bash
sudo bash deploy/install.sh --bind 192.168.1.10
```

- HTTPS uses a self-signed certificate (`/etc/nginx/ssl/cinder.crt`). The installer prints its SHA-256 fingerprint for users to check against the browser warning; installing it as trusted removes the warning. While it is untrusted, browsers may refuse Cinder's download helper, and downloads go through temporary browser storage that is cleared on the next visit.
- If other Nginx sites exist, `/etc/nginx` is first saved to `/var/backups/cinder/nginx-<time>.tgz`.
- The unlock jail exempts only loopback and the host's own addresses, so repeated wrong passwords from the LAN are banned. (On public installs private ranges are exempt.)
- If Fail2ban was not running before, starting it also enables the distribution's `sshd` jail (5 failures, 10-minute ban, nobody exempt). The installer warns; exempt VPN or management ranges with an `ignoreip` line in `/etc/fail2ban/jail.d/sshd-ignore.local`.

Do not use `--bind` with a private address on a cloud VM behind a load balancer: every visitor would appear as the balancer, and one guesser could get it banned.

### Remove Cinder

```bash
sudo bash deploy/purge.sh --yes          # delete stored files first (or: sudo -u postgres dropdb cinder)
sudo rm /etc/nginx/sites-enabled/cinder && sudo systemctl reload nginx   # conf.d hosts: /etc/nginx/conf.d/cinder.conf
sudo systemctl disable --now cinder cinder-expire.timer cinder-compact.timer
```

## Manual install

`deploy/install.sh` is the reference; these are the same steps by hand on Ubuntu or Debian. Replace `files.example.com` with your hostname.

1. **Packages and user**

   ```bash
   sudo apt update && sudo apt install -y ca-certificates curl postgresql nginx fail2ban python3-systemd certbot python3-certbot-nginx ufw
   sudo adduser --system --group --home /opt/cinder cinder
   ```

2. **Node.js 22** at `/usr/bin/node` (the units expect that path), for example from NodeSource: download `https://deb.nodesource.com/setup_22.x`, read it, run it with `sudo bash`, then `sudo apt install -y nodejs`.

3. **Database**

   ```bash
   sudo -u postgres psql <<'SQL'
   CREATE USER cinder WITH PASSWORD 'choose-a-long-password';
   CREATE DATABASE cinder OWNER cinder TEMPLATE template0;
   REVOKE ALL ON DATABASE cinder FROM PUBLIC;
   SQL
   sudo -u postgres psql -d cinder -c 'REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT ALL ON SCHEMA public TO cinder;'
   ```

4. **Code and environment.** Unpack to `/opt/cinder`. Create the environment file with safe permissions before putting the password in it (`sudo install -m 640 -o root -g cinder /dev/null /opt/cinder/.env`), then fill it in:

   ```
   NODE_ENV=production
   HOST=127.0.0.1
   PORT=3000
   NITRO_HOST=127.0.0.1
   NITRO_PORT=3000
   DATABASE_URL=postgres://cinder:choose-a-long-password@127.0.0.1:5432/cinder
   CINDER_CLIENT_KEY_SECRET=<output of: openssl rand -hex 32>
   ```

5. **Build** (this also applies the migrations), then give the tree back to root:

   ```bash
   cd /opt/cinder && sudo chown -R cinder:cinder /opt/cinder
   sudo -u cinder env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --legacy-peer-deps
   sudo -u cinder bash -c 'set -a; . /opt/cinder/.env; set +a; npm run build'
   sudo chown -R root:root /opt/cinder && sudo chmod -R go-w /opt/cinder
   sudo chown root:cinder /opt/cinder/.env && sudo chmod 640 /opt/cinder/.env
   ```

   If the build says `DATABASE_URL` is not set, the environment was not loaded; fix that before going on.

6. **Services.** The expiry timer is what deletes seals; do not skip it.

   ```bash
   sudo cp deploy/cinder.service deploy/cinder-expire.* deploy/cinder-compact.* /etc/systemd/system/
   sudo cp deploy/fail2ban/cinder-unlock.conf /etc/fail2ban/filter.d/
   sudo cp deploy/fail2ban/cinder.local /etc/fail2ban/jail.d/
   sudo systemctl daemon-reload
   sudo systemctl enable --now cinder cinder-expire.timer cinder-compact.timer fail2ban
   sudo systemctl restart fail2ban && sudo fail2ban-client status cinder-unlock
   curl -I http://127.0.0.1:3000/    # expect 200
   ```

7. **Nginx and TLS.** Get the certificate first (`sudo certbot certonly --nginx -d files.example.com`; this leaves the site files alone). Then copy `deploy/nginx.conf` to `/etc/nginx/sites-available/cinder`, replace `files.example.com`, link it into `sites-enabled`, remove `sites-enabled/default`, and run `sudo nginx -t && sudo systemctl reload nginx`. Keep `client_max_body_size 8m` in the `/api/seal` location; uploads arrive in 4 MB pieces.

8. **Firewall:** allow OpenSSH and Nginx (`sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable`). Never open port 3000.

To update a manual install, unpack the new version over `/opt/cinder` and repeat step 5, then `sudo systemctl restart cinder`.

## Operation

| Task | Command |
| --- | --- |
| Stop / start | `sudo systemctl stop cinder` / `sudo systemctl start cinder` (Nginx keeps serving a gateway error) |
| Logs | `journalctl -u cinder -f`; expiry and compaction: `journalctl -u cinder-expire.service`, `journalctl -u cinder-compact.service`; Nginx: `/var/log/nginx/cinder.error.log` |
| Check that due rows are gone | `sudo bash deploy/verify.sh` |
| Delete everything | `sudo bash deploy/purge.sh --yes` |
| Run expiry now | `sudo systemctl start cinder-expire.service` |
| Rewrite tables now | `sudo systemctl start cinder-compact.service` |
| See or clear Fail2ban bans | `sudo bash deploy/fail2ban-status.sh`, `sudo bash deploy/fail2ban-flush.sh --yes` |
| Update | unpack the new version and run `sudo bash deploy/install.sh` |

With a non-default install directory, pass the same `--prefix DIR` to `verify.sh` and `purge.sh`.

**Expiry** runs every minute. It deletes each due seal (expired, or downloads used up and last ticket ended) in a single transaction, deletes abandoned uploads, then runs plain `VACUUM` so the space can be reused. Both steps take time in proportion to the data deleted, because PostgreSQL rewrites every page it removes rows from; each run logs how long they took. Rows that are busy are skipped until the next run.

**Compaction** runs daily between 04:15 and 04:45 UTC (or at boot if a run was missed). `VACUUM FULL` rewrites each table so deleted rows leave its files; it needs free space about the size of the table, and it blocks reads of that table while it runs. A table whose lock is not free within 5 seconds is skipped.

**`verify.sh`** lists what is stored, then anything that should already be gone. Exit 0 means the live tables hold nothing due for deletion. Locked seals and seals with a live download ticket are meant to remain.

**`purge.sh --yes`** stops Cinder and its timers, empties every Cinder table with `TRUNCATE` (which replaces their files), and starts everything again. It refuses to run while any other client is connected to the database.

**Backups.** `sudo -u postgres pg_dump -Fc cinder | sudo tee /var/backups/cinder-$(date +%F).dump >/dev/null` is enough to restore (`sudo -u postgres pg_restore --clean --if-exists -d cinder <file>`). Dumps contain ciphertext and keep it after a seal is deleted, so keep their retention within your deletion window.

**Disk.** Monitor `pg_database_size('cinder')`. Uploads are refused once the stored total would pass 32 GB.

## Security notes

- Keep `DATABASE_URL` and `CINDER_CLIENT_KEY_SECRET` in `/opt/cinder/.env` (`root:cinder`, mode `640`) and the rest of `/opt/cinder` owned by root. Anyone holding the secret can test whether an address made an upload or a wrong-password attempt that is still stored.
- The app log records the address of each counted wrong password for Fail2ban. The Nginx access log records client addresses with seal paths (`/f/<id>`). Set journald `MaxRetentionSec=` and logrotate retention to how long you want addresses kept.
- Do not put Cinder behind a cache that stores POST bodies or `/api/open` responses.
- Full-disk encryption (LUKS) covers ciphertext left in freed blocks, the write-ahead log, and anything else outside the live tables.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Installer stopped | Run it again; it keeps the database. Build log: `/var/log/cinder-build.log`. |
| Build skips migrations | `DATABASE_URL` was not loaded; source `.env` as in step 5. |
| `Cannot find module` on start | The build did not produce `.output/server/index.mjs`; rebuild as `cinder` in `/opt/cinder`. |
| Nginx 413 | `client_max_body_size` must be at least `8m` for `/api/seal`. |
| 502 Bad Gateway | Cinder is not running (`systemctl status cinder`, `journalctl -u cinder -e`), or `HOST`/`PORT` in `.env` do not match the Nginx upstream `127.0.0.1:3000`. |
| Blank page, assets 404 | Cinder was started from the wrong directory; run it through the unit, which sets `WorkingDirectory=/opt/cinder`. |
| Files gone after a reboot | `DATABASE_URL` is unset, so the in-memory database was used. |
| Cannot connect to PostgreSQL | Check `pg_hba.conf` allows `127.0.0.1` with a password; `journalctl -u postgresql -e`. |

## Layout

```
deploy/        installer, verify, purge, Fail2ban helpers, systemd units, Nginx example
migrations/    PostgreSQL schema
public/        static files and the download service worker
scripts/       migrations, expiry, compaction, purge
src/           application
```

## Licence

Use and modify this copy for your own service. You are responsible for how you run it and for the files people send through it.
