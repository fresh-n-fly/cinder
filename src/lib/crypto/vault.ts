import { MIN_PASSWORD_LENGTH, PBKDF2_ITERATIONS } from "@/lib/constants";

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
  if (hex.length % 2 !== 0) throw new Error("Invalid hex");
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

export async function deriveVerifierHex(password: string, saltHex: string): Promise<string> {
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

export type SealedPayload = {
  ciphertext: ArrayBuffer;
  saltEnc: string;
  iv: string;
  saltAuth: string;
  authHash: string;
};

export async function sealFile(
  plaintext: ArrayBuffer,
  password: string,
  aad: string,
): Promise<SealedPayload> {
  const saltEnc = randomBytes(16);
  const saltAuth = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveAesKey(password, saltEnc);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: encoder.encode(aad),
    },
    key,
    plaintext,
  );
  const verifierHex = await deriveVerifierHex(password, bytesToHex(saltAuth));
  const authHash = await hashVerifierHex(verifierHex);
  zeroBytes(new Uint8Array(plaintext));
  return {
    ciphertext,
    saltEnc: bytesToHex(saltEnc),
    iv: bytesToHex(iv),
    saltAuth: bytesToHex(saltAuth),
    authHash,
  };
}

export type BatchKeys = {
  key: CryptoKey;
  saltEnc: string;
  saltAuth: string;
  authHash: string;
};

export async function createBatchKeys(password: string): Promise<BatchKeys> {
  const saltEnc = randomBytes(16);
  const saltAuth = randomBytes(16);
  const key = await deriveAesKey(password, saltEnc);
  const saltAuthHex = bytesToHex(saltAuth);
  const authHash = await hashVerifierHex(await deriveVerifierHex(password, saltAuthHex));
  return {
    key,
    saltEnc: bytesToHex(saltEnc),
    saltAuth: saltAuthHex,
    authHash,
  };
}

export function randomHex(byteLength: number): string {
  return bytesToHex(randomBytes(byteLength));
}

export async function deriveBatchKey(password: string, saltEncHex: string): Promise<CryptoKey> {
  return deriveAesKey(password, hexToBytes(saltEncHex));
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

export async function unsealFile(
  ciphertext: ArrayBuffer,
  password: string,
  saltEnc: string,
  iv: string,
  aad: string,
): Promise<ArrayBuffer> {
  const key = await deriveAesKey(password, hexToBytes(saltEnc));
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

export function generatePassphrase(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const specials = "!@#$%&*?";
  const all = `${letters}${digits}${specials}`;
  const length = 16;
  const bytes = randomBytes(length + 2);
  const chars: string[] = [];
  for (let i = 0; i < length; i += 1) {
    chars.push(all[bytes[i]! % all.length]!);
  }
  chars[0] = digits[bytes[length]! % digits.length]!;
  chars[1] = specials[bytes[length + 1]! % specials.length]!;
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = bytes[i]! % (i + 1);
    const swap = chars[i]!;
    chars[i] = chars[j]!;
    chars[j] = swap;
  }
  return chars.join("");
}

export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (!/\d/.test(password)) return "Password must include a number.";
  if (!/[^A-Za-z0-9]/.test(password)) return "Password must include a special character.";
  return null;
}

export function passwordScore(password: string): 0 | 1 | 2 | 3 | 4 {
  if (!password) return 0;
  if (validatePassword(password)) return 1;
  let score = 2;
  if (password.length >= 16) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  return Math.min(score, 4) as 0 | 1 | 2 | 3 | 4;
}
