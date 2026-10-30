#!/usr/bin/env node
/**
 * Rewrite Cinder's table files so deleted rows no longer exist on disk.
 *
 * The expiry job zero-fills and deletes rows every minute, then runs plain
 * VACUUM. That frees the space for reuse, but the old row versions can stay in
 * the table file until the space is reused. VACUUM FULL writes a new file
 * that holds only live rows and drops the old one.
 *
 * VACUUM FULL holds an exclusive lock for as long as it runs, so it is kept
 * off the request path and the minutely timer: cinder-compact.timer runs this
 * once a day. Each table waits at most a few seconds for its lock; a table
 * that is busy is skipped and picked up on the next run.
 */
import pg from "pg";
import { SECRET_TABLES } from "./wipe.mjs";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("[compact] DATABASE_URL is not set. There is no PostgreSQL database to compact.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });

async function main() {
  const client = await pool.connect();
  let failed = 0;
  try {
    await client.query("set lock_timeout = '5s'");
    for (const table of SECRET_TABLES) {
      const started = Date.now();
      try {
        await client.query(`VACUUM FULL ${table}`);
        console.log(`[compact] VACUUM FULL ${table} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      } catch (err) {
        failed += 1;
        console.error(`[compact] skipped ${table}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return failed === 0 ? 0 : 75;
  } finally {
    client.release();
    await pool.end();
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error("[compact] failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
