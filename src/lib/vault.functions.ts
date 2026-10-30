import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const idSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
});

export const getSealedMeta = createServerFn({ method: "GET" })
  .validator(idSchema)
  .handler(async ({ data }) => {
    const { getBatchMeta } = await import("@/lib/vault.server");
    let meta: Awaited<ReturnType<typeof getBatchMeta>>;
    try {
      meta = await getBatchMeta(data.id);
    } catch (err) {
      // The error is serialized to the page (and to /_serverFn callers), so
      // driver text such as addresses and ports must not travel with it.
      const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
      console.error(`[cinder] request_error type=meta code=${typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "-"}`);
      throw new Error("This file could not be loaded right now. Try again in a moment.");
    }
    if (!meta) return { ok: false as const };
    return {
      ok: true as const,
      kdf: meta.kdf,
      saltAuth: meta.saltAuth,
      expiresAt: meta.expiresAt,
      maxDownloads: meta.maxDownloads,
      remaining: meta.remaining,
      locked: meta.locked,
      fileCount: meta.fileCount,
    };
  });
