import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  AAD_VERSION,
  CHUNK_BYTES,
  EMPTY_UPLOAD_TTL_MS,
  ESTIMATED_BATCH_ROW_OVERHEAD_BYTES,
  ESTIMATED_CHUNK_ROW_OVERHEAD_BYTES,
  ESTIMATED_FILE_ROW_OVERHEAD_BYTES,
  ESTIMATED_SESSION_ROW_OVERHEAD_BYTES,
  GCM_TAG_BYTES,
  GRANT_FETCH_FACTOR,
  GRANT_FETCH_SLACK,
  GRANT_TTL_MS,
  MAX_ACTIVE_UPLOADS_PER_IP,
  MAX_BATCH_BYTES,
  MAX_BATCH_FILES,
  MAX_CHUNKS_PER_FILE,
  MAX_CHUNKS_TOTAL,
  MAX_CHUNK_BYTES,
  MAX_CLIENT_LOGICAL_BYTES,
  MAX_CLIENT_STORED_BATCHES,
  MAX_CLIENT_STORED_CHUNKS,
  MAX_DOWNLOADS,
  MAX_FAILED_ATTEMPTS,
  MAX_FAILED_ATTEMPTS_PER_CLIENT,
  MAX_FETCH_CHUNK_INDEX,
  MAX_STORE_BYTES,
  MAX_TTL_MS,
  MAX_UPLOAD_LIFETIME_MS,
  MIME_PAD_BYTES,
  MIN_DOWNLOADS,
  MIN_TTL_MS,
  NAME_PAD_BYTES,
  UPLOAD_TTL_MS,
} from "@/lib/constants";
import { chunkCountFor, formatBytes } from "@/lib/files";
import { clientKeyFor } from "@/lib/client-key.server";
import { dbSource, getSql, type Sql } from "@/lib/db";
import { SECRET_TABLES, wipeBatch, wipeDue, wipeFile } from "../../scripts/wipe.mjs";

export type BatchMeta = {
  id: string;
  saltAuth: string;
  expiresAt: string;
  maxDownloads: number;
  remaining: number;
  locked: boolean;
  fileCount: number;
};

type BatchRow = {
  id: string;
  salt_auth: string;
  auth_hash: string;
  salt_enc: string;
  expires_at: string;
  max_downloads: number;
  download_count: number;
  failed_attempts: number;
};

type FileRow = {
  id: string;
  batch_id: string | null;
  original_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  ciphertext: string | null;
  salt_enc: string;
  iv: string | null;
  salt_auth: string;
  auth_hash: string;
  expires_at: string;
  max_downloads: number;
  download_count: number;
  failed_attempts: number;
  cipher_bytes: number | null;
  chunk_count: number | null;
  file_nonce: string | null;
  name_iv: string | null;
  name_ct: string | null;
  mime_iv: string | null;
  mime_ct: string | null;
  file_index: number | null;
  aad_version: number | null;
};

type UploadSessionRow = {
  id: string;
  client_ip: string | null;
  state: string;
  had_chunks: boolean;
  created_at: string;
  updated_at: string;
};

const ROOM_ERROR = `There is not enough room. Everything stored here can total ${formatBytes(MAX_STORE_BYTES)}.`;
const LOCKED_ERROR = "This file is locked after too many incorrect passwords.";
const CLIENT_LOCKED_ERROR = "Too many incorrect passwords from this connection.";
const GONE_ERROR = "This file is gone.";

/** Quota and capacity refusals: the upload stays intact so it can be retried. */
class CapacityError extends Error {}

function sha256Bytes(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isHex(value: string, length: number): boolean {
  return value.length === length && /^[a-f0-9]+$/.test(value);
}

function toIso(value: string | Date | null | undefined): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  const asDate = new Date(value);
  if (!Number.isNaN(asDate.getTime())) return asDate.toISOString();
  return String(value);
}

function remainingOf(row: { max_downloads: number; download_count: number }): number {
  return Math.max(0, row.max_downloads - row.download_count);
}

function isExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() <= Date.now();
}

function asNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function asBytes(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") {
    if (value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
    return Buffer.from(value, "base64");
  }
  throw new Error("Missing chunk.");
}

function sessionExpired(session: UploadSessionRow): boolean {
  const now = Date.now();
  if (new Date(toIso(session.created_at)).getTime() <= now - MAX_UPLOAD_LIFETIME_MS) return true;
  const idle = session.had_chunks ? UPLOAD_TTL_MS : EMPTY_UPLOAD_TTL_MS;
  return new Date(toIso(session.updated_at)).getTime() <= now - idle;
}

