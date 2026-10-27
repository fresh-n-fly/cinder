import { Link } from "@tanstack/react-router";
import { CinderMark } from "@/components/mark";
import { APP_NAME } from "@/lib/constants";

export function SiteHeader() {
  return (
    <header className="flex items-center justify-between gap-4 py-6">
      <Link
        to="/"
        className="flex items-center gap-2.5 text-fg no-underline"
        aria-label={`${APP_NAME} home`}
      >
        <CinderMark />
        <span className="font-display text-xl font-bold tracking-tight">{APP_NAME}</span>
      </Link>
      <nav className="flex items-center gap-1">
        <Link
          to="/how"
          className="inline-flex h-11 items-center px-3 text-sm text-muted no-underline transition-colors duration-[var(--motion-quick)] hover:text-fg"
        >
          How it works
        </Link>
      </nav>
    </header>
  );
}
