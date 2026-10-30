/**
 * Replace secret columns with zeros, then delete the row.
 *
 * PostgreSQL keeps the previous row version until the table is rewritten.
 * One zero-fill followed by DELETE is the sequence that lets VACUUM FULL
 * (scripts/compact.mjs, on its own schedule) drop the ciphertext from the
 * live table file. A second overwrite does
 * nothing until that rewrite happens. Values larger than 16 MiB are
 * replaced with a single zero: a same-length replacement of a multi-gigabyte
 * legacy blob cannot be allocated in one UPDATE, and the old version is
 * removed by the rewrite rather than by the size of the new value.
 */

/** @typedef {(text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>} Query */
/**
 * A connection that can run single statements (each in its own implicit
 * transaction) and explicit transactions.
 * @typedef {{ query: Query, transaction: <T>(run: (query: Query) => Promise<T>) => Promise<T> }} Db
 */
/** @typedef {(done: number, total: number) => void} Progress */

export const SECRET_TABLES = [
  "sealed_file_chunks",
  "sealed_files",
  "sealed_batches",
  "upload_chunks",
  "upload_sessions",
  "batch_grants",
  "unlock_attempts",
];

const ZERO_LIMIT = 16 * 1024 * 1024;

/**
 * @param {string} column
 * @returns {string}
 */
function zeroText(column) {
  return `case
    when ${column} is null then null
    when octet_length(${column}) > ${ZERO_LIMIT} then '0'
    else repeat('0', char_length(${column}))
  end`;
}

/**
 * @param {string} column
 * @returns {string}
 */
function zeroBytea(column) {
  return `case
    when ${column} is null then null
    when octet_length(${column}) > ${ZERO_LIMIT} then decode('00', 'hex')
    else decode(repeat('00', octet_length(${column})), 'hex')
  end`;
}

export const SQL = {
  ZERO_ONE_CHUNK: `
    update sealed_file_chunks
    set payload = ${zeroBytea("payload")},
        iv = ${zeroText("iv")}
    where file_id = $1 and chunk_index = $2
    returning 1
  `,
  DELETE_ONE_CHUNK: `
    delete from sealed_file_chunks
    where file_id = $1 and chunk_index = $2
    returning 1
  `,
  ZERO_FILE: `
    update sealed_files
    set original_name = ${zeroText("original_name")},
        mime_type = ${zeroText("mime_type")},
        ciphertext = ${zeroText("ciphertext")},
        salt_enc = ${zeroText("salt_enc")},
        iv = ${zeroText("iv")},
        salt_auth = ${zeroText("salt_auth")},
        auth_hash = ${zeroText("auth_hash")},
        file_nonce = ${zeroText("file_nonce")},
        name_iv = ${zeroText("name_iv")},
        name_ct = ${zeroText("name_ct")},
        mime_iv = ${zeroText("mime_iv")},
        mime_ct = ${zeroText("mime_ct")},
        size_bytes = case when size_bytes is null then null else 0 end,
        cipher_bytes = 0
    where id = $1
    returning 1
  `,
  DELETE_FILE: `delete from sealed_files where id = $1 returning 1`,
  ZERO_BATCH: `
    update sealed_batches
    set salt_auth = ${zeroText("salt_auth")},
        auth_hash = ${zeroText("auth_hash")},
        salt_enc = ${zeroText("salt_enc")},
        grant_token = ${zeroText("grant_token")},
        client_key = ${zeroText("client_key")}
    where id = $1
    returning 1
  `,
  DELETE_BATCH: `delete from sealed_batches where id = $1 returning 1`,
  // Grant rows hold only a hash of a short-lived ticket and attempt rows hold a
  // keyed client hash in the primary key, so they are deleted, not zeroed.
  DELETE_BATCH_GRANTS: `delete from batch_grants where batch_id = $1 returning 1`,
  DELETE_BATCH_ATTEMPTS: `delete from unlock_attempts where batch_id = $1 returning 1`,
  DELETE_EXPIRED_GRANTS: `delete from batch_grants where expires_at <= now() returning 1`,
  ZERO_ONE_UPLOAD: `
    update upload_chunks
    set payload = ${zeroText("payload")},
        payload_bin = ${zeroBytea("payload_bin")},
        iv = ${zeroText("iv")}
    where upload_id = $1 and file_index = $2 and chunk_index = $3
    returning 1
  `,
  DELETE_ONE_UPLOAD: `
    delete from upload_chunks
    where upload_id = $1 and file_index = $2 and chunk_index = $3
    returning 1
  `,
  DELETE_UPLOAD_SESSION: `delete from upload_sessions where id = $1 returning 1`,
  ZERO_UPLOAD_SESSION: `
    update upload_sessions
    set client_ip = ${zeroText("client_ip")}
    where id = $1
    returning 1
  `,
};

/**
 * @param {Query} query
 * @param {string} text
 * @param {unknown[]} [params]
 * @returns {Promise<number>}
 */
