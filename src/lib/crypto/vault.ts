import { argon2id } from "hash-wasm";
import {
  ARGON2_ITERATIONS,
  ARGON2_MEMORY_KIB,
  ARGON2_PARALLELISM,
  KDF1_ACCEPTED_UNTIL,
  KDF_VERSION,
  MIN_PASSWORD_BITS,
  MIN_PASSWORD_LENGTH,
  PBKDF2_ITERATIONS,
} from "@/lib/constants";
import { estimatePasswordBits } from "@/lib/crypto/strength";

const encoder = new TextEncoder();

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < view.length; i += 1) {
    out += view[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Error("Invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function importPassword(password: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveKey",
    "deriveBits",
  ]);
}

async function deriveAesKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await importPassword(password);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** A salt as the server must store it: exactly 16 random bytes in hex. */
export function isSaltHex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

const BAD_METADATA = "This seal was changed on the server and cannot be opened safely.";
const KDF1_RETIRED = "This seal uses an old format that is no longer accepted.";

/** Key derivation 1 only (PBKDF2 with a separate proof salt). */
export async function deriveVerifierHex(password: string, saltHex: string): Promise<string> {
  if (!isSaltHex(saltHex)) throw new Error(BAD_METADATA);
  const material = await importPassword(password);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: hexToBytes(saltHex) as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    256,
  );
  return bytesToHex(bits);
}

export async function hashVerifierHex(verifierHex: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", hexToBytes(verifierHex) as BufferSource);
  return bytesToHex(digest);
}

export type BatchKeys = {
  key: CryptoKey;
  saltEnc: string;
  saltAuth: string;
  authHash: string;
};

const HKDF_ENC_INFO = encoder.encode("cinder/kdf2/aes-256-gcm");
const HKDF_PROOF_INFO = encoder.encode("cinder/kdf2/unlock-proof");

/**
 * Key derivation 2. Argon2id (64 MiB, 3 passes) turns the password and the
 * seal's salt into a master secret; HKDF-SHA-256 then derives the AES key and
 * the unlock proof under different labels, so the proof sent to the server
 * never reveals the key, whatever salt the server supplied.
 */
async function deriveKdf2(password: string, saltHex: string): Promise<{ key: CryptoKey; verifierHex: string }> {
  if (!isSaltHex(saltHex)) throw new Error(BAD_METADATA);
  const salt = hexToBytes(saltHex);
  const master = await argon2id({
    password,
    salt,
    parallelism: ARGON2_PARALLELISM,
    iterations: ARGON2_ITERATIONS,
    memorySize: ARGON2_MEMORY_KIB,
    hashLength: 32,
    outputType: "binary",
  });
  let base: CryptoKey;
  try {
    base = await crypto.subtle.importKey("raw", master as BufferSource, "HKDF", false, ["deriveKey", "deriveBits"]);
  } finally {
    zeroBytes(master);
  }
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: HKDF_ENC_INFO as BufferSource },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const proof = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: HKDF_PROOF_INFO as BufferSource },
    base,
    256,
  );
  return { key, verifierHex: bytesToHex(proof) };
}

/** Keys for a new seal (key derivation 2). One salt serves both outputs. */
export async function createBatchKeys(password: string): Promise<BatchKeys> {
  const salt = randomHex(16);
  const { key, verifierHex } = await deriveKdf2(password, salt);
  return {
    key,
    saltEnc: salt,
    saltAuth: salt,
    authHash: await hashVerifierHex(verifierHex),
  };
}

export type PreparedUnlock = {
  /** Fields for the unlock request: a proof for the server to check. */
  body: { verifier2: string } | { proof: string };
  /** Key derivation 2 yields the key up front; version 1 needs the salt from the unlock reply. */
  key: CryptoKey | null;
};

/**
 * Work out what to send to unlock a seal.
 *
 * - Version 2 sends the HKDF proof ("verifier2"), which is unrelated to the key.
 * - Version 1 derived its proof with PBKDF2, the same function as its key, so
 *   a server that set the proof salt equal to the key salt would receive the
 *   key itself. For those seals only SHA-256 of the proof is sent (what the
 *   server stores anyway), which reveals nothing about the key.
 */
export async function prepareUnlock(password: string, kdf: number, saltAuth: string): Promise<PreparedUnlock> {
  if (kdf === KDF_VERSION) {
    const { key, verifierHex } = await deriveKdf2(password, saltAuth);
    return { body: { verifier2: verifierHex }, key };
  }
  if (kdf !== 1) throw new Error(BAD_METADATA);
  if (Date.now() > KDF1_ACCEPTED_UNTIL) throw new Error(KDF1_RETIRED);
  const proof = await hashVerifierHex(await deriveVerifierHex(password, saltAuth));
  return { body: { proof }, key: null };
}

/** Key derivation 1: the AES key comes from the encryption salt returned on unlock. */
export async function deriveKdf1Key(password: string, saltAuth: string, saltEnc: string): Promise<CryptoKey> {
  if (!isSaltHex(saltEnc) || saltEnc === saltAuth) throw new Error(BAD_METADATA);
  return deriveAesKey(password, hexToBytes(saltEnc));
}

