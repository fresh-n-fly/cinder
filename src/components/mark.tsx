import { cn } from "@/lib/utils";

export function CinderMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("size-7", className)}
      aria-hidden="true"
    >
      <rect width="32" height="32" rx="7" className="fill-surface" />
      <path
        className="fill-fg"
        d="M18.59 25.66A10 10 0 1 1 25.06 20.23L21.44 18.54A6 6 0 1 0 17.55 21.8Z"
      />
    </svg>
  );
}
