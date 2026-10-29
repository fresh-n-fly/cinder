/**
 * Replace secret columns with zeros, then delete the row.
 *
 * PostgreSQL keeps the previous row version until the table is rewritten.
 * One zero-fill followed by DELETE is the sequence that lets VACUUM FULL
 * drop the ciphertext from the live table file. A second overwrite does
 * nothing until that rewrite happens. Values larger than 16 MiB are
 * replaced with a single zero: a same-length replacement of a multi-gigabyte
 * legacy blob cannot be allocated in one UPDATE, and the old version is
 * removed by the rewrite rather than by the size of the new value.
 */

/** @typedef {(text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>} Query */
/** @typedef {(done: number, total: number) => void} Progress */

export const SECRET_TABLES = [
  "sealed_file_chunks",
  "sealed_files",
  "sealed_batches",
  "upload_chunks",
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
        grant_token = ${zeroText("grant_token")}
    where id = $1
    returning 1
  `,
  DELETE_BATCH: `delete from sealed_batches where id = $1 returning 1`,
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
  return removed;
}

/**
 * @param {Query} query
 * @param {string} batchId
 * @returns {Promise<number>}
 */
export async function wipeBatch(query, batchId) {
  const files = await query("select id from sealed_files where batch_id = $1", [batchId]);
  let removed = 0;
  for (const row of files) {
    removed += await wipeFile(query, String(row.id));
  }
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
  return removed;
}

const DUE_BATCHES = `
  select id from sealed_batches
  where expires_at <= now()
     or (
       download_count >= max_downloads
       and (grant_expires_at is null or grant_expires_at <= now())
     )
  order by expires_at
`;

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
 * @returns {Promise<{ uploads: number, batches: number, legacy: number }>}
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
  return { uploads, batches: batches.length, legacy: legacy.length };
}

/**
 * @param {Query} query
 * @returns {Promise<number>}
 */
export async function wipeAbandonedUploads(query) {
  const rows = await query(
    `select upload_id, file_index, chunk_index
     from upload_chunks
     where created_at < now() - interval '2 hours'
     order by created_at`,
  );
  let removed = 0;
  for (const row of rows) {
    await changed(query, SQL.ZERO_ONE_UPLOAD, [row.upload_id, row.file_index, row.chunk_index]);
    removed += await changed(query, SQL.DELETE_ONE_UPLOAD, [
      row.upload_id,
      row.file_index,
      row.chunk_index,
    ]);
  }
  return removed;
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

  return { chunks: chunkCount, files: fileCount, batches: batchCount, uploads: uploadCount };
}