export function randomHex(byteLength: number): string {
  return bytesToHex(randomBytes(byteLength));
}

export async function decryptWithKey(
  key: CryptoKey,
  ciphertext: BufferSource,
  iv: string,
  aad: string,
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: hexToBytes(iv) as BufferSource,
      additionalData: encoder.encode(aad),
    },
    key,
    ciphertext,
  );
}

/** Lock a short string to a fixed size so the ciphertext length hides the original. */
export async function encryptPadded(
  key: CryptoKey,
  text: string,
  aad: string,
  padBytes: number,
): Promise<{ iv: string; ciphertextHex: string }> {
  const encoded = encoder.encode(text);
  if (encoded.length > padBytes - 2) throw new Error("That file name or type is too long to seal.");
  const padded = new Uint8Array(padBytes);
  padded[0] = (encoded.length >> 8) & 0xff;
  padded[1] = encoded.length & 0xff;
  padded.set(encoded, 2);
  const sealed = await encryptWithKey(key, padded.buffer, aad);
  zeroBytes(padded);
  return { iv: sealed.iv, ciphertextHex: bytesToHex(sealed.ciphertext) };
}

export async function decryptPadded(
  key: CryptoKey,
  ciphertextHex: string,
  iv: string,
  aad: string,
  padBytes: number,
): Promise<string> {
  const cipherBytes = hexToBytes(ciphertextHex);
  const plain = await decryptWithKey(key, new Uint8Array(cipherBytes), iv, aad);
  const view = new Uint8Array(plain);
  try {
    if (view.length !== padBytes || view.length < 2) throw new Error("Could not read this file.");
    const len = (view[0]! << 8) | view[1]!;
    if (len > view.length - 2) throw new Error("Could not read this file.");
    return new TextDecoder().decode(view.subarray(2, 2 + len));
  } finally {
    zeroBytes(view);
  }
}

export async function encryptWithKey(
  key: CryptoKey,
  plaintext: ArrayBuffer,
  aad: string,
): Promise<{ ciphertext: ArrayBuffer; iv: string }> {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: encoder.encode(aad),
    },
    key,
    plaintext,
  );
  zeroBytes(new Uint8Array(plaintext));
  return { ciphertext, iv: bytesToHex(iv) };
}

export function zeroBytes(bytes: Uint8Array): void {
  bytes.fill(0);
}

/*
 * AES-GCM associated data.
 *
 * Format 1 bound each chunk only to its file and position, so whoever controls
 * the database could lower a file's chunk count or drop a file from a batch
 * and every remaining piece would still decrypt. Format 2 also binds each
 * chunk to its file's chunk count, and each name and type to the file's
 * position and the number of files in the batch. Any of those edits then
 * makes decryption fail instead of producing a shorter file or batch.
 */
export function chunkAad(version: number, fileNonce: string, index: number, chunkCount: number): string {
  return version >= 2 ? `cinder:v2:chunk:${fileNonce}:${index}:${chunkCount}` : `${fileNonce}:${index}`;
}

export function nameAad(version: number, fileNonce: string, fileIndex: number, fileCount: number): string {
  return version >= 2 ? `cinder:v2:name:${fileNonce}:${fileIndex}:${fileCount}` : `${fileNonce}:name`;
}

export function typeAad(version: number, fileNonce: string, fileIndex: number, fileCount: number): string {
  return version >= 2 ? `cinder:v2:type:${fileNonce}:${fileIndex}:${fileCount}` : `${fileNonce}:type`;
}

/** A uniformly random index below `limit`, by rejection sampling. */
function randomIndex(limit: number): number {
  const ceiling = 256 - (256 % limit);
  while (true) {
    const byte = randomBytes(1)[0]!;
    if (byte < ceiling) return byte % limit;
  }
}

/** 16 characters drawn uniformly from 66 (about 96 bits), with a digit and a symbol. */
export function generatePassphrase(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const specials = "!@#$%&*?";
  const all = `${letters}${digits}${specials}`;
  while (true) {
    let out = "";
    for (let i = 0; i < 16; i += 1) out += all[randomIndex(all.length)];
    // Redraw the rare string that happens to look like words or a sequence,
    // so a generated password always clears the strength check with room.
    if (/[2-9]/.test(out) && /[!@#$%&*?]/.test(out) && estimatePasswordBits(out) >= MIN_PASSWORD_BITS + 10) {
      return out;
    }
  }
}

const TOO_GUESSABLE = "That password is too easy to guess. Use a longer phrase of unrelated words, or press Generate.";

export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (estimatePasswordBits(password) < MIN_PASSWORD_BITS) return TOO_GUESSABLE;
  return null;
}

export function passwordScore(password: string): 0 | 1 | 2 | 3 | 4 {
  if (!password) return 0;
  if (password.length < MIN_PASSWORD_LENGTH) return 1;
  const bits = estimatePasswordBits(password);
  if (bits < 35) return 1;
  if (bits < MIN_PASSWORD_BITS) return 2;
  if (bits < 70) return 3;
  return 4;
}
