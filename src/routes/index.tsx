import { createFileRoute, Link } from "@tanstack/react-router";
import { SealForm } from "@/components/seal-form";
import { SiteHeader } from "@/components/site-header";
import { APP_TAGLINE } from "@/lib/constants";

export const Route = createFileRoute("/")({ component: Home });

const PRINCIPLES = [
  {
    n: "01",
    title: "Locked on your computer",
    body: "Your files, their names, and their types are locked with a password before they leave this page. We never see them or the password.",
  },
  {
    n: "02",
    title: "You choose when they disappear",
    body: "Set an end date and a download limit. When either is reached, the files are permanently deleted.",
  },
  {
    n: "03",
    title: "A password and a link",
    body: "The person you send this to needs both the link and the password. Send them in two separate messages.",
  },
] as const;

function Home() {
  return (
    <div className="min-h-screen bg-bg text-fg">
      <div className="mx-auto w-full max-w-6xl px-5 pb-20 sm:px-8">
        <SiteHeader />
        <main className="grid gap-12 pt-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-start lg:gap-16 lg:pt-10">
          <section className="space-y-10">
            <div className="space-y-5">
              <p className="text-xs font-medium tracking-[0.18em] text-muted uppercase">Private file drop</p>
              <h1 className="font-display text-5xl font-bold leading-[1.08] tracking-tight text-fg sm:text-6xl">
                {APP_TAGLINE}
              </h1>
              <p className="max-w-md text-base leading-relaxed text-muted">
                Send files with a password and a link. You choose when they expire and how many times they can be opened. After that, they are deleted for good. No account needed.
              </p>
            </div>
            <ol className="space-y-6">
              {PRINCIPLES.map((item) => (
                <li key={item.n} className="grid grid-cols-[3rem_minmax(0,1fr)] gap-4">
                  <span className="font-mono text-xs text-subtle tabular-nums">{item.n}</span>
                  <div className="space-y-1">
                    <h2 className="font-display text-sm font-bold text-fg">{item.title}</h2>
                    <p className="text-sm leading-relaxed text-muted">{item.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="text-xs text-subtle">
              <Link to="/how" className="text-muted underline-offset-4 hover:text-fg hover:underline">
                See how it works
              </Link>
            </p>
          </section>

          <section className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] sm:p-7">
            <SealForm />
          </section>
        </main>
      </div>
    </div>
  );
}
