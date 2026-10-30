#!/usr/bin/env node
/**
 * Delete seals that are past their expiry or download limit, uploads that
 * were abandoned or outlived their lifetime, and expired download tickets.
 * Safe to run while Cinder is up. A used-up seal is kept until its last
 * download ticket has ended.
 *
 * This job runs every minute and only uses plain VACUUM, which marks the
 * deleted rows reusable without an exclusive lock. Rewriting the table files
 * (VACUUM FULL) is done by scripts/compact.mjs on its own daily schedule, so
 * nothing a visitor does can force a rewrite.
 *
 * With no DATABASE_URL, files live only in the Cinder process. This script
 * exits with an error in that case.
 */
import pg from "pg";
import { SECRET_TABLES, expireDue } from "./wipe.mjs";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error(
    "[expire] DATABASE_URL is not set. Files in the in-memory database live only in the Cinder process. Stop that process and they are gone.",
  );
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });

async function main() {
  const client = await pool.connect();
  /** @type {import("./wipe.mjs").Query} */
  const query = async (text, params = []) => (await client.query(text, params)).rows;
  try {
    // Wait at most a few seconds for any one row; a busy row is retried on
    // the next run instead of holding this job up.
    await client.query("set lock_timeout = '5s'");
    const due = await expireDue({
      query,
      transaction: async (run) => {
        await client.query("begin");
        try {
          const result = await run(query);
          await client.query("commit");
          return result;
        } catch (err) {
          await client.query("rollback").catch(() => undefined);
          throw err;
        }
      },
    });
    const tables = [];
    if (due.uploads > 0 || due.sessions > 0) tables.push("upload_chunks", "upload_sessions");
    if (due.batches > 0 || due.legacy > 0) {
      tables.push("sealed_file_chunks", "sealed_files", "sealed_batches", "unlock_attempts");
    }
    if (due.grants > 0) tables.push("batch_grants");
    for (const table of new Set(tables)) {
      if (!SECRET_TABLES.includes(table)) continue;
      await client.query(`VACUUM ${table}`);
    }
    const removed = due.batches + due.legacy + due.uploads + due.sessions + due.grants;
    if (due.skipped > 0) {
      console.log(`[expire] skipped ${due.skipped} busy item(s); they are retried on the next run.`);
    }
    if (removed > 0) {
      console.log(
        `[expire] removed ${due.batches} expired or used-up seal(s), ${due.legacy} legacy file(s), ${due.uploads} abandoned upload chunk(s), ${due.sessions} upload session(s), and ${due.grants} expired ticket(s).`,
      );
    }
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
    console.error("[expire] failed:", err?.message || err);
    process.exit(1);
  });