async function estimatedStoredBytes(sql: Sql, clientKey?: string | null): Promise<number> {
  if (clientKey) {
    const rows = await sql<{ total: number }>`
      select (
        coalesce((select sum(octet_length(c.payload)) from sealed_file_chunks c
          join sealed_files f on f.id = c.file_id
          join sealed_batches b on b.id = f.batch_id
          where b.client_key = ${clientKey}), 0)
        + coalesce((select sum(octet_length(c.payload_bin)) from upload_chunks c
          join upload_sessions s on s.id = c.upload_id
          where s.client_ip = ${clientKey}), 0)
        + coalesce((select sum(octet_length(c.payload)) from upload_chunks c
          join upload_sessions s on s.id = c.upload_id
          where s.client_ip = ${clientKey} and c.payload <> ''), 0)
        + coalesce((select sum(octet_length(f.ciphertext)) from sealed_files f
          join sealed_batches b on b.id = f.batch_id
          where b.client_key = ${clientKey}
            and f.ciphertext is not null and f.ciphertext <> ''), 0)
        + (coalesce((select count(*) from sealed_file_chunks c
          join sealed_files f on f.id = c.file_id
          join sealed_batches b on b.id = f.batch_id
          where b.client_key = ${clientKey}), 0)
          + coalesce((select count(*) from upload_chunks c
          join upload_sessions s on s.id = c.upload_id
          where s.client_ip = ${clientKey}), 0)) * ${ESTIMATED_CHUNK_ROW_OVERHEAD_BYTES}
        + coalesce((select count(*) from sealed_files f
          join sealed_batches b on b.id = f.batch_id
          where b.client_key = ${clientKey}), 0) * ${ESTIMATED_FILE_ROW_OVERHEAD_BYTES}
        + coalesce((select count(*) from sealed_batches b where b.client_key = ${clientKey}), 0) * ${ESTIMATED_BATCH_ROW_OVERHEAD_BYTES}
        + coalesce((select count(*) from upload_sessions s where s.client_ip = ${clientKey}), 0) * ${ESTIMATED_SESSION_ROW_OVERHEAD_BYTES}
      )::float8 as total
    `;
    return asNumber(rows[0]?.total);
  }
  const rows = await sql<{ total: number }>`
    select (
      coalesce((select sum(octet_length(payload)) from sealed_file_chunks), 0)
      + coalesce((select sum(octet_length(payload_bin)) from upload_chunks), 0)
      + coalesce((select sum(octet_length(payload)) from upload_chunks where payload <> ''), 0)
      + coalesce((select sum(octet_length(ciphertext)) from sealed_files
          where ciphertext is not null and ciphertext <> ''), 0)
      + (coalesce((select count(*) from sealed_file_chunks), 0)
        + coalesce((select count(*) from upload_chunks), 0)) * ${ESTIMATED_CHUNK_ROW_OVERHEAD_BYTES}
      + coalesce((select count(*) from sealed_files), 0) * ${ESTIMATED_FILE_ROW_OVERHEAD_BYTES}
      + coalesce((select count(*) from sealed_batches), 0) * ${ESTIMATED_BATCH_ROW_OVERHEAD_BYTES}
      + coalesce((select count(*) from upload_sessions), 0) * ${ESTIMATED_SESSION_ROW_OVERHEAD_BYTES}
    )::float8 as total
  `;
  return asNumber(rows[0]?.total);
}

async function clientStoredChunkCount(sql: Sql, clientKey: string): Promise<number> {
  const rows = await sql<{ total: number }>`
    select (
      coalesce((select count(*) from sealed_file_chunks c
        join sealed_files f on f.id = c.file_id
        join sealed_batches b on b.id = f.batch_id
        where b.client_key = ${clientKey}), 0)
      + coalesce((select count(*) from upload_chunks c
        join upload_sessions s on s.id = c.upload_id
        where s.client_ip = ${clientKey}), 0)
    )::float8 as total
  `;
  return asNumber(rows[0]?.total);
}

async function clientStoredBatchCount(sql: Sql, clientKey: string): Promise<number> {
  const rows = await sql<{ total: number }>`
    select count(*)::float8 as total from sealed_batches where client_key = ${clientKey}
  `;
  return asNumber(rows[0]?.total);
}

async function hasLiveGrant(sql: Sql, batchId: string): Promise<boolean> {
  const rows = await sql<{ n: number }>`
    select count(*)::float8 as n from batch_grants
    where batch_id = ${batchId} and expires_at > now()
  `;
  return asNumber(rows[0]?.n) > 0;
}

type Query = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

function asQuery(sql: Sql): Query {
  return (text, params = []) => sql.query(text, params);
}

const secretTables = new Set<string>(SECRET_TABLES);
let vacuumChain: Promise<void> = Promise.resolve();
let pgliteUploadQuotaChain: Promise<void> = Promise.resolve();

async function withUploadQuotaLock<T>(sql: Sql, run: (lockedSql: Sql) => Promise<T>): Promise<T> {
  if (dbSource === "pglite") {
    const previous = pgliteUploadQuotaChain;
    let release: () => void = () => undefined;
    pgliteUploadQuotaChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await sql.transaction(run);
    } finally {
      release();
    }
  }

  return sql.transaction(async (lockedSql) => {
    // Every new stored byte enters through upload_chunks, so serializing this
    // table makes the quota check and write one atomic operation across workers.
    await lockedSql.query("lock table upload_chunks in share row exclusive mode");
    return run(lockedSql);
  });
}

// Plain VACUUM only: it marks deleted rows reusable without an exclusive lock.
// The table rewrite (VACUUM FULL) is scheduled separately (scripts/compact.mjs)
// so no request can trigger it.
async function vacuumTables(sql: Sql, tables: readonly string[]): Promise<void> {
  const unique = [...new Set(tables)].filter((table) => secretTables.has(table));
  if (unique.length === 0) return;
  const run = async () => {
    for (const table of unique) {
      try {
        await sql.query(`VACUUM ${table}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[cinder] VACUUM ${table} failed: ${message}`);
      }
    }
  };
  const done = vacuumChain.then(run, run);
  vacuumChain = done.then(
    () => undefined,
    () => undefined,
  );
  await done;
}

export async function purgeExpired(): Promise<void> {
  const sql = await getSql();
  const due = await sql.transaction(async (lockedSql) => {
    if (dbSource !== "pglite") {
      await lockedSql.query("lock table upload_chunks in share row exclusive mode");
    }
    return wipeDue(asQuery(lockedSql));
  });
  const tables: string[] = [];
  if (due.uploads > 0 || due.sessions > 0) tables.push("upload_chunks", "upload_sessions");
  if (due.batches > 0 || due.legacy > 0) {
    tables.push("sealed_file_chunks", "sealed_files", "sealed_batches", "unlock_attempts");
  }
  if (due.grants > 0) tables.push("batch_grants");
  if (tables.length > 0) await vacuumTables(sql, tables);
}

