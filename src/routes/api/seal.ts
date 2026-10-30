import { createFileRoute } from "@tanstack/react-router";
import {
  cancelUpload,
  finishUpload,
  startUploadSession,
  storeChunk,
  type FinishFile,
  type FinishInput,
} from "@/lib/vault.server";

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

export const Route = createFileRoute("/api/seal")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const contentType = request.headers.get("content-type") || "";
        try {
          if (isJsonContentType(contentType)) {
            const body = (await request.json()) as Record<string, unknown>;
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

          const form = await request.formData();
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
          return Response.json({ error: message }, { status: 400 });
        }
      },
    },
  },
});
