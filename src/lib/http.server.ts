/**
 * Request helpers shared by the API routes.
 *
 * Content types are matched exactly, with no trimming: Nginx decides which
 * rate limit applies from the same header, and the two must never disagree
 * about whether a body is JSON.
 */

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
  if (bodyTooLarge(request, maxBytes)) throw new Error(BODY_TOO_LARGE);
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
      throw new Error(BODY_TOO_LARGE);
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

export async function readJsonBody(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(new TextDecoder().decode(await readBodyBytes(request, maxBytes))) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid request.");
  return parsed as Record<string, unknown>;
}

export async function readFormBody(request: Request, maxBytes: number): Promise<FormData> {
  const body = await readBodyBytes(request, maxBytes);
  const buffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  return new Request(request.url, { method: request.method, headers: request.headers, body: buffer }).formData();
}

export function errorStatus(message: string): number {
  return message === BODY_TOO_LARGE ? 413 : 400;
}
