import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatBytes, formatExpiry } from "@/lib/files";

export type Receipt = {
  id: string;
  files: { name: string; sizeBytes: number }[];
  expiresAt: string;
  maxDownloads: number;
  url: string;
};

export function FileReceipt({ receipt, onReset }: { receipt: Receipt; onReset: () => void }) {
  const [copied, setCopied] = useState(false);
  const total = receipt.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const many = receipt.files.length !== 1;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(receipt.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-xs font-medium tracking-wide text-muted">Sealed</p>
        <h2 className="font-display text-3xl font-bold leading-tight tracking-tight text-fg text-balance">
          {many ? "The files are locked and ready." : "The file is locked and ready."}
        </h2>
        <p className="text-sm leading-relaxed text-muted text-pretty">
          Send the link and the password in two separate messages. If either is lost, we cannot get it back.
        </p>
      </div>

      <div className="space-y-3 rounded-lg bg-bg p-4 shadow-[var(--shadow-border)]">
        <ul className="max-h-36 space-y-1 overflow-y-auto">
          {receipt.files.map((file, index) => (
            <li key={`${file.name}-${index}`} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-fg">{file.name}</span>
              <span className="shrink-0 text-xs text-muted tabular-nums">{formatBytes(file.sizeBytes)}</span>
            </li>
          ))}
        </ul>
        <dl className="grid grid-cols-2 gap-3 text-xs text-muted">
          <div>
            <dt>Size</dt>
            <dd className="mt-0.5 text-fg tabular-nums">{formatBytes(total)}</dd>
          </div>
          <div>
            <dt>Downloads</dt>
            <dd className="mt-0.5 text-fg tabular-nums">{receipt.maxDownloads}</dd>
          </div>
          <div className="col-span-2">
            <dt>Expires</dt>
            <dd className="mt-0.5 text-fg">{formatExpiry(receipt.expiresAt)}</dd>
          </div>
        </dl>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium tracking-wide text-muted">Share link</p>
        <div className="flex gap-2">
          <p className="h-11 min-w-0 flex-1 truncate rounded-md bg-bg px-3 py-3 font-mono text-xs text-fg shadow-[var(--shadow-border)]">
            {receipt.url}
          </p>
          <Button type="button" variant="secondary" size="icon" onClick={copyLink} aria-label="Copy link">
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
      </div>

      <Button type="button" variant="secondary" className="w-full" onClick={onReset}>
        Send more files
      </Button>
    </div>
  );
}
