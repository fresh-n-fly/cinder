import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  CHUNK_BYTES,
  GCM_TAG_BYTES,
  GRANT_TTL_MS,
  MAX_BATCH_FILES,
  MAX_CHUNKS_PER_FILE,
  MAX_CHUNKS_TOTAL,
  MAX_CHUNK_BYTES,
  MAX_DOWNLOADS,
  MAX_FAILED_ATTEMPTS,
  MAX_STORE_BYTES,
  MAX_TTL_MS,
  MIME_PAD_BYTES,
  MIN_DOWNLOADS,
  MIN_TTL_MS,
  NAME_PAD_BYTES,
} from "@/lib/constants";
import { chunkCountFor } from "@/lib/files";
import { getSql, type Sql } from "@/lib/db";
import { SECRET_TABLES, wipeAbandonedUploads, wipeBatch, wipeFile, wipeUpload } from "../../scripts/wipe.mjs";

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
  grant_token: string | null;
  grant_expires_at: string | null;
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
};

const ROOM_ERROR =
  "There is not enough room. Everything stored here can total 10 GB.";

function sha256Bytes(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
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

function grantExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return true;
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

async function storedBytes(sql: Sql): Promise<number> {
  const rows = await sql<{ total: number }>`
    select (
      coalesce((select sum(octet_length(payload)) from sealed_file_chunks), 0)
      + coalesce((select sum(octet_length(payload_bin)) from upload_chunks), 0)
      + coalesce((select sum(octet_length(payload)) from upload_chunks where payload <> ''), 0)
      + coalesce((select sum(cipher_bytes) from sealed_files where cipher_bytes > 0), 0)
      + coalesce((
          select sum(octet_length(ciphertext)) from sealed_files
          where coalesce(cipher_bytes, 0) = 0 and ciphertext is not null and ciphertext <> ''
        ), 0)
    )::float8 as total
  `;
  return asNumber(rows[0]?.total);
}

type Query = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

function asQuery(sql: Sql): Query {
  return (text, params = []) => sql.query(text, params);
}

const secretTables = new Set<string>(SECRET_TABLES);
let vacuumChain: Promise<void> = Promise.resolve();

// VACUUM FULL rewrites the table into a new file that contains only live rows.
// Plain VACUUM leaves the deleted bytes in the free space of the old pages.
// The rewrite takes an exclusive lock, so it runs only after a real delete,
// and only one rewrite proceeds at a time. A failure here must not fail the
// request: the rows are already overwritten and deleted.
async function vacuumTables(sql: Sql, tables: readonly string[]): Promise<void> {
  const unique = [...new Set(tables)].filter((table) => secretTables.has(table));
  if (unique.length === 0) return;
  const run = async () => {
    for (const table of unique) {
      try {
        await sql.query(`VACUUM FULL ${table}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[cinder] VACUUM FULL ${table} failed: ${message}`);
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
  const query = asQuery(sql);
  const uploads = await wipeAbandonedUploads(query);
  const tables: string[] = [];
  if (uploads > 0) tables.push("upload_chunks");

  const batches = await sql<{ id: string }>`
    select id from sealed_batches
    where expires_at <= now()
       or (
         download_count >= max_downloads
         and (grant_expires_at is null or grant_expires_at <= now())
       )
    limit 50
  `;
  let seals = 0;
  for (const row of batches) {
    seals += await wipeBatch(query, row.id);
  }

  const legacy = await sql<{ id: string }>`
    select id from sealed_files
    where batch_id is null
      and (expires_at <= now() or download_count >= max_downloads)
    limit 50
  `;
  for (const row of legacy) {
    seals += await wipeFile(query, row.id);
  }
  if (seals > 0) tables.push("sealed_file_chunks", "sealed_files", "sealed_batches");
  if (tables.length > 0) await vacuumTables(sql, tables);
}

export async function destroyFile(id: string): Promise<void> {
  const sql = await getSql();
  const removed = await wipeFile(asQuery(sql), id);
  if (removed > 0) await vacuumTables(sql, ["sealed_file_chunks", "sealed_files"]);
}

export async function destroyBatch(id: string): Promise<void> {
  const sql = await getSql();
  const removed = await wipeBatch(asQuery(sql), id);
  if (removed > 0) {
    await vacuumTables(sql, ["sealed_file_chunks", "sealed_files", "sealed_batches"]);
  }
}

export async function getBatchMeta(id: string): Promise<BatchMeta | null> {
  await purgeExpired();
  if (!isHex(id, 32)) return null;
  const sql = await getSql();

  const batches = await sql<BatchRow>`
    select id, salt_auth, auth_hash, salt_enc, expires_at::text as expires_at,
           max_downloads, download_count, failed_attempts, grant_token,
           grant_expires_at::text as grant_expires_at
    from sealed_batches
    where id = ${id}
  `;
  const batch = batches[0];
  if (batch) {
    if (isExpired(toIso(batch.expires_at))) {
      await destroyBatch(id);
      return null;
    }
    if (remainingOf(batch) <= 0 && grantExpired(batch.grant_expires_at)) {
      await destroyBatch(id);
      return null;
    }
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
  if (isExpired(toIso(file.expires_at)) || remainingOf(file) <= 0) {
    await destroyFile(id);
    return null;
  }
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

export function startUploadSession(): { uploadId: string } {
  return { uploadId: randomBytes(16).toString("hex") };
}

async function discardUpload(uploadId: string): Promise<void> {
  const sql = await getSql();
  const removed = await wipeUpload(asQuery(sql), uploadId);
  if (removed > 0) await vacuumTables(sql, ["upload_chunks"]);
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
  await purgeExpired();
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
  if (input.payload.length === 0 || input.payload.length > MAX_CHUNK_BYTES) {
    throw new Error("Chunk is too large.");
  }
  const sql = await getSql();
  const existing = await sql<{ n: number }>`
    select count(*)::float8 as n from upload_chunks
    where upload_id = ${input.uploadId}
      and not (file_index = ${input.fileIndex} and chunk_index = ${input.chunkIndex})
  `;
  if (asNumber(existing[0]?.n) >= MAX_CHUNKS_TOTAL) {
    await discardUpload(input.uploadId);
    throw new Error("Invalid chunk.");
  }
  const used = await storedBytes(sql);
  if (used + input.payload.length > MAX_STORE_BYTES) {
    await discardUpload(input.uploadId);
    throw new Error(ROOM_ERROR);
  }
  await sql`
    insert into upload_chunks (upload_id, file_index, chunk_index, payload, iv, payload_bin)
    values (${input.uploadId}, ${input.fileIndex}, ${input.chunkIndex}, '', ${input.iv}, ${input.payload})
    on conflict (upload_id, file_index, chunk_index)
    do update set payload = '', iv = excluded.iv, payload_bin = excluded.payload_bin
  `;
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
    if (!Number.isInteger(file.fileIndex) || seen.has(file.fileIndex)) return "Invalid file list.";
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
  await purgeExpired();
  const sql = await getSql();

  let uploadBytes = 0;
  try {
    for (const file of input.files) {
      const chunks = await sql<{ chunk_index: number; len: number; iv: string }>`
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
        if (len <= 0 || len > MAX_CHUNK_BYTES) throw new Error("Encrypted payload is invalid.");
        uploadBytes += len;
        if (uploadBytes > MAX_STORE_BYTES) throw new Error(ROOM_ERROR);
      }
    }
    if (await storedBytes(sql) > MAX_STORE_BYTES) throw new Error(ROOM_ERROR);
  } catch (err) {
    await discardUpload(input.uploadId);
    throw err;
  }

  const batchId = randomBytes(16).toString("hex");
  const expires = new Date(input.expiresAt).toISOString();
  try {
    await sql`
      insert into sealed_batches (
        id, salt_auth, auth_hash, salt_enc, expires_at, max_downloads
      ) values (
        ${batchId}, ${input.saltAuth}, ${input.authHash}, ${input.saltEnc},
        ${expires}::timestamptz, ${input.maxDownloads}
      )
    `;

    for (const file of input.files) {
      const fileId = randomBytes(16).toString("hex");
      await sql`
        insert into sealed_files (
          id, batch_id, original_name, mime_type, size_bytes, ciphertext,
          salt_enc, iv, salt_auth, auth_hash, expires_at, max_downloads, cipher_bytes,
          file_nonce, name_iv, name_ct, mime_iv, mime_ct, chunk_count
        ) values (
          ${fileId}, ${batchId}, null, null, null, null,
          ${input.saltEnc}, null, ${input.saltAuth}, ${input.authHash},
          ${expires}::timestamptz, ${input.maxDownloads}, 0,
          ${file.fileNonce}, ${file.nameIv}, ${file.nameCt}, ${file.mimeIv}, ${file.mimeCt},
          ${file.chunkCount}
        )
      `;
      await sql`
        insert into sealed_file_chunks (file_id, chunk_index, iv, payload)
        select ${fileId}, chunk_index, iv, payload_bin
        from upload_chunks
        where upload_id = ${input.uploadId} and file_index = ${file.fileIndex}
      `;
    }

    await discardUpload(input.uploadId);
  } catch (err) {
    await destroyBatch(batchId);
    await discardUpload(input.uploadId);
    throw err;
  }
  return { id: batchId };
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
>): UnlockFile {
  const legacy = !file.name_ct;
  return {
    id: file.id,
    chunkCount:
      file.chunk_count && file.chunk_count > 0
        ? file.chunk_count
        : chunkCountFor(file.cipher_bytes ?? 0, CHUNK_BYTES),
    legacy,
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

export async function unlockBatch(id: string, verifierHex: string): Promise<UnlockResult> {
  await purgeExpired();
  if (!isHex(id, 32)) return { ok: false, error: "This file is gone.", status: 404 };
  if (!isHex(verifierHex, 64)) return { ok: false, error: "Incorrect password.", status: 401 };

  const sql = await getSql();
  const batches = await sql<BatchRow>`
    select id, salt_auth, auth_hash, salt_enc, expires_at::text as expires_at,
           max_downloads, download_count, failed_attempts, grant_token,
           grant_expires_at::text as grant_expires_at
    from sealed_batches
    where id = ${id}
  `;
  const batch = batches[0];
  if (batch) {
    if (isExpired(toIso(batch.expires_at))) {
      await destroyBatch(id);
      return { ok: false, error: "This file is gone.", status: 404 };
    }
    if (remainingOf(batch) <= 0 && grantExpired(batch.grant_expires_at)) {
      await destroyBatch(id);
      return { ok: false, error: "This file is gone.", status: 404 };
    }
    if (batch.failed_attempts >= MAX_FAILED_ATTEMPTS) {
      return {
        ok: false,
        error: "This file is locked after too many incorrect passwords.",
        status: 423,
      };
    }
    if (!verifierMatches(verifierHex, batch.auth_hash)) {
      const updated = await sql<{ failed_attempts: number }>`
        update sealed_batches
        set failed_attempts = failed_attempts + 1
        where id = ${id}
        returning failed_attempts
      `;
      const attempts = updated[0]?.failed_attempts ?? batch.failed_attempts + 1;
      const left = Math.max(0, MAX_FAILED_ATTEMPTS - attempts);
      return {
        ok: false,
        error:
          left === 0
            ? "This file is locked after too many incorrect passwords."
            : "Incorrect password.",
        status: left === 0 ? 423 : 401,
        remainingAttempts: left,
      };
    }

    const ticket = randomBytes(16).toString("hex");
    const grantExpires = new Date(Date.now() + GRANT_TTL_MS).toISOString();
    const claimed = await sql<{ download_count: number; max_downloads: number }>`
      update sealed_batches
      set download_count = download_count + 1,
          grant_token = ${ticket},
          grant_expires_at = ${grantExpires}::timestamptz
      where id = ${id}
        and download_count < max_downloads
        and expires_at > now()
      returning download_count, max_downloads
    `;
    const claim = claimed[0];
    if (!claim) {
      await destroyBatch(id);
      return { ok: false, error: "This file is gone.", status: 404 };
    }
    const remainingAfter = Math.max(0, claim.max_downloads - claim.download_count);
    const files = await sql<FileRow>`
      select id, chunk_count, cipher_bytes, file_nonce, name_iv, name_ct, mime_iv, mime_ct,
             original_name, mime_type, size_bytes, iv
      from sealed_files
      where batch_id = ${id}
      order by id
    `;
    return {
      ok: true,
      ticket,
      remainingAfter,
      lastAccess: remainingAfter <= 0,
      saltEnc: batch.salt_enc,
      files: files.map(presentFile),
    };
  }

  return unlockLegacyFile(id, verifierHex);
}

async function unlockLegacyFile(id: string, verifierHex: string): Promise<UnlockResult> {
  const sql = await getSql();
  const rows = await sql<FileRow>`
    select id, batch_id, original_name, mime_type, size_bytes, ciphertext, salt_enc, iv,
           salt_auth, auth_hash, expires_at::text as expires_at, max_downloads,
           download_count, failed_attempts, cipher_bytes, chunk_count, file_nonce,
           name_iv, name_ct, mime_iv, mime_ct
    from sealed_files
    where id = ${id} and batch_id is null
  `;
  const row = rows[0];
  if (!row) return { ok: false, error: "This file is gone.", status: 404 };
  if (isExpired(toIso(row.expires_at)) || remainingOf(row) <= 0) {
    await destroyFile(id);
    return { ok: false, error: "This file is gone.", status: 404 };
  }
  if (row.failed_attempts >= MAX_FAILED_ATTEMPTS) {
    return {
      ok: false,
      error: "This file is locked after too many incorrect passwords.",
      status: 423,
    };
  }
  if (!verifierMatches(verifierHex, row.auth_hash)) {
    const updated = await sql<{ failed_attempts: number }>`
      update sealed_files
      set failed_attempts = failed_attempts + 1
      where id = ${id}
      returning failed_attempts
    `;
    const attempts = updated[0]?.failed_attempts ?? row.failed_attempts + 1;
    const left = Math.max(0, MAX_FAILED_ATTEMPTS - attempts);
    return {
      ok: false,
      error:
        left === 0
          ? "This file is locked after too many incorrect passwords."
          : "Incorrect password.",
      status: left === 0 ? 423 : 401,
      remainingAttempts: left,
    };
  }

  const claimed = await sql<{ download_count: number; max_downloads: number }>`
    update sealed_files
    set download_count = download_count + 1
    where id = ${id}
      and download_count < max_downloads
      and expires_at > now()
    returning download_count, max_downloads
  `;
  const claim = claimed[0];
  if (!claim) {
    await destroyFile(id);
    return { ok: false, error: "This file is gone.", status: 404 };
  }
  const remainingAfter = Math.max(0, claim.max_downloads - claim.download_count);
  const ticket = randomBytes(16).toString("hex");
  await sql`
    insert into sealed_batches (
      id, salt_auth, auth_hash, salt_enc, expires_at, max_downloads,
      download_count, grant_token, grant_expires_at
    ) values (
      ${id}, ${row.salt_auth}, ${row.auth_hash}, ${row.salt_enc},
      ${toIso(row.expires_at)}::timestamptz, ${row.max_downloads},
      ${claim.download_count}, ${ticket}, ${new Date(Date.now() + GRANT_TTL_MS).toISOString()}::timestamptz
    )
    on conflict (id) do update set
      grant_token = excluded.grant_token,
      grant_expires_at = excluded.grant_expires_at,
      download_count = excluded.download_count
  `;
  await sql`update sealed_files set batch_id = ${id} where id = ${id}`;
  return {
    ok: true,
    ticket,
    remainingAfter,
    lastAccess: remainingAfter <= 0,
    saltEnc: row.salt_enc,
    files: [presentFile(row)],
  };
}

export type FetchResult =
  | { ok: true; chunk: Buffer; iv: string; last: boolean }
  | { ok: false; error: string; status: number };

export async function fetchFileChunk(
  ticket: string,
  fileId: string,
  chunkIndex: number,
): Promise<FetchResult> {
  await purgeExpired();
  if (!isHex(ticket, 32) || !isHex(fileId, 32)) {
    return { ok: false, error: "This file is gone.", status: 404 };
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= MAX_CHUNKS_PER_FILE) {
    return { ok: false, error: "Invalid chunk.", status: 400 };
  }
  const sql = await getSql();
  const batches = await sql<BatchRow>`
    select id, salt_auth, auth_hash, salt_enc, expires_at::text as expires_at,
           max_downloads, download_count, failed_attempts, grant_token,
           grant_expires_at::text as grant_expires_at
    from sealed_batches
    where grant_token = ${ticket}
  `;
  const batch = batches[0];
  if (!batch || grantExpired(batch.grant_expires_at)) {
    return { ok: false, error: "This session expired. Unlock again.", status: 401 };
  }

  const chunks = await sql<{ iv: string; payload: unknown; chunk_count: number | null }>`
    select c.iv, c.payload, f.chunk_count
    from sealed_file_chunks c
    join sealed_files f on f.id = c.file_id
    where c.file_id = ${fileId}
      and c.chunk_index = ${chunkIndex}
      and f.batch_id = ${batch.id}
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
    where id = ${fileId} and batch_id = ${batch.id}
  `;
  const file = files[0];
  if (!file?.ciphertext || !file.iv) {
    return { ok: false, error: "This file is gone.", status: 404 };
  }
  const raw = Buffer.from(file.ciphertext, "base64");
  const start = chunkIndex * CHUNK_BYTES;
  if (start >= raw.length) return { ok: false, error: "Invalid chunk.", status: 400 };
  const end = Math.min(raw.length, start + CHUNK_BYTES);
  return { ok: true, chunk: raw.subarray(start, end), iv: file.iv, last: end >= raw.length };
}
