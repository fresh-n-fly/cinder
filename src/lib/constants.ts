export const APP_NAME = "Cinder";
export const APP_TAGLINE = "Files that vanish.";

/** Plaintext cap for one sealed batch. */
export const MAX_BATCH_BYTES = 10 * 1024 * 1024 * 1024;
/** Approximate disk cap for everything stored on the service at once. */
export const MAX_STORE_BYTES = 20 * 1024 * 1024 * 1024;
export const MAX_BATCH_FILES = 100;
/**
 * Legacy seals stored one ciphertext blob and are downloaded in slices of this
 * size. Do not change it; existing blobs were not saved with a chunk count.
 */
export const CHUNK_BYTES = 2 * 1024 * 1024;
/** New seals encrypt and upload one plaintext slice at a time. */
export const CHUNK_PLAIN_BYTES = 4 * 1024 * 1024;
export const GCM_TAG_BYTES = 16;
export const MAX_CHUNK_BYTES = CHUNK_PLAIN_BYTES + GCM_TAG_BYTES;
/**
 * Names and types are padded before they are locked so the ciphertext length
 * does not reveal how long they were. Two bytes hold the real length.
 */
export const NAME_PAD_BYTES = 1024;
export const MIME_PAD_BYTES = 128;
export const MAX_CHUNKS_PER_FILE = Math.ceil(MAX_BATCH_BYTES / CHUNK_PLAIN_BYTES);
export const MAX_CHUNKS_TOTAL = MAX_CHUNKS_PER_FILE + MAX_BATCH_FILES;
export const MAX_ACTIVE_UPLOADS_PER_IP = 5;
export const MAX_EMPTY_UPLOADS = 1000;
export const MAX_PENDING_CHUNKS = MAX_CHUNKS_TOTAL * 10;
export const MAX_PENDING_CHUNKS_PER_IP = MAX_CHUNKS_TOTAL;
export const MAX_CLIENT_LOGICAL_BYTES = 12 * 1024 * 1024 * 1024;
export const MAX_CLIENT_STORED_CHUNKS = 5_000;
export const MAX_CLIENT_STORED_BATCHES = 100;
export const ESTIMATED_CHUNK_ROW_OVERHEAD_BYTES = 8 * 1024;
export const ESTIMATED_FILE_ROW_OVERHEAD_BYTES = 4 * 1024;
export const ESTIMATED_BATCH_ROW_OVERHEAD_BYTES = 2 * 1024;
export const ESTIMATED_SESSION_ROW_OVERHEAD_BYTES = 1024;
export const MAX_SEAL_JSON_BODY_BYTES = 512 * 1024;
export const MAX_OPEN_JSON_BODY_BYTES = 4 * 1024;
export const MAX_OPEN_FORM_BODY_BYTES = 16 * 1024;
export const MAX_CHUNK_FORM_BODY_BYTES = MAX_CHUNK_BYTES + 64 * 1024;
export const EMPTY_UPLOAD_TTL_MS = 5 * 60 * 1000;
export const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
export const GRANT_TTL_MS = 15 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 12;
export const PBKDF2_ITERATIONS = 210_000;
export const MAX_DOWNLOADS = 100;
export const MIN_DOWNLOADS = 1;
export const MAX_FAILED_ATTEMPTS = 12;
export const MIN_TTL_MS = 15 * 60 * 1000;
export const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