export async function destroyFile(id: string): Promise<void> {
  const sql = await getSql();
  await wipeFile(asQuery(sql), id);
}

export async function destroyBatch(id: string): Promise<void> {
  const sql = await getSql();
  await wipeBatch(asQuery(sql), id);
}

export async function getBatchMeta(id: string): Promise<BatchMeta | null> {
  if (!isHex(id, 32)) return null;
  const sql = await getSql();

  const batches = await sql<BatchRow>`
    select id, salt_auth, auth_hash, salt_enc, expires_at::text as expires_at,
           max_downloads, download_count, failed_attempts
    from sealed_batches
    where id = ${id}
  `;
  const batch = batches[0];
  if (batch) {
    if (isExpired(toIso(batch.expires_at))) return null;
    if (remainingOf(batch) <= 0 && !(await hasLiveGrant(sql, id))) return null;
    const counts = await sql<{ n: number }>`
      select count(*)::float8 as n from sealed_files where batch_id = ${id}
    `;
    const fileCount = asNumber(counts[0]?.n);
    if (fileCount === 0) {
      await destroyBatch(id);
      return null;
    }
    return {
      id: batch.id,
      saltAuth: batch.salt_auth,
      expiresAt: toIso(batch.expires_at),
      maxDownloads: batch.max_downloads,
      remaining: remainingOf(batch),
      locked: batch.failed_attempts >= MAX_FAILED_ATTEMPTS,
      fileCount,
    };
  }

  const legacy = await sql<FileRow>`
    select id, batch_id, salt_auth, expires_at::text as expires_at, max_downloads,
           download_count, failed_attempts
    from sealed_files
    where id = ${id} and batch_id is null
  `;
  const file = legacy[0];
  if (!file) return null;
  if (isExpired(toIso(file.expires_at)) || remainingOf(file) <= 0) return null;
  return {
    id: file.id,
    saltAuth: file.salt_auth,
    expiresAt: toIso(file.expires_at),
    maxDownloads: file.max_downloads,
    remaining: remainingOf(file),
    locked: file.failed_attempts >= MAX_FAILED_ATTEMPTS,
    fileCount: 1,
  };
}

/** Requests without a usable client address share one bucket instead of skipping limits. */
const UNATTRIBUTED = "unattributed";

export async function startUploadSession(clientIp: string | null, format: number): Promise<{ uploadId: string }> {
  // Refuse an out-of-date page before it uploads anything, not after.
  if (format !== AAD_VERSION) throw new Error("This page is out of date. Reload it and seal the files again.");
  const uploadId = randomBytes(16).toString("hex");
  const clientKey = clientKeyFor(clientIp) ?? UNATTRIBUTED;
  const sql = await getSql();
  await withUploadQuotaLock(sql, async (lockedSql) => {
    if (clientKey) {
      const now = Date.now();
      const lifetimeCutoff = new Date(now - MAX_UPLOAD_LIFETIME_MS).toISOString();
      const emptyCutoff = new Date(now - EMPTY_UPLOAD_TTL_MS).toISOString();
      const idleCutoff = new Date(now - UPLOAD_TTL_MS).toISOString();
      const active = await lockedSql<{ n: number }>`
        select count(*)::float8 as n from upload_sessions
        where client_ip = ${clientKey} and state = 'pending'
          and created_at > ${lifetimeCutoff}::timestamptz
          and updated_at > (case when had_chunks then ${idleCutoff}::timestamptz else ${emptyCutoff}::timestamptz end)
      `;
      if (asNumber(active[0]?.n) >= MAX_ACTIVE_UPLOADS_PER_IP) {
        throw new CapacityError("Too many uploads are in progress from this address.");
      }
      if ((await estimatedStoredBytes(lockedSql, clientKey)) + ESTIMATED_SESSION_ROW_OVERHEAD_BYTES > MAX_CLIENT_LOGICAL_BYTES) {
        throw new CapacityError("Too much is stored from this address.");
      }
    }
    if ((await estimatedStoredBytes(lockedSql)) + ESTIMATED_SESSION_ROW_OVERHEAD_BYTES > MAX_STORE_BYTES) {
      throw new CapacityError(ROOM_ERROR);
    }
    await lockedSql`
      insert into upload_sessions (id, client_ip)
      values (${uploadId}, ${clientKey})
    `;
  });
  return { uploadId };
}

async function markUploadForCleanup(sql: Sql, uploadId: string, state: "finished" | "cancelled"): Promise<void> {
  // Leave wiping to the expiry worker instead of doing row-by-row secret
  // deletion in a public request handler.
  await sql`
    update upload_sessions
    set state = ${state}, updated_at = now() - interval '3 hours'
    where id = ${uploadId}
  `;
  await sql`
    update upload_chunks
    set created_at = now() - interval '3 hours'
    where upload_id = ${uploadId}
  `;
}

async function discardUpload(uploadId: string): Promise<void> {
  const sql = await getSql();
  await withUploadQuotaLock(sql, (lockedSql) => markUploadForCleanup(lockedSql, uploadId, "cancelled"));
}

export async function cancelUpload(uploadId: string): Promise<void> {
  if (!isHex(uploadId, 32)) return;
  await discardUpload(uploadId);
}

