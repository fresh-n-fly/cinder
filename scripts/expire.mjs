#!/usr/bin/env node
/**
 * Delete seals that are past their expiry or download limit, and uploads
 * abandoned for more than two hours. Safe to run while Cinder is up.
 * A used-up seal is kept until its 15-minute download ticket has ended.
 *
 * With no DATABASE_URL, files live only in the Cinder process. This script
 * exits with an error in that case.
 */
import pg from "pg";
import { SECRET_TABLES, wipeDue } from "./wipe.mjs";

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
  let inTransaction = false;
  try {
    await client.query("begin");
    inTransaction = true;
    await client.query("lock table upload_chunks in share row exclusive mode");
    const due = await wipeDue(async (text, params = []) => {
      const result = await client.query(text, params);
      return result.rows;
    });
    await client.query("commit");
    inTransaction = false;
    const tables = [];
    if (due.uploads > 0 || due.uploadVacuum > 0) tables.push("upload_chunks", "upload_sessions");
    if (due.batches > 0 || due.legacy > 0) {
      tables.push("sealed_file_chunks", "sealed_files", "sealed_batches");
    }
    for (const table of tables) {
      if (!SECRET_TABLES.includes(table)) continue;
      await client.query(`VACUUM FULL ${table}`);
    }
    if (due.sessions > 0 && due.uploadVacuum === 0 && due.uploads === 0) {
      await client.query("VACUUM upload_sessions");
    }
    const removed = due.batches + due.legacy + due.uploads + due.sessions;
    if (removed > 0) {
      console.log(
        `[expire] removed ${due.batches} expired or used-up seal(s), ${due.legacy} legacy file(s), ${due.uploads} abandoned upload chunk(s), and ${due.sessions} upload session(s).`,
      );
    }
    return 0;
  } catch (err) {
    if (inTransaction) await client.query("rollback").catch(() => undefined);
    throw err;
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
