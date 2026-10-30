import { createFileRoute } from "@tanstack/react-router";
import {
  cancelUpload,
  finishUpload,
  startUploadSession,
  storeChunk,
  type FinishFile,
  type FinishInput,
} from "@/lib/vault.server";
import {
  MAX_BATCH_FILES,
  MAX_CHUNK_FORM_BODY_BYTES,
  MAX_SEAL_JSON_BODY_BYTES,
} from "@/lib/constants";

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

function asInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : NaN;
}

function isJsonContentType(value: string): boolean {
  return /^application\/json(?:\s*;|$)/i.test(value.trim());
}

function clientIp(request: Request): string | null {
  const raw =
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (!raw || raw.length > 45 || !/^[0-9a-fA-F:.]+$/.test(raw)) return null;
  return raw;
}

function bodyTooLarge(request: Request, maxBytes: number): boolean {
  const raw = request.headers.get("content-length");
  if (!raw) return false;
  const bytes = Number.parseInt(raw, 10);
  return Number.isFinite(bytes) && bytes > maxBytes;
}

async function readBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (bodyTooLarge(request, maxBytes)) throw new Error("Request body is too large.");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Request body is too large.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function requestFromBytes(request: Request, body: Uint8Array): Request {
  const buffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  return new Request(request.url, { method: request.method, headers: request.headers, body: buffer });
}

export const Route = createFileRoute("/api/seal")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const contentType = request.headers.get("content-type") || "";
        try {
          if (isJsonContentType(contentType)) {
            const body = JSON.parse(new TextDecoder().decode(await readBodyBytes(request, MAX_SEAL_JSON_BODY_BYTES))) as Record<string, unknown>;
            if (body.intent === "start") {
              return Response.json(await startUploadSession(clientIp(request)), {
                headers: { "Cache-Control": "no-store" },
              });
            }
            if (body.intent === "cancel") {
              await cancelUpload(String(body.uploadId ?? ""));
              return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
            }
            if (body.intent === "finish") {
              const files = Array.isArray(body.files) ? body.files : [];
              if (files.length > MAX_BATCH_FILES) {
                return Response.json({ error: `A batch can hold ${MAX_BATCH_FILES} files.` }, { status: 400 });
              }
              const input: FinishInput = {
                uploadId: String(body.uploadId ?? ""),
                saltAuth: String(body.saltAuth ?? ""),
                saltEnc: String(body.saltEnc ?? ""),
                authHash: String(body.authHash ?? ""),
                expiresAt: String(body.expiresAt ?? ""),
                maxDownloads: asInt(body.maxDownloads),
                files: files.map((entry) => {
                  const file = (entry ?? {}) as Record<string, unknown>;
                  const mapped: FinishFile = {
                    fileIndex: asInt(file.fileIndex),
                    fileNonce: String(file.fileNonce ?? ""),
                    nameIv: String(file.nameIv ?? ""),
                    nameCt: String(file.nameCt ?? ""),
                    mimeIv: String(file.mimeIv ?? ""),
                    mimeCt: String(file.mimeCt ?? ""),
                    chunkCount: asInt(file.chunkCount),
                  };
                  return mapped;
                }),
              };
              const result = await finishUpload(input);
              return Response.json(result, { headers: { "Cache-Control": "no-store" } });
            }
            return Response.json({ error: "Unknown action." }, { status: 400 });
          }

          const form = await requestFromBytes(request, await readBodyBytes(request, MAX_CHUNK_FORM_BODY_BYTES)).formData();
          if (asString(form.get("intent")) !== "chunk") {
            return Response.json({ error: "Unknown action." }, { status: 400 });
          }
          const blob = form.get("chunk");
          if (typeof blob === "string" || !blob || typeof (blob as Blob).arrayBuffer !== "function") {
            return Response.json({ error: "Missing chunk." }, { status: 400 });
          }
          await storeChunk({
            uploadId: asString(form.get("uploadId")),
            fileIndex: asInt(asString(form.get("fileIndex"))),
            chunkIndex: asInt(asString(form.get("chunkIndex"))),
            iv: asString(form.get("iv")),
            payload: Buffer.from(await (blob as Blob).arrayBuffer()),
          });
          return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Could not seal the files.";
          return Response.json({ error: message }, { status: message === "Request body is too large." ? 413 : 400 });
        }
      },
    },
  },
});
