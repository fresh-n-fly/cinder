import { createFileRoute } from "@tanstack/react-router";
import { fetchFileChunk, unlockBatch } from "@/lib/vault.server";
import { MAX_OPEN_FORM_BODY_BYTES, MAX_OPEN_JSON_BODY_BYTES } from "@/lib/constants";

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

export const Route = createFileRoute("/api/open")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const contentType = request.headers.get("content-type") || "";
        try {
          if (isJsonContentType(contentType)) {
            const body = JSON.parse(new TextDecoder().decode(await readBodyBytes(request, MAX_OPEN_JSON_BODY_BYTES))) as Record<string, unknown>;
            if (body.intent !== "unlock") {
              return Response.json({ error: "Unknown action." }, { status: 400 });
            }
            const result = await unlockBatch(String(body.id ?? ""), String(body.verifier ?? ""));
            if (!result.ok) {
              const ip = clientIp(request);
              if (ip && result.remainingAttempts !== undefined) {
                console.warn(`[cinder] unlock_failed ip=${ip} remaining=${result.remainingAttempts}`);
              }
              return Response.json(
                { error: result.error, remainingAttempts: result.remainingAttempts },
                { status: result.status, headers: { "Cache-Control": "no-store" } },
              );
            }
            return Response.json(
              {
                ticket: result.ticket,
                remainingAfter: result.remainingAfter,
                lastAccess: result.lastAccess,
                saltEnc: result.saltEnc,
                files: result.files,
              },
              { headers: { "Cache-Control": "no-store" } },
            );
          }

          const form = await requestFromBytes(request, await readBodyBytes(request, MAX_OPEN_FORM_BODY_BYTES)).formData();
          if (asString(form.get("intent")) !== "chunk") {
            return Response.json({ error: "Unknown action." }, { status: 400 });
          }
          const result = await fetchFileChunk(
            asString(form.get("ticket")),
            asString(form.get("fileId")),
            asInt(asString(form.get("chunkIndex"))),
          );
          if (!result.ok) {
            return Response.json(
              { error: result.error },
              { status: result.status, headers: { "Cache-Control": "no-store" } },
            );
          }
          return new Response(new Uint8Array(result.chunk), {
            status: 200,
            headers: {
              "Content-Type": "application/octet-stream",
              "Cache-Control": "no-store",
              "X-Chunk-Iv": result.iv,
              "X-Last-Chunk": result.last ? "1" : "0",
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Could not open the file.";
          return Response.json({ error: message }, { status: message === "Request body is too large." ? 413 : 400 });
        }
      },
    },
  },
});