export async function storeChunk(input: {
  uploadId: string;
  fileIndex: number;
  chunkIndex: number;
  iv: string;
  payload: Buffer;
}): Promise<void> {
  if (!isHex(input.uploadId, 32)) throw new Error("Invalid upload.");
  if (!isHex(input.iv, 24)) throw new Error("Encryption metadata is invalid.");
  if (
    !Number.isInteger(input.fileIndex) ||
    input.fileIndex < 0 ||
    input.fileIndex >= MAX_BATCH_FILES
  ) {
    throw new Error("Invalid file index.");
  }
  if (
    !Number.isInteger(input.chunkIndex) ||
    input.chunkIndex < 0 ||
    input.chunkIndex >= MAX_CHUNKS_PER_FILE
  ) {
    throw new Error("Invalid chunk.");
  }
  if (input.payload.length <= GCM_TAG_BYTES || input.payload.length > MAX_CHUNK_BYTES) {
    throw new Error("Chunk is too large.");
  }
  const sql = await getSql();
  let discard = false;
  try {
    await withUploadQuotaLock(sql, async (lockedSql) => {
      const sessions = await lockedSql<UploadSessionRow>`
        select id, client_ip, state, had_chunks,
               created_at::text as created_at, updated_at::text as updated_at
        from upload_sessions
        where id = ${input.uploadId}
        for update
      `;
      const session = sessions[0];
      if (!session || session.state !== "pending") throw new Error("Invalid upload.");
      if (sessionExpired(session)) {
        discard = true;
        throw new Error("Upload expired.");
      }
      const existing = await lockedSql<{ n: number }>`
        select count(*)::float8 as n from upload_chunks
        where upload_id = ${input.uploadId}
          and not (file_index = ${input.fileIndex} and chunk_index = ${input.chunkIndex})
      `;
      if (asNumber(existing[0]?.n) >= MAX_CHUNKS_TOTAL) {
        discard = true;
        throw new Error("Invalid chunk.");
      }

      // Every chunk but the last of a file is a full slice. A short chunk is
      // accepted only as the highest index of its file, and at most once, so
      // an upload cannot be made of many tiny rows.
      const shape = await lockedSql<{ same: number; short_any: number; short_below: number; above: number }>`
        select
          count(*) filter (where chunk_index = ${input.chunkIndex})::float8 as same,
          count(*) filter (where octet_length(payload_bin) < ${MAX_CHUNK_BYTES})::float8 as short_any,
          count(*) filter (where octet_length(payload_bin) < ${MAX_CHUNK_BYTES}
                             and chunk_index < ${input.chunkIndex})::float8 as short_below,
          count(*) filter (where chunk_index > ${input.chunkIndex})::float8 as above
        from upload_chunks
        where upload_id = ${input.uploadId} and file_index = ${input.fileIndex}
      `;
      const counts = shape[0];
      if (asNumber(counts?.same) !== 0) throw new Error("Chunk already uploaded.");
      const isShort = input.payload.length < MAX_CHUNK_BYTES;
      const badShape = isShort
        ? asNumber(counts?.short_any) > 0 || asNumber(counts?.above) > 0
        : asNumber(counts?.short_below) > 0;
      if (badShape) {
        discard = true;
        throw new Error("Invalid chunk.");
      }

      if (session.client_ip && (await clientStoredChunkCount(lockedSql, session.client_ip)) >= MAX_CLIENT_STORED_CHUNKS) {
        throw new CapacityError("Too many files are stored from this address.");
      }
      const billedBytes = input.payload.length + ESTIMATED_CHUNK_ROW_OVERHEAD_BYTES;
      if ((await estimatedStoredBytes(lockedSql)) + billedBytes > MAX_STORE_BYTES) {
        throw new CapacityError(ROOM_ERROR);
      }
      if (session.client_ip && (await estimatedStoredBytes(lockedSql, session.client_ip)) + billedBytes > MAX_CLIENT_LOGICAL_BYTES) {
        throw new CapacityError("Too much is stored from this address.");
      }
      await lockedSql`
        insert into upload_chunks (upload_id, file_index, chunk_index, payload, iv, payload_bin)
        values (${input.uploadId}, ${input.fileIndex}, ${input.chunkIndex}, '', ${input.iv}, ${input.payload})
      `;
      await lockedSql`
        update upload_sessions set had_chunks = true, updated_at = now()
        where id = ${input.uploadId}
      `;
    });
  } catch (err) {
    if (discard) await discardUpload(input.uploadId);
    throw err;
  }
}

export type FinishFile = {
  fileIndex: number;
  fileNonce: string;
  nameIv: string;
  nameCt: string;
  mimeIv: string;
  mimeCt: string;
  chunkCount: number;
};

export type FinishInput = {
  uploadId: string;
  format: number;
  saltAuth: string;
  saltEnc: string;
  authHash: string;
  expiresAt: string;
  maxDownloads: number;
  files: FinishFile[];
};

const NAME_CT_HEX = (NAME_PAD_BYTES + GCM_TAG_BYTES) * 2;
const MIME_CT_HEX = (MIME_PAD_BYTES + GCM_TAG_BYTES) * 2;

