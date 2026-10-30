import { SEAL_FORMAT } from "@/lib/constants";

async function readError(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  return payload.error || "Upload failed.";
}

/** How long an upload request keeps retrying while the server is busy. */
const UPLOAD_RETRY_MS = 10 * 60 * 1000;
/** Downloads give up sooner; the ticket lasts 15 minutes. */
const DOWNLOAD_RETRY_MS = 2 * 60 * 1000;

/**
 * POST to the API, retrying while the server says it is busy (503) or rate
 * limited (429), until `deadlineMs` has passed. Upload requests wait only
 * briefly for the quota lock on the server, so a long finish elsewhere is
 * answered with 503 and retried here. A 503 is sent only when nothing was
 * written or charged, so retrying is safe.
 */
async function post(url: string, init: RequestInit, deadlineMs: number): Promise<Response> {
  const giveUpAt = Date.now() + deadlineMs;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { method: "POST", ...init });
    if (response.status !== 503 && response.status !== 429) return response;
    const hinted = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
    const wait = Math.min(10_000, Number.isFinite(hinted) && hinted > 0 ? hinted * 1000 : 1000 * 2 ** Math.min(attempt, 3));
    if (Date.now() + wait > giveUpAt) return response;
    await response.body?.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

export async function startUpload(): Promise<string> {
  const response = await post(
    "/api/seal",
    { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent: "start", format: SEAL_FORMAT }) },
    UPLOAD_RETRY_MS,
  );
  const payload = (await response.json()) as { uploadId?: string; error?: string };
  if (!response.ok || !payload.uploadId) throw new Error(payload.error || "Could not start upload.");
  return payload.uploadId;
}

export async function cancelUpload(uploadId: string): Promise<void> {
  await fetch("/api/seal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intent: "cancel", uploadId }),
  });
}

export async function putCipherChunk(
  uploadId: string,
  fileIndex: number,
  chunkIndex: number,
  iv: string,
  ciphertext: ArrayBuffer,
): Promise<void> {
  const form = new FormData();
  form.set("intent", "chunk");
  form.set("uploadId", uploadId);
  form.set("fileIndex", String(fileIndex));
  form.set("chunkIndex", String(chunkIndex));
  form.set("iv", iv);
  form.set("chunk", new Blob([ciphertext], { type: "application/octet-stream" }));
  const response = await post("/api/seal", { body: form }, UPLOAD_RETRY_MS);
  if (!response.ok) throw new Error(await readError(response));
}

export async function finishUpload(body: {
  uploadId: string;
  format: number;
  saltAuth: string;
  saltEnc: string;
  authHash: string;
  expiresAt: string;
  maxDownloads: number;
  files: {
    fileIndex: number;
    fileNonce: string;
    nameIv: string;
    nameCt: string;
    mimeIv: string;
    mimeCt: string;
    chunkCount: number;
  }[];
}): Promise<{ id: string }> {
  const response = await post(
    "/api/seal",
    { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent: "finish", ...body }) },
    UPLOAD_RETRY_MS,
  );
  const payload = (await response.json()) as { id?: string; error?: string };
  if (!response.ok || !payload.id) throw new Error(payload.error || "Could not seal the files.");
  return { id: payload.id };
}

export async function pullCipherChunk(
  ticket: string,
  fileId: string,
  chunkIndex: number,
): Promise<{ iv: string; bytes: ArrayBuffer }> {
  const form = new FormData();
  form.set("intent", "chunk");
  form.set("ticket", ticket);
  form.set("fileId", fileId);
  form.set("chunkIndex", String(chunkIndex));
  const response = await post("/api/open", { body: form }, DOWNLOAD_RETRY_MS);
  if (!response.ok) throw new Error(await readError(response));
  const iv = response.headers.get("X-Chunk-Iv") ?? "";
  if (!iv) throw new Error("Could not download this piece.");
  return { iv, bytes: await response.arrayBuffer() };
}

export async function pullCiphertextChunks(
  ticket: string,
  fileId: string,
  chunkCount: number,
): Promise<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let index = 0; index < chunkCount; index += 1) {
    const form = new FormData();
    form.set("intent", "chunk");
    form.set("ticket", ticket);
    form.set("fileId", fileId);
    form.set("chunkIndex", String(index));
    const response = await post("/api/open", { body: form }, DOWNLOAD_RETRY_MS);
    if (!response.ok) throw new Error(await readError(response));
    const part = new Uint8Array(await response.arrayBuffer());
    parts.push(part);
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out.buffer;
}