async function changed(query, text, params = []) {
  const rows = await query(text, params);
  return rows.length;
}

/**
 * @param {Query} query
 * @param {string} fileId
 * @returns {Promise<number>}
 */
export async function wipeFile(query, fileId) {
  const chunks = await query(
    "select chunk_index from sealed_file_chunks where file_id = $1 order by chunk_index",
    [fileId],
  );
  let removed = 0;
  for (const row of chunks) {
    await changed(query, SQL.ZERO_ONE_CHUNK, [fileId, row.chunk_index]);
    removed += await changed(query, SQL.DELETE_ONE_CHUNK, [fileId, row.chunk_index]);
  }
  await changed(query, SQL.ZERO_FILE, [fileId]);
  removed += await changed(query, SQL.DELETE_FILE, [fileId]);
  // Legacy single-file seals use the file id as their seal id.
  await changed(query, SQL.DELETE_BATCH_ATTEMPTS, [fileId]);
  return removed;
}

/**
 * @param {Query} query
 * @param {string} batchId
 * @returns {Promise<number>}
 */
export async function wipeBatch(query, batchId) {
  // Take the seal row first, the same order an unlock uses, so the two never
  // wait on each other's locks in a cycle.
  await query("select 1 from sealed_batches where id = $1 for update", [batchId]);
  const files = await query("select id from sealed_files where batch_id = $1", [batchId]);
  let removed = 0;
  for (const row of files) {
    removed += await wipeFile(query, String(row.id));
  }
  await changed(query, SQL.DELETE_BATCH_GRANTS, [batchId]);
  await changed(query, SQL.DELETE_BATCH_ATTEMPTS, [batchId]);
  await changed(query, SQL.ZERO_BATCH, [batchId]);
  removed += await changed(query, SQL.DELETE_BATCH, [batchId]);
  return removed;
}

/**
 * @param {Query} query
 * @param {string} uploadId
 * @returns {Promise<number>}
 */