export function validateFinishInput(input: FinishInput): string | null {
  if (!isHex(input.uploadId, 32)) return "Invalid upload.";
  if (input.format !== AAD_VERSION) return "This page is out of date. Reload it and seal the files again.";
  if (!isHex(input.saltEnc, 32) || !isHex(input.saltAuth, 32) || !isHex(input.authHash, 64)) {
    return "Encryption metadata is invalid.";
  }
  if (
    !Number.isInteger(input.maxDownloads) ||
    input.maxDownloads < MIN_DOWNLOADS ||
    input.maxDownloads > MAX_DOWNLOADS
  ) {
    return "Download limit must be between 1 and 100.";
  }
  const expires = new Date(input.expiresAt).getTime();
  if (Number.isNaN(expires)) return "Expiration date is invalid.";
  const delta = expires - Date.now();
  if (delta < MIN_TTL_MS - 5_000) return "Expiration must be at least 15 minutes from now.";
  if (delta > MAX_TTL_MS + 60_000) return "Expiration cannot be more than 30 days from now.";
  if (!Array.isArray(input.files) || input.files.length === 0) return "Choose at least one file.";
  if (input.files.length > MAX_BATCH_FILES) return `A batch can hold ${MAX_BATCH_FILES} files.`;

  const seen = new Set<number>();
  let chunks = 0;
  for (const file of input.files) {
    // Positions are bound into the encryption, so they must be exactly 0..n-1.
    if (
      !Number.isInteger(file.fileIndex) ||
      file.fileIndex < 0 ||
      file.fileIndex >= input.files.length ||
      seen.has(file.fileIndex)
    ) {
      return "Invalid file list.";
    }
    seen.add(file.fileIndex);
    if (
      !isHex(file.fileNonce, 32) ||
      !isHex(file.nameIv, 24) ||
      !isHex(file.mimeIv, 24) ||
      !isHex(file.nameCt, NAME_CT_HEX) ||
      !isHex(file.mimeCt, MIME_CT_HEX)
    ) {
      return "Encryption metadata is invalid.";
    }
    if (
      !Number.isInteger(file.chunkCount) ||
      file.chunkCount < 1 ||
      file.chunkCount > MAX_CHUNKS_PER_FILE
    ) {
      return "Invalid chunk list.";
    }
    chunks += file.chunkCount;
    if (chunks > MAX_CHUNKS_TOTAL) return "Invalid chunk list.";
  }
  return null;
}

export async function finishUpload(input: FinishInput): Promise<{ id: string }> {
  const error = validateFinishInput(input);
  if (error) throw new Error(error);
  const sql = await getSql();
  let discard = false;
  try {
    return await withUploadQuotaLock(sql, async (lockedSql) => {
      const sessions = await lockedSql<UploadSessionRow>`
        select id, client_ip, state, had_chunks,
               created_at::text as created_at, updated_at::text as updated_at
        from upload_sessions
        where id = ${input.uploadId}
        for update
      `;
      const session = sessions[0];
      if (!session || session.state !== "pending") throw new Error("Invalid upload.");
      discard = true;
      if (sessionExpired(session)) throw new Error("Upload expired.");

      let uploadPlainBytes = 0;
      let uploadCipherBytes = 0;
      let uploadChunkCount = 0;
      const uploadedFiles = await lockedSql<{ file_index: number }>`
        select distinct file_index from upload_chunks
        where upload_id = ${input.uploadId}
        order by file_index
      `;
      const expectedFiles = new Set(input.files.map((file) => file.fileIndex));
      if (
        uploadedFiles.length !== expectedFiles.size ||
        uploadedFiles.some((file) => !expectedFiles.has(file.file_index))
      ) {
        throw new Error("Upload was incomplete.");
      }
      for (const file of input.files) {
        const chunks = await lockedSql<{ chunk_index: number; len: number; iv: string }>`
          select chunk_index, octet_length(payload_bin)::float8 as len, iv
          from upload_chunks
          where upload_id = ${input.uploadId} and file_index = ${file.fileIndex}
          order by chunk_index
        `;
        if (chunks.length !== file.chunkCount) throw new Error("Upload was incomplete.");
        for (let index = 0; index < file.chunkCount; index += 1) {
          const chunk = chunks[index];
          if (!chunk || chunk.chunk_index !== index || !isHex(chunk.iv, 24)) {
            throw new Error("Upload was incomplete.");
          }
          const len = asNumber(chunk.len);
          if (len <= GCM_TAG_BYTES || len > MAX_CHUNK_BYTES) throw new Error("Encrypted payload is invalid.");
          if (index < file.chunkCount - 1 && len !== MAX_CHUNK_BYTES) {
            throw new Error("Encrypted payload is invalid.");
          }
          uploadCipherBytes += len;
          uploadChunkCount += 1;
          uploadPlainBytes += len - GCM_TAG_BYTES;
          if (uploadPlainBytes > MAX_BATCH_BYTES) {
            throw new Error(`One seal can hold at most ${formatBytes(MAX_BATCH_BYTES)}.`);
          }
        }
      }
      const metadataBytes = ESTIMATED_BATCH_ROW_OVERHEAD_BYTES + input.files.length * ESTIMATED_FILE_ROW_OVERHEAD_BYTES;
      const copiedChunkBytes = uploadCipherBytes + uploadChunkCount * ESTIMATED_CHUNK_ROW_OVERHEAD_BYTES;
      // Finished chunks remain in upload_chunks until the expiry worker wipes
      // them, so reserve the second live copy before sealing the batch.
      if ((await estimatedStoredBytes(lockedSql)) + copiedChunkBytes + metadataBytes > MAX_STORE_BYTES) {
        throw new CapacityError(ROOM_ERROR);
      }
      if (session.client_ip) {
        // Client quotas are logical ownership quotas: these chunks move from
        // pending to sealed ownership. The global quota above reserves the
        // temporary second physical copy until cleanup runs.
        if ((await estimatedStoredBytes(lockedSql, session.client_ip)) + metadataBytes > MAX_CLIENT_LOGICAL_BYTES) {
          throw new CapacityError("Too much is stored from this address.");
        }
        if ((await clientStoredChunkCount(lockedSql, session.client_ip)) > MAX_CLIENT_STORED_CHUNKS) {
          throw new CapacityError("Too many files are stored from this address.");
        }
        if ((await clientStoredBatchCount(lockedSql, session.client_ip)) >= MAX_CLIENT_STORED_BATCHES) {
          throw new CapacityError("Too many files are stored from this address.");
        }
      }

      const batchId = randomBytes(16).toString("hex");
      const expires = new Date(input.expiresAt).toISOString();
      await lockedSql`
        insert into sealed_batches (
          id, salt_auth, auth_hash, salt_enc, expires_at, max_downloads, client_key
        ) values (
          ${batchId}, ${input.saltAuth}, ${input.authHash}, ${input.saltEnc},
          ${expires}::timestamptz, ${input.maxDownloads}, ${session.client_ip}
        )
      `;

      for (const file of input.files) {
        const fileId = randomBytes(16).toString("hex");
        await lockedSql`
          insert into sealed_files (
            id, batch_id, original_name, mime_type, size_bytes, ciphertext,
            salt_enc, iv, salt_auth, auth_hash, expires_at, max_downloads, cipher_bytes,
            file_nonce, name_iv, name_ct, mime_iv, mime_ct, chunk_count, file_index, aad_version
          ) values (
            ${fileId}, ${batchId}, null, null, null, null,
            ${input.saltEnc}, null, ${input.saltAuth}, ${input.authHash},
            ${expires}::timestamptz, ${input.maxDownloads}, 0,
            ${file.fileNonce}, ${file.nameIv}, ${file.nameCt}, ${file.mimeIv}, ${file.mimeCt},
            ${file.chunkCount}, ${file.fileIndex}, ${AAD_VERSION}
          )
        `;
        await lockedSql`
          insert into sealed_file_chunks (file_id, chunk_index, iv, payload)
          select ${fileId}, chunk_index, iv, payload_bin
          from upload_chunks
          where upload_id = ${input.uploadId} and file_index = ${file.fileIndex}
        `;
      }

      await markUploadForCleanup(lockedSql, input.uploadId, "finished");
      discard = false;
      return { id: batchId };
    });
  } catch (err) {
    if (discard && !(err instanceof CapacityError)) await discardUpload(input.uploadId);
    throw err;
  }
}

