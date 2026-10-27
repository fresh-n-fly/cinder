async function readError(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  return payload.error || "Upload failed.";
}

export async function startUpload(): Promise<string> {
  const response = await fetch("/api/seal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intent: "start" }),
  });
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
  const response = await fetch("/api/seal", { method: "POST", body: form });
  if (!response.ok) throw new Error(await readError(response));
}

export async function finishUpload(body: {
  uploadId: string;
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
  const response = await fetch("/api/seal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intent: "finish", ...body }),
  });
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
  const response = await fetch("/api/open", { method: "POST", body: form });
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
    const response = await fetch("/api/open", { method: "POST", body: form });
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
