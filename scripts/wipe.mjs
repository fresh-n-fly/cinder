/**
 * Deleting stored seals and uploads.
 *
 * Rows are deleted, one statement per table for each seal or upload. They are
 * not overwritten first: PostgreSQL writes an UPDATE as a new row version and
 * leaves the old one in place, so zero-filling never removed ciphertext from
 * disk. It only doubled the write load. After a DELETE the old row versions
 * stay in the table files until plain VACUUM marks the space reusable and
 * later writes overwrite it, or until VACUUM FULL (scripts/compact.mjs, daily)
 * or TRUNCATE (purge) writes new files. Full-disk encryption covers what is
 * left in freed blocks, the write-ahead log, and backups.
 */

/** @typedef {(text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>} Query */
/**
 * A connection that can run single statements (each in its own implicit
 * transaction) and explicit transactions.
 * @typedef {{ query: Query, transaction: <T>(run: (query: Query) => Promise<T>) => Promise<T> }} Db
 */

export const SECRET_TABLES = [
  "sealed_file_chunks",
  "sealed_files",
  "sealed_batches",
  "upload_chunks",
  "upload_sessions",
  "batch_grants",
  "unlock_attempts",
];

/**
 * Run a DELETE and return how many rows it removed, without sending the rows
 * back. Every statement here is scoped by an id, except the two cleanups that
 * select by age: expired tickets and upload chunks with no session.
 * @param {Query} query
 * @param {string} deleteSql a DELETE statement ending in "returning 1"
 * @param {unknown[]} [params]
 * @returns {Promise<number>}
 */
async function deleted(query, deleteSql, params = []) {
  const rows = await query(`with d as (${deleteSql}) select count(*)::int as n from d`, params);
  return Number(rows[0]?.n ?? 0);
}

export const SQL = {
  DELETE_FILE_CHUNKS: `delete from sealed_file_chunks where file_id = $1 returning 1`,
  DELETE_BATCH_CHUNKS: `delete from sealed_file_chunks
    where file_id in (select id from sealed_files where batch_id = $1) returning 1`,
  DELETE_FILE: `delete from sealed_files where id = $1 returning 1`,
  DELETE_BATCH_FILES: `delete from sealed_files where batch_id = $1 returning 1`,
  DELETE_BATCH: `delete from sealed_batches where id = $1 returning 1`,
  DELETE_BATCH_GRANTS: `delete from batch_grants where batch_id = $1 returning 1`,
  DELETE_BATCH_ATTEMPTS: `delete from unlock_attempts where batch_id = $1 returning 1`,
  DELETE_EXPIRED_GRANTS: `delete from batch_grants where expires_at <= now() returning 1`,
  DELETE_UPLOAD_CHUNKS: `delete from upload_chunks where upload_id = $1 returning 1`,
  DELETE_UPLOAD_SESSION: `delete from upload_sessions where id = $1 returning 1`,
  DELETE_ORPHAN_UPLOAD_CHUNKS: `delete from upload_chunks c
    where c.created_at < now() - interval '2 hours'
      and not exists (select 1 from upload_sessions s where s.id = c.upload_id)
    returning 1`,
};

/**
 * Delete a legacy single-file seal (or one file). Run inside a transaction.
 * @param {Query} query
 * @param {string} fileId
 * @returns {Promise<number>} chunk and file rows removed
 */
export async function wipeFile(query, fileId) {
  let removed = await deleted(query, SQL.DELETE_FILE_CHUNKS, [fileId]);
  removed += await deleted(query, SQL.DELETE_FILE, [fileId]);
  // Legacy single-file seals use the file id as their seal id.
  await deleted(query, SQL.DELETE_BATCH_ATTEMPTS, [fileId]);
  return removed;
}

/**
 * Delete a seal and everything that belongs to it. Run inside a transaction:
 * the seal disappears all at once, so a reader never sees it half deleted.
 * @param {Query} query
 * @param {string} batchId
 * @returns {Promise<number>} chunk, file, and seal rows removed
 */
export async function wipeBatch(query, batchId) {
  // Take the seal row first, the same order an unlock uses, so the two never
  // wait on each other's locks in a cycle.
  await query("select 1 from sealed_batches where id = $1 for update", [batchId]);
  // Tickets go first: no download can start against a seal being deleted.
  await deleted(query, SQL.DELETE_BATCH_GRANTS, [batchId]);
  let removed = await deleted(query, SQL.DELETE_BATCH_CHUNKS, [batchId]);
  removed += await deleted(query, SQL.DELETE_BATCH_FILES, [batchId]);
  await deleted(query, SQL.DELETE_BATCH_ATTEMPTS, [batchId]);
  removed += await deleted(query, SQL.DELETE_BATCH, [batchId]);
  return removed;
}

/**
 * Delete an upload's chunks and its session. Run inside a transaction.
 * @param {Query} query
 * @param {string} uploadId
 * @returns {Promise<number>} chunk rows removed
 */
export async function wipeUpload(query, uploadId) {
  const removed = await deleted(query, SQL.DELETE_UPLOAD_CHUNKS, [uploadId]);
  await deleted(query, SQL.DELETE_UPLOAD_SESSION, [uploadId]);
  return removed;
}

