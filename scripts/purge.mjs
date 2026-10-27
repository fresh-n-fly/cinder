#!/usr/bin/env node
/**
 * Overwrite every stored secret with zeros, delete the rows, then VACUUM FULL.
 *
 * Stop Cinder before running this. VACUUM FULL takes an exclusive lock and
 * rewrites each table file. The script refuses to start while another client
 * is connected, and it refuses to run without --yes.
 *
 * With no DATABASE_URL, Cinder is using the in-memory database. Stopping the
 * process drops those files. This script exits with an error in that case.
 */
import pg from "pg";
import { SECRET_TABLES, wipeEverything } from "./wipe.mjs";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error(
    "[purge] DATABASE_URL is not set. Files in the in-memory database live only in the Cinder process. Stop that process and they are gone.",
  );
  process.exit(1);
}

if (!process.argv.includes("--yes")) {
  console.error("[purge] Refusing to wipe the database without --yes.");
  console.error("[purge] Stop Cinder, then run: node scripts/purge.mjs --yes");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });

async function main() {
  const client = await pool.connect();
  try {
    const others = await client.query(
      `select usename, coalesce(nullif(application_name, ''), '-') as application_name, state
       from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and backend_type = 'client backend'`,
    );
    if (others.rows.length > 0) {
      console.error("[purge] Other clients are connected. Stop Cinder, then run this again.");
      console.error("[purge]   sudo systemctl stop cinder");
      for (const row of others.rows) {
        console.error(
          `[purge]   session user=${row.usename} app=${row.application_name} state=${row.state}`,
        );
      }
      return 3;
    }

    console.log("[purge] Overwriting secrets, then deleting rows.");
    const counts = await wipeEverything(async (text, params = []) => {
      const result = await client.query(text, params);
      return result.rows;
    }, (done, total) => {
      if (done === total || done % 100 === 0) {
        console.log(`[purge] chunks ${done}/${total}`);
      }
    });
    console.log(
      `[purge] removed ${counts.chunks} chunk(s), ${counts.files} file(s), ${counts.batches} seal(s), ${counts.uploads} upload chunk(s).`,
    );

    for (const table of SECRET_TABLES) {
      await client.query(`VACUUM FULL ${table}`);
      console.log(`[purge] VACUUM FULL ${table}`);
    }
    console.log(
      "[purge] Live table files no longer contain those rows. A backup, the write-ahead log, and freed disk blocks can still hold copies. Delete old dumps if this purge has to be final. Full-disk encryption protects freed blocks.",
    );
    return 0;
  } finally {
    client.release();
    await pool.end();
  }
}

main()
  .then((code) => {
    process.exit(code ?? 0);
  })
  .catch((err) => {
    console.error("[purge] failed:", err?.message || err);
    for (const key of ["code", "detail", "hint", "position"]) {
      if (err?.[key] != null) console.error(`[purge]   ${key}: ${err[key]}`);
    }
    process.exit(1);
  });