export async function wipeUpload(query, uploadId) {
  const rows = await query(
    "select file_index, chunk_index from upload_chunks where upload_id = $1 order by file_index, chunk_index",
    [uploadId],
  );
  let removed = 0;
  for (const row of rows) {
    await changed(query, SQL.ZERO_ONE_UPLOAD, [uploadId, row.file_index, row.chunk_index]);
    removed += await changed(query, SQL.DELETE_ONE_UPLOAD, [
      uploadId,
      row.file_index,
      row.chunk_index,
    ]);
  }
  await changed(query, SQL.ZERO_UPLOAD_SESSION, [uploadId]);
  await changed(query, SQL.DELETE_UPLOAD_SESSION, [uploadId]);
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
 * Delete every abandoned upload, expired seal, and used-up seal.
 * A used-up seal stays until its download ticket has ended.
 * @param {Query} query
 * @returns {Promise<{ uploads: number, sessions: number, batches: number, legacy: number, grants: number }>}
 */
export async function wipeDue(query) {
  const uploads = await wipeAbandonedUploads(query);
  const batches = await query(DUE_BATCHES);
  for (const row of batches) {
    await wipeBatch(query, String(row.id));
  }
  const legacy = await query(DUE_LEGACY);
  for (const row of legacy) {
    await wipeFile(query, String(row.id));
  }
  const grants = await changed(query, SQL.DELETE_EXPIRED_GRANTS);
  return { uploads: uploads.chunks, sessions: uploads.sessions, batches: batches.length, legacy: legacy.length, grants };
}

/**
 * An upload is due when it was finished or cancelled, when it never received a
 * chunk within 5 minutes, when it went 2 hours without a chunk, or when it is
 * older than 12 hours however often it was kept alive.
 * @param {Query} query
 * @returns {Promise<{ chunks: number, sessions: number }>}
 */
export async function wipeAbandonedUploads(query) {
  const sessions = await query(
    `select id from upload_sessions
     where ${UPLOAD_IS_DUE}
     order by updated_at
     for update`,
  );
  let removed = 0;
  for (const row of sessions) {
    removed += await wipeUpload(query, String(row.id));
  }
  const rows = await query(
    `select c.upload_id, c.file_index, c.chunk_index
     from upload_chunks c
     where c.created_at < now() - interval '2 hours'
       and not exists (select 1 from upload_sessions s where s.id = c.upload_id)
     order by c.created_at`,
  );
  for (const row of rows) {
    await changed(query, SQL.ZERO_ONE_UPLOAD, [row.upload_id, row.file_index, row.chunk_index]);
    removed += await changed(query, SQL.DELETE_ONE_UPLOAD, [
      row.upload_id,
      row.file_index,
      row.chunk_index,
    ]);
  }
  return { chunks: removed, sessions: sessions.length };
}

/**
 * @param {Query} query
 * @param {Progress} [onProgress]
 * @returns {Promise<{ chunks: number, files: number, batches: number, uploads: number }>}
 */
export async function wipeEverything(query, onProgress) {
  const chunks = await query(
    "select file_id, chunk_index from sealed_file_chunks order by file_id, chunk_index",
  );
  let chunkCount = 0;
  let seen = 0;
  for (const row of chunks) {
    await changed(query, SQL.ZERO_ONE_CHUNK, [row.file_id, row.chunk_index]);
    chunkCount += await changed(query, SQL.DELETE_ONE_CHUNK, [row.file_id, row.chunk_index]);
    seen += 1;
    if (onProgress) onProgress(seen, chunks.length);
  }

  const files = await query("select id from sealed_files");
  let fileCount = 0;
  for (const row of files) {
    await changed(query, SQL.ZERO_FILE, [row.id]);
    fileCount += await changed(query, SQL.DELETE_FILE, [row.id]);
  }

  const batches = await query("select id from sealed_batches");
  let batchCount = 0;
  for (const row of batches) {
    await changed(query, SQL.ZERO_BATCH, [row.id]);
    batchCount += await changed(query, SQL.DELETE_BATCH, [row.id]);
  }

  const uploads = await query(
    "select upload_id, file_index, chunk_index from upload_chunks order by upload_id, file_index, chunk_index",
  );
  let uploadCount = 0;
  for (const row of uploads) {
    await changed(query, SQL.ZERO_ONE_UPLOAD, [row.upload_id, row.file_index, row.chunk_index]);
    uploadCount += await changed(query, SQL.DELETE_ONE_UPLOAD, [
      row.upload_id,
      row.file_index,
      row.chunk_index,
    ]);
  }

  const sessions = await query("select id from upload_sessions");
  for (const row of sessions) {
    await changed(query, SQL.ZERO_UPLOAD_SESSION, [row.id]);
    await changed(query, SQL.DELETE_UPLOAD_SESSION, [row.id]);
  }

  await query("delete from batch_grants");
  await query("delete from unlock_attempts");

  return { chunks: chunkCount, files: fileCount, batches: batchCount, uploads: uploadCount };
}

/**
 * The scheduled expiry pass. Unlike wipeDue it never holds one long
 * transaction: each upload piece is wiped in its own short transaction, and
 * each seal in its own. No table lock is taken, so uploads, unlocks, and
 * downloads keep running however much there is to delete. Deleting only ever
 * lowers usage, so the upload quota needs no lock against it.
 *
 * Every item is re-checked under its row lock before it is wiped, so a seal or
 * upload that became active again after the scan is left alone. An item whose
 * row is busy (lock timeout, deadlock, statement timeout) is skipped and left
 * for the next run, so one busy row never holds up the rest.
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
  const dueSessions = await db.query(`select id from upload_sessions where ${UPLOAD_IS_DUE} order by updated_at`);
  for (const row of dueSessions) {
    const id = String(row.id);
    sessions += await unlessBusy(async () => {
      // Close the upload first. A chunk or finish request that is already
      // running holds this row, so this waits for it and then re-checks.
      const closed = await db.query(
        `update upload_sessions
         set state = case when state = 'pending' then 'cancelled' else state end
         where id = $1 and ${UPLOAD_IS_DUE}
         returning id`,
        [id],
      );
      if (closed.length === 0) return 0;
      const pieces = await db.query(
        "select file_index, chunk_index from upload_chunks where upload_id = $1 order by file_index, chunk_index",
        [id],
      );
      for (const piece of pieces) {
        chunks += await db.transaction(async (query) => {
          await changed(query, SQL.ZERO_ONE_UPLOAD, [id, piece.file_index, piece.chunk_index]);
          return changed(query, SQL.DELETE_ONE_UPLOAD, [id, piece.file_index, piece.chunk_index]);
        });
      }
      await db.transaction(async (query) => {
        await changed(query, SQL.ZERO_UPLOAD_SESSION, [id]);
        await changed(query, SQL.DELETE_UPLOAD_SESSION, [id]);
      });
      return 1;
    });
  }
  const orphans = await db.query(
    `select c.upload_id, c.file_index, c.chunk_index
     from upload_chunks c
     where c.created_at < now() - interval '2 hours'
       and not exists (select 1 from upload_sessions s where s.id = c.upload_id)
     order by c.created_at`,
  );
  for (const row of orphans) {
    chunks += await unlessBusy(() =>
      db.transaction(async (query) => {
        await changed(query, SQL.ZERO_ONE_UPLOAD, [row.upload_id, row.file_index, row.chunk_index]);
        return changed(query, SQL.DELETE_ONE_UPLOAD, [row.upload_id, row.file_index, row.chunk_index]);
      }),
    );
  }

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

  const grants = await unlessBusy(() => changed(db.query, SQL.DELETE_EXPIRED_GRANTS));
  return { uploads: chunks, sessions, batches, legacy, grants, skipped };
}
