import { createFileRoute } from "@tanstack/react-router";
import { fetchFileChunk, unlockBatch } from "@/lib/vault.server";
import { MAX_OPEN_FORM_BODY_BYTES, MAX_OPEN_JSON_BODY_BYTES } from "@/lib/constants";
import { clientIp, errorResponse, isJsonContentType, readFormBody, readJsonBody } from "@/lib/http.server";

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

function asInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : NaN;
}

export const Route = createFileRoute("/api/open")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          if (isJsonContentType(request.headers.get("content-type"))) {
            const body = await readJsonBody(request, MAX_OPEN_JSON_BODY_BYTES);
            if (body.intent !== "unlock") {
              return Response.json({ error: "Unknown action." }, { status: 400 });
            }
            const ip = clientIp(request);
            const result = await unlockBatch(
              String(body.id ?? ""),
              {
                verifier: String(body.verifier ?? ""),
                proof: String(body.proof ?? ""),
                verifier2: String(body.verifier2 ?? ""),
              },
              ip,
            );
            if (!result.ok) {
              // Fail2ban reads this line. Only counted wrong passwords carry
              // remainingAttempts, so lookups of missing seals are not logged.
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

          const form = await readFormBody(request, MAX_OPEN_FORM_BODY_BYTES);
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
          return errorResponse(err, "Could not open the file.");
        }
      },
    },
  },
});