function verifierMatches(verifierHex: string, authHash: string): boolean {
  if (!isHex(verifierHex, 64) || !isHex(authHash, 64)) return false;
  const incoming = sha256Bytes(Buffer.from(verifierHex, "hex"));
  const stored = Buffer.from(authHash, "hex");
  return incoming.length === stored.length && stored.length === 32 && timingSafeEqual(incoming, stored);
}

export type UnlockFile = {
  id: string;
  chunkCount: number;
  legacy: boolean;
  fileIndex: number;
  aadVersion: number;
  fileNonce: string;
  nameIv: string;
  nameCt: string;
  mimeIv: string;
  mimeCt: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  iv: string;
};

export type UnlockResult =
  | {
      ok: true;
      ticket: string;
      remainingAfter: number;
      lastAccess: boolean;
      saltEnc: string;
      files: UnlockFile[];
    }
  | { ok: false; error: string; status: number; remainingAttempts?: number };

function presentFile(file: Pick<
  FileRow,
  | "id"
  | "chunk_count"
  | "cipher_bytes"
  | "file_nonce"
  | "name_iv"
  | "name_ct"
  | "mime_iv"
  | "mime_ct"
  | "original_name"
  | "mime_type"
  | "size_bytes"
  | "iv"
  | "file_index"
  | "aad_version"
>): UnlockFile {
  const legacy = !file.name_ct;
  return {
    id: file.id,
    chunkCount:
      file.chunk_count && file.chunk_count > 0
        ? file.chunk_count
        : chunkCountFor(file.cipher_bytes ?? 0, CHUNK_BYTES),
    legacy,
    fileIndex: file.file_index ?? -1,
    aadVersion: file.aad_version ?? 1,
    fileNonce: legacy ? "" : (file.file_nonce ?? ""),
    nameIv: legacy ? "" : (file.name_iv ?? ""),
    nameCt: legacy ? "" : (file.name_ct ?? ""),
    mimeIv: legacy ? "" : (file.mime_iv ?? ""),
    mimeCt: legacy ? "" : (file.mime_ct ?? ""),
    originalName: legacy ? (file.original_name ?? "download") : "",
    mimeType: legacy ? (file.mime_type ?? "application/octet-stream") : "",
    sizeBytes: legacy ? (file.size_bytes ?? 0) : 0,
    iv: legacy ? (file.iv ?? "") : "",
  };
}

async function clientFailures(sql: Sql, id: string, clientKey: string): Promise<number> {
  const rows = await sql<{ failures: number }>`
    select failures from unlock_attempts where batch_id = ${id} and client_key = ${clientKey}
  `;
  return asNumber(rows[0]?.failures);
}

/**
 * Count one wrong password, inside the caller's transaction. A client network
 * can spend at most MAX_FAILED_ATTEMPTS_PER_CLIENT of the seal's lifetime
 * budget, so locking a seal for everyone takes several distinct networks.
 */
