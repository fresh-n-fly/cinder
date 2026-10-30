import { createHmac, randomBytes } from "node:crypto";

/**
 * Per-client limits (upload quotas, unlock attempt budgets) need a stable
 * identifier for "the same network" without storing addresses.
 *
 * - IPv4 addresses are used whole; IPv6 addresses are reduced to their /64,
 *   the smallest block a single subscriber is normally given.
 * - The result is an HMAC under a server secret, so the stored value cannot be
 *   reversed by hashing every IPv4 address the way a plain SHA-256 could.
 *
 * CINDER_CLIENT_KEY_SECRET (64+ hex chars) keeps keys stable across restarts.
 * Without it a random per-process secret is used: limits then reset on restart,
 * and no key outlives the process that made it.
 */
const secret = (() => {
  const raw = (typeof process !== "undefined" ? process.env.CINDER_CLIENT_KEY_SECRET : "")?.trim() ?? "";
  if (/^[0-9a-fA-F]{64,}$/.test(raw)) return Buffer.from(raw, "hex");
  return randomBytes(32);
})();

function normalizeIpv4(value: string): string | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets.join(".");
}

/** Returns the first four hextets of an IPv6 address, or an IPv4 address for mapped forms. */
function normalizeIpv6(value: string): string | null {
  let text = value.toLowerCase().split("%")[0] ?? "";
  // Rewrite an embedded dotted IPv4 tail (::ffff:1.2.3.4) as two hextets.
  const lastColon = text.lastIndexOf(":");
  const last = text.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = normalizeIpv4(last);
    if (!v4) return null;
    const [a, b, c, d] = v4.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = [...head, ...rest];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  if (halves.length === 1 ? groups.length !== 8 : groups.length > 7) return null;
  const words = [...head, ...Array<string>(8 - groups.length).fill("0"), ...rest].map((g) =>
    Number.parseInt(g, 16),
  );
  // ::ffff:a.b.c.d and ::ffff:x:y are IPv4 clients.
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    const w6 = words[6]!;
    const w7 = words[7]!;
    return `${w6 >> 8}.${w6 & 255}.${w7 >> 8}.${w7 & 255}`;
  }
  return `${words.slice(0, 4).map((w) => w.toString(16)).join(":")}::/64`;
}

export function normalizeClientAddress(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const value = ip.trim();
  if (!value || value.length > 64) return null;
  return value.includes(":") ? normalizeIpv6(value) : normalizeIpv4(value);
}

export function clientKeyFor(ip: string | null | undefined): string | null {
  const normalized = normalizeClientAddress(ip);
  if (!normalized) return null;
  return createHmac("sha256", secret).update(`cinder-client-v1:${normalized}`).digest("hex");
}