const BATCH_IS_DUE = `(
  b.expires_at <= now()
  or (
    b.download_count >= b.max_downloads
    and not exists (
      select 1 from batch_grants g where g.batch_id = b.id and g.expires_at > now()
    )
  )
)`;

const DUE_BATCHES = `
  select b.id from sealed_batches b
  where ${BATCH_IS_DUE}
  order by b.expires_at
`;

/**
 * An upload is due when it was finished or cancelled, when it never received a
 * chunk within 5 minutes, when it went 2 hours without a chunk, or when it is
 * older than 12 hours however often it was kept alive.
 */
const UPLOAD_IS_DUE = `(
  state <> 'pending'
  or created_at < now() - interval '12 hours'
  or (had_chunks = false and updated_at < now() - interval '5 minutes')
  or (had_chunks = true and updated_at < now() - interval '2 hours')
)`;

const DUE_LEGACY = `
  select id from sealed_files
  where batch_id is null
    and (expires_at <= now() or download_count >= max_downloads)
  order by expires_at
`;

/**
 * Delete everything. For purge.mjs only: Cinder must be stopped and no other
 * client connected. TRUNCATE replaces each table's files with empty ones, so
 * the deleted rows leave the table files at once.
 * @param {Query} query
 * @returns {Promise<{ chunks: number, files: number, batches: number, uploads: number }>}
 */
export async function wipeEverything(query) {
  const count = async (/** @type {string} */ table) =>
    Number((await query(`select count(*)::int as n from ${table}`))[0]?.n ?? 0);
  const counts = {
    chunks: await count("sealed_file_chunks"),
    files: await count("sealed_files"),
    batches: await count("sealed_batches"),
    uploads: await count("upload_chunks"),
  };
  await query(`truncate table ${SECRET_TABLES.join(", ")}`);
  return counts;
}

/**
 * The scheduled expiry pass. Each upload and each seal is deleted in its own
 * short transaction, with one statement per table. No table lock is taken, so
 * uploads, unlocks, and downloads keep running however much there is to
 * delete. Deleting only ever lowers usage, so the upload quota needs no lock
 * against it.
 *
 * Every item is re-checked under its row lock before it is deleted, so a seal
 * or upload that became active again after the scan is left alone. An item
 * whose row is busy (lock timeout, deadlock, statement timeout) is skipped and
 * left for the next run, so one busy row never holds up the rest.
 * @param {Db} db
 * @returns {Promise<{ uploads: number, sessions: number, batches: number, legacy: number, grants: number, skipped: number }>}
 */
export async function expireDue(db) {
  let chunks = 0;
  let sessions = 0;
  let skipped = 0;
  /**
   * @param {() => Promise<number>} work
   * @returns {Promise<number>}
   */
  const unlessBusy = async (work) => {
    try {
      return await work();
    } catch (err) {
      const code = /** @type {{ code?: unknown }} */ (err)?.code;
      if (code === "55P03" || code === "40P01" || code === "57014") {
        skipped += 1;
        return 0;
      }
      throw err;
    }
  };

  for (const row of await db.query(`select id from upload_sessions where ${UPLOAD_IS_DUE} order by updated_at`)) {
    const id = String(row.id);
    // Counted only after the transaction commits: 1 for the session plus its chunks.
    const removed = await unlessBusy(() =>
      db.transaction(async (query) => {
        // A chunk or finish request that is already running holds this row,
        // so this waits for it and then re-checks that the upload is due.
        const still = await query(`select id from upload_sessions where id = $1 and ${UPLOAD_IS_DUE} for update`, [id]);
        if (still.length === 0) return 0;
        return 1 + (await wipeUpload(query, id));
      }),
    );
    if (removed > 0) {
      sessions += 1;
      chunks += removed - 1;
    }
  }
  chunks += await unlessBusy(() => deleted(db.query, SQL.DELETE_ORPHAN_UPLOAD_CHUNKS));

  let batches = 0;
  for (const row of await db.query(DUE_BATCHES)) {
    const id = String(row.id);
    batches += await unlessBusy(() =>
      db.transaction(async (query) => {
        const still = await query(`select b.id from sealed_batches b where b.id = $1 and ${BATCH_IS_DUE} for update`, [id]);
        if (still.length === 0) return 0;
        await wipeBatch(query, id);
        return 1;
      }),
    );
  }

  let legacy = 0;
  for (const row of await db.query(DUE_LEGACY)) {
    const id = String(row.id);
    legacy += await unlessBusy(() =>
      db.transaction(async (query) => {
        const still = await query(
          `select id from sealed_files
           where id = $1 and batch_id is null and (expires_at <= now() or download_count >= max_downloads)
           for update`,
          [id],
        );
        if (still.length === 0) return 0;
        await wipeFile(query, id);
        return 1;
      }),
    );
  }

  const grants = await unlessBusy(() => deleted(db.query, SQL.DELETE_EXPIRED_GRANTS));
  return { uploads: chunks, sessions, batches, legacy, grants, skipped };
}
