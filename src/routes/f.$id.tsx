import { createFileRoute } from "@tanstack/react-router";
import { UnlockForm } from "@/components/unlock-form";
import { SiteHeader } from "@/components/site-header";
import { getSealedMeta } from "@/lib/vault.functions";

export const Route = createFileRoute("/f/$id")({
  loader: async ({ params }) => {
    const id = params.id?.toLowerCase() ?? "";
    if (!/^[a-f0-9]{32}$/.test(id)) return { id, meta: null };
    const result = await getSealedMeta({ data: { id } });
    if (!result.ok) return { id, meta: null };
    return { id, meta: result };
  },
  component: UnlockPage,
});

function UnlockPage() {
  const { id, meta } = Route.useLoaderData();

  return (
    <div className="min-h-screen bg-bg text-fg">
      <div className="mx-auto w-full max-w-6xl px-5 pb-20 sm:px-8">
        <SiteHeader />
        <main className="mx-auto max-w-md pt-8">
          <section className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] sm:p-7">
            {meta ? (
              <UnlockForm
                id={id}
                meta={{
                  saltAuth: meta.saltAuth,
                  expiresAt: meta.expiresAt,
                  maxDownloads: meta.maxDownloads,
                  remaining: meta.remaining,
                  locked: meta.locked,
                  fileCount: meta.fileCount,
                }}
              />
            ) : (
              <div className="space-y-3">
                <h1 className="font-display text-3xl font-bold tracking-tight">This file is gone.</h1>
                <p className="text-sm leading-relaxed text-muted">
                  The link is not valid, has expired, or has already been used up. There is nothing left to download.
                </p>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
