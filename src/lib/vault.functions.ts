import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const idSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
});

export const getSealedMeta = createServerFn({ method: "GET" })
  .validator(idSchema)
  .handler(async ({ data }) => {
    const { getBatchMeta } = await import("@/lib/vault.server");
    const meta = await getBatchMeta(data.id);
    if (!meta) return { ok: false as const };
    return {
      ok: true as const,
      saltAuth: meta.saltAuth,
      expiresAt: meta.expiresAt,
      maxDownloads: meta.maxDownloads,
      remaining: meta.remaining,
      locked: meta.locked,
      fileCount: meta.fileCount,
    };
  });
