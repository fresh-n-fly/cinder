/**
 * Request helpers shared by the API routes.
 *
 * Content types are matched exactly, with no trimming: Nginx decides which
 * rate limit applies from the same header, and the two must never disagree
 * about whether a body is JSON.
 */
import { BUSY_ERROR, GENERIC_ERROR, PublicError } from "@/lib/errors";

const JSON_CONTENT_TYPE = /^application\/json(?:[ \t]*;[ \t]*charset="?utf-8"?)?[ \t]*$/i;

export function isJsonContentType(value: string | null): boolean {
  return value !== null && JSON_CONTENT_TYPE.test(value);
}

/**
 * The client address as set by Nginx. X-Forwarded-For is ignored: Nginx
 * overwrites X-Real-IP with $remote_addr, and anything else is client input.
 */
export function clientIp(request: Request): string | null {
  const raw = request.headers.get("x-real-ip");
  if (!raw || raw.length > 45 || !/^[0-9a-fA-F:.]+$/.test(raw)) return null;
  return raw;
}

function bodyTooLarge(request: Request, maxBytes: number): boolean {
  const raw = request.headers.get("content-length");
  if (!raw) return false;
  const bytes = Number.parseInt(raw, 10);
  return Number.isFinite(bytes) && bytes > maxBytes;
}

export const BODY_TOO_LARGE = "Request body is too large.";

export async function readBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (bodyTooLarge(request, maxBytes)) throw new PublicError(BODY_TOO_LARGE, 413);
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
      throw new PublicError(BODY_TOO_LARGE, 413);
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

const INVALID_REQUEST = "Invalid request.";

export async function readJsonBody(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const text = new TextDecoder().decode(await readBodyBytes(request, maxBytes));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser's message quotes the input; never send or log it.
    throw new PublicError(INVALID_REQUEST);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PublicError(INVALID_REQUEST);
  return parsed as Record<string, unknown>;
}

export async function readFormBody(request: Request, maxBytes: number): Promise<FormData> {
  const body = await readBodyBytes(request, maxBytes);
  const buffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  try {
    return await new Request(request.url, { method: request.method, headers: request.headers, body: buffer }).formData();
  } catch {
    throw new PublicError(INVALID_REQUEST);
  }
}

/** SQLSTATEs and pool errors that mean "overloaded", not "broken". */
function isBusy(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "55P03" || code === "57014" || code === "53300") return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /timeout exceeded when trying to connect/i.test(message);
}

/**
 * Turn any thrown value into a JSON error response. Only PublicError messages
 * are passed through. Everything else is logged by type and SQLSTATE only:
 * driver messages can quote request input, and the app log is read by
 * Fail2ban, so no request-derived text is written there.
 */
export function errorResponse(err: unknown, fallback = GENERIC_ERROR): Response {
  const headers = { "Cache-Control": "no-store" };
  if (err instanceof PublicError) {
    return Response.json({ error: err.message }, { status: err.status, headers });
  }
  if (isBusy(err)) {
    return Response.json({ error: BUSY_ERROR }, { status: 503, headers: { ...headers, "Retry-After": "2" } });
  }
  const name = err instanceof Error ? err.name.replace(/[^A-Za-z]/g, "").slice(0, 40) : typeof err;
  const rawCode = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  const code = typeof rawCode === "string" && /^[A-Z0-9_]{1,40}$/.test(rawCode) ? rawCode : "-";
  console.error(`[cinder] request_error type=${name || "Error"} code=${code}`);
  return Response.json({ error: fallback }, { status: 500, headers });
}