async function recordFailedUnlock(
  tx: Sql,
  kind: "batch" | "legacy",
  id: string,
  clientKey: string,
): Promise<UnlockResult> {
  const client = await tx<{ failures: number }>`
    insert into unlock_attempts (batch_id, client_key, failures)
    values (${id}, ${clientKey}, 1)
    on conflict (batch_id, client_key) do update
      set failures = unlock_attempts.failures + 1, updated_at = now()
      where unlock_attempts.failures < ${MAX_FAILED_ATTEMPTS_PER_CLIENT}
    returning failures
  `;
  if (!client[0]) {
    return { ok: false, error: CLIENT_LOCKED_ERROR, status: 429, remainingAttempts: 0 };
  }
  const global =
    kind === "batch"
      ? await tx<{ failed_attempts: number }>`
          update sealed_batches set failed_attempts = failed_attempts + 1
          where id = ${id} and failed_attempts < ${MAX_FAILED_ATTEMPTS}
          returning failed_attempts
        `
      : await tx<{ failed_attempts: number }>`
          update sealed_files set failed_attempts = failed_attempts + 1
          where id = ${id} and batch_id is null and failed_attempts < ${MAX_FAILED_ATTEMPTS}
          returning failed_attempts
        `;
  if (!global[0]) return { ok: false, error: LOCKED_ERROR, status: 423 };
  const clientLeft = MAX_FAILED_ATTEMPTS_PER_CLIENT - client[0].failures;
  const globalLeft = MAX_FAILED_ATTEMPTS - global[0].failed_attempts;
  if (globalLeft <= 0) return { ok: false, error: LOCKED_ERROR, status: 423, remainingAttempts: 0 };
  if (clientLeft <= 0) return { ok: false, error: CLIENT_LOCKED_ERROR, status: 429, remainingAttempts: 0 };
  return {
    ok: false,
    error: "Incorrect password.",
    status: 401,
    remainingAttempts: Math.min(clientLeft, globalLeft),
  };
}

/** Issue a fresh ticket. Only its hash is stored; it carries its own fetch budget. */
async function issueGrant(tx: Sql, batchId: string, files: UnlockFile[]): Promise<string> {
  const ticket = randomBytes(16).toString("hex");
  const chunks = files.reduce((sum, file) => sum + Math.max(1, file.chunkCount), 0);
  const fetchLimit = GRANT_FETCH_FACTOR * chunks + GRANT_FETCH_SLACK;
  const expires = new Date(Date.now() + GRANT_TTL_MS).toISOString();
  await tx`
    insert into batch_grants (token_hash, batch_id, expires_at, fetch_limit)
    values (${sha256Hex(ticket)}, ${batchId}, ${expires}::timestamptz, ${fetchLimit})
  `;
  return ticket;
}

export async function unlockBatch(
  id: string,
  verifierHex: string,
  clientIp: string | null,
): Promise<UnlockResult> {
  if (!isHex(id, 32)) return { ok: false, error: GONE_ERROR, status: 404 };
  if (!isHex(verifierHex, 64)) return { ok: false, error: "Incorrect password.", status: 401 };
  const clientKey = clientKeyFor(clientIp) ?? UNATTRIBUTED;

  const sql = await getSql();
  const exists = await sql<{ n: number }>`select count(*)::float8 as n from sealed_batches where id = ${id}`;
  if (asNumber(exists[0]?.n) === 0) return unlockLegacyFile(id, verifierHex, clientKey);

  // The whole check runs with the seal's row locked, so parallel guesses are
  // checked one at a time against the attempt budgets they are counted in.
  return sql.transaction(async (tx): Promise<UnlockResult> => {
    const batches = await tx<BatchRow>`
      select id, salt_auth, auth_hash, salt_enc, expires_at::text as expires_at,
             max_downloads, download_count, failed_attempts
      from sealed_batches
      where id = ${id} and expires_at > now()
      for update
    `;
    const batch = batches[0];
    if (!batch) return { ok: false, error: GONE_ERROR, status: 404 };
    if (isExpired(toIso(batch.expires_at))) return { ok: false, error: GONE_ERROR, status: 404 };
    if (remainingOf(batch) <= 0 && !(await hasLiveGrant(tx, id))) {
      return { ok: false, error: GONE_ERROR, status: 404 };
    }
    if (batch.failed_attempts >= MAX_FAILED_ATTEMPTS) {
      return { ok: false, error: LOCKED_ERROR, status: 423 };
    }
    if ((await clientFailures(tx, id, clientKey)) >= MAX_FAILED_ATTEMPTS_PER_CLIENT) {
      return { ok: false, error: CLIENT_LOCKED_ERROR, status: 429, remainingAttempts: 0 };
    }
    if (!verifierMatches(verifierHex, batch.auth_hash)) {
      return recordFailedUnlock(tx, "batch", id, clientKey);
    }

    const claimed = await tx<{ download_count: number; max_downloads: number }>`
      update sealed_batches
      set download_count = download_count + 1
      where id = ${id}
        and download_count < max_downloads
        and expires_at > now()
        and failed_attempts < ${MAX_FAILED_ATTEMPTS}
      returning download_count, max_downloads
    `;
    const claim = claimed[0];
    if (!claim) {
      const current = await tx<{ failed_attempts: number }>`
        select failed_attempts from sealed_batches where id = ${id}
      `;
      if ((current[0]?.failed_attempts ?? 0) >= MAX_FAILED_ATTEMPTS) {
        return { ok: false, error: LOCKED_ERROR, status: 423 };
      }
      return { ok: false, error: GONE_ERROR, status: 404 };
    }
    const rows = await tx<FileRow>`
      select id, chunk_count, cipher_bytes, file_nonce, name_iv, name_ct, mime_iv, mime_ct,
             original_name, mime_type, size_bytes, iv, file_index, aad_version
      from sealed_files
      where batch_id = ${id}
      order by file_index nulls last, id
    `;
    const files = rows.map(presentFile);
    const ticket = await issueGrant(tx, id, files);
    const remainingAfter = Math.max(0, claim.max_downloads - claim.download_count);
    return {
      ok: true,
      ticket,
      remainingAfter,
      lastAccess: remainingAfter <= 0,
      saltEnc: batch.salt_enc,
      files,
    };
  });
}

