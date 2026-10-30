import { createFileRoute } from "@tanstack/react-router";
import { fetchFileChunk, unlockBatch } from "@/lib/vault.server";

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

function asInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : NaN;
}

function clientIp(request: Request): string | null {
  const raw =
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (!raw || raw.length > 45 || !/^[0-9a-fA-F:.]+$/.test(raw)) return null;
  return raw;
}

export const Route = createFileRoute("/api/open")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const contentType = request.headers.get("content-type") || "";
        try {
          if (contentType.includes("application/json")) {
            const body = (await request.json()) as Record<string, unknown>;
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

          const form = await request.formData();
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
          return Response.json({ error: message }, { status: 400 });
        }
      },
    },
  },
});
