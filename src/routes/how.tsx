import { createFileRoute } from "@tanstack/react-router";
import { SiteHeader } from "@/components/site-header";
import { Separator } from "@/components/ui/separator";

export const Route = createFileRoute("/how")({ component: HowPage });

const SECTIONS = [
  {
    title: "What you choose",
    body: "Pick your files, a password, an expiry date, and how many times they may be downloaded. A strong password is filled in for you; send it separately from the link. If you type your own, it must be at least 12 characters and hard to guess: a word with a year or a symbol added is refused. Dates are written as day/month/year. Times are in GMT.",
  },
  {
    title: "Locked before they leave",
    body: "Your files, their names, and their types are locked in this browser before they are sent. We only keep the locked copies. We never see the original files, their names, their types, or your password.",
  },
  {
    title: "How the lock works",
    body: "Your password becomes a key on your computer. That key locks each piece of a file, and it locks the name and the type as well. Names are padded to a fixed size so the locked copy does not reveal how long they were. We use AES-256, a strong, widely used standard. Each piece is bound to its place in the file and to the file's length, and each file to its place in the seal, so a piece cannot be swapped, dropped, or cut off unnoticed.",
  },
  {
    title: "Checking the password",
    body: "When someone opens your link, they type the password on their own computer. We check a proof of the password, not the password itself. If it is correct, their browser unlocks the files. The unlocked files never sit with us.",
  },
  {
    title: "When files are deleted",
    body: "The files are permanently deleted when the expiry date and time pass, or when they have been downloaded the number of times you allowed. Too many wrong passwords from one connection block that connection; many wrong passwords in total lock the files until they expire. There is no recycle bin. No one at Cinder can restore deleted files.",
  },
  {
    title: "What you can send",
    body: "Any file type. One seal can hold up to 100 files and 5 GB in total. Everything stored on the server at once — every seal, combined — stays within 20 GB.",
  },
  {
    title: "What Cinder is not",
    body: "Cinder is not a place to store files, and it does not keep backups. If you forget the password, the files cannot be opened. Send the link in one message and the password in another.",
  },
] as const;

function HowPage() {
  return (
    <div className="min-h-screen bg-bg text-fg">
      <div className="mx-auto w-full max-w-3xl px-5 pb-24 sm:px-8">
        <SiteHeader />
        <main className="space-y-10 pt-6">
          <div className="space-y-4">
            <p className="text-xs font-medium tracking-[0.18em] text-muted uppercase">How it works</p>
            <h1 className="font-display text-4xl font-bold tracking-tight sm:text-5xl">How Cinder handles a file</h1>
            <p className="max-w-xl text-base leading-relaxed text-muted">
              When you send a file with Cinder, here is what happens — in plain terms.
            </p>
          </div>
          <Separator />
          <ol className="space-y-8">
            {SECTIONS.map((section, index) => (
              <li key={section.title} className="grid gap-3 sm:grid-cols-[4rem_minmax(0,1fr)]">
                <span className="font-mono text-xs text-subtle tabular-nums">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="space-y-2">
                  <h2 className="font-display text-base font-bold text-fg">{section.title}</h2>
                  <p className="text-sm leading-relaxed text-muted">{section.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </main>
      </div>
    </div>
  );
}