async function unlockLegacyFile(id: string, verifierHex: string, clientKey: string): Promise<UnlockResult> {
  const sql = await getSql();
  return sql.transaction(async (tx): Promise<UnlockResult> => {
    const rows = await tx<FileRow>`
      select id, batch_id, original_name, mime_type, size_bytes, ciphertext, salt_enc, iv,
             salt_auth, auth_hash, expires_at::text as expires_at, max_downloads,
             download_count, failed_attempts, cipher_bytes, chunk_count, file_nonce,
             name_iv, name_ct, mime_iv, mime_ct, file_index, aad_version
      from sealed_files
      where id = ${id} and batch_id is null
      for update
    `;
    const row = rows[0];
    if (!row) return { ok: false, error: GONE_ERROR, status: 404 };
    if (isExpired(toIso(row.expires_at)) || remainingOf(row) <= 0) {
      return { ok: false, error: GONE_ERROR, status: 404 };
    }
    if (row.failed_attempts >= MAX_FAILED_ATTEMPTS) {
      return { ok: false, error: LOCKED_ERROR, status: 423 };
    }
    if ((await clientFailures(tx, id, clientKey)) >= MAX_FAILED_ATTEMPTS_PER_CLIENT) {
      return { ok: false, error: CLIENT_LOCKED_ERROR, status: 429, remainingAttempts: 0 };
    }
    if (!verifierMatches(verifierHex, row.auth_hash)) {
      return recordFailedUnlock(tx, "legacy", id, clientKey);
    }

    const claimed = await tx<{ download_count: number; max_downloads: number }>`
      update sealed_files
      set download_count = download_count + 1
      where id = ${id}
        and download_count < max_downloads
        and expires_at > now()
        and failed_attempts < ${MAX_FAILED_ATTEMPTS}
      returning download_count, max_downloads
    `;
    const claim = claimed[0];
    if (!claim) return { ok: false, error: GONE_ERROR, status: 404 };
    const remainingAfter = Math.max(0, claim.max_downloads - claim.download_count);
    await tx`
      insert into sealed_batches (
        id, salt_auth, auth_hash, salt_enc, expires_at, max_downloads,
        download_count, failed_attempts
      ) values (
        ${id}, ${row.salt_auth}, ${row.auth_hash}, ${row.salt_enc},
        ${toIso(row.expires_at)}::timestamptz, ${row.max_downloads},
        ${claim.download_count}, ${row.failed_attempts}
      )
      on conflict (id) do update set
        download_count = excluded.download_count,
        failed_attempts = excluded.failed_attempts
    `;
    await tx`update sealed_files set batch_id = ${id} where id = ${id}`;
    const files = [presentFile(row)];
    const ticket = await issueGrant(tx, id, files);
    return {
      ok: true,
      ticket,
      remainingAfter,
      lastAccess: remainingAfter <= 0,
      saltEnc: row.salt_enc,
      files,
    };
  });
}

export type FetchResult =
  | { ok: true; chunk: Buffer; iv: string; last: boolean }
  | { ok: false; error: string; status: number };

export async function fetchFileChunk(
  ticket: string,
  fileId: string,
  chunkIndex: number,
): Promise<FetchResult> {
  if (!isHex(ticket, 32) || !isHex(fileId, 32)) {
    return { ok: false, error: GONE_ERROR, status: 404 };
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= MAX_FETCH_CHUNK_INDEX) {
    return { ok: false, error: "Invalid chunk.", status: 400 };
  }
  const sql = await getSql();
  // Each fetch spends one unit of this unlock's budget, and only while both
  // the ticket and the seal are unexpired.
  const grants = await sql<{ batch_id: string }>`
    update batch_grants g
    set fetches = g.fetches + 1
    from sealed_batches b
    where g.token_hash = ${sha256Hex(ticket)}
      and b.id = g.batch_id
      and g.expires_at > now()
      and b.expires_at > now()
      and g.fetches < g.fetch_limit
    returning g.batch_id
  `;
  const batchId = grants[0]?.batch_id;
  if (!batchId) {
    return { ok: false, error: "This session expired. Unlock again.", status: 401 };
  }

  const chunks = await sql<{ iv: string; payload: unknown; chunk_count: number | null }>`
    select c.iv, c.payload, f.chunk_count
    from sealed_file_chunks c
    join sealed_files f on f.id = c.file_id
    where c.file_id = ${fileId}
      and c.chunk_index = ${chunkIndex}
      and f.batch_id = ${batchId}
  `;
  const chunk = chunks[0];
  if (chunk) {
    const bytes = asBytes(chunk.payload);
    const count = chunk.chunk_count ?? 0;
    return {
      ok: true,
      chunk: bytes,
      iv: chunk.iv,
      last: count > 0 ? chunkIndex + 1 >= count : false,
    };
  }

  const files = await sql<Pick<FileRow, "id" | "ciphertext" | "iv">>`
    select id, ciphertext, iv from sealed_files
    where id = ${fileId} and batch_id = ${batchId}
  `;
  const file = files[0];
  if (!file?.ciphertext || !file.iv) {
    return { ok: false, error: GONE_ERROR, status: 404 };
  }
  const raw = Buffer.from(file.ciphertext, "base64");
  const start = chunkIndex * CHUNK_BYTES;
  if (start >= raw.length) return { ok: false, error: "Invalid chunk.", status: 400 };
  const end = Math.min(raw.length, start + CHUNK_BYTES);
  return { ok: true, chunk: raw.subarray(start, end), iv: file.iv, last: end >= raw.length };
}
