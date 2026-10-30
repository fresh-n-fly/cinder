export const APP_NAME = "Cinder";
export const APP_TAGLINE = "Files that vanish.";

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

/**
 * Plaintext cap for one sealed batch. It is also one client's share of the
 * store, so filling the whole service takes several distinct networks.
 */
export const MAX_BATCH_BYTES = 5 * GiB;
/** Approximate disk cap for everything stored on the service at once. */
export const MAX_STORE_BYTES = 20 * GiB;
export const MAX_BATCH_FILES = 100;
/**
 * Legacy seals stored one ciphertext blob and are downloaded in slices of this
 * size. Do not change it; existing blobs were not saved with a chunk count.
 */
export const CHUNK_BYTES = 2 * MiB;
/** New seals encrypt and upload one plaintext slice at a time. */
export const CHUNK_PLAIN_BYTES = 4 * MiB;
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
/**
 * Highest piece index a download may ask for. Seals made under the earlier
 * 10 GiB cap (and legacy 2 MiB slices) stay downloadable until they expire.
 */
export const MAX_FETCH_CHUNK_INDEX = Math.ceil((10 * GiB) / CHUNK_BYTES);

/** Encryption format written by current clients (binds counts and positions). */
export const AAD_VERSION = 2;

export const MAX_ACTIVE_UPLOADS_PER_IP = 5;
/** One client network's share: one full seal plus row overhead. */
export const MAX_CLIENT_LOGICAL_BYTES = MAX_BATCH_BYTES + 64 * MiB;
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

/** An upload with no chunks yet is dropped after this long. */
export const EMPTY_UPLOAD_TTL_MS = 5 * 60 * 1000;
/** An upload that stops receiving chunks is dropped after this long. */
export const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
/** Hard ceiling on one upload, however often it is kept alive. */
export const MAX_UPLOAD_LIFETIME_MS = 12 * 60 * 60 * 1000;

export const GRANT_TTL_MS = 15 * 60 * 1000;
/** Chunk fetches allowed per unlock: every chunk this many times, plus slack. */
export const GRANT_FETCH_FACTOR = 2;
export const GRANT_FETCH_SLACK = 8;

export const MIN_PASSWORD_LENGTH = 12;
export const PBKDF2_ITERATIONS = 210_000;
export const MAX_DOWNLOADS = 100;
export const MIN_DOWNLOADS = 1;
/** Wrong passwords a seal accepts over its whole life before it locks. */
export const MAX_FAILED_ATTEMPTS = 30;
/** Of those, how many one client network can spend. */
export const MAX_FAILED_ATTEMPTS_PER_CLIENT = 5;
export const MIN_TTL_MS = 15 * 60 * 1000;
export const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
