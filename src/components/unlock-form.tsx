import { Download, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MIME_PAD_BYTES, NAME_PAD_BYTES } from "@/lib/constants";
import {
  decryptPadded,
  decryptWithKey,
  deriveBatchKey,
  deriveVerifierHex,
  unsealFile,
  zeroBytes,
} from "@/lib/crypto/vault";
import { formatBytes, formatExpiry } from "@/lib/files";
import { beginSave } from "@/lib/save-file";
import { pullCipherChunk, pullCiphertextChunks } from "@/lib/upload";

export type UnlockMeta = {
  saltAuth: string;
  expiresAt: string;
  maxDownloads: number;
  remaining: number;
  locked: boolean;
  fileCount: number;
};

type ServerFile = {
  id: string;
  chunkCount: number;
  legacy: boolean;
  fileNonce: string;
  nameIv: string;
  nameCt: string;
  mimeIv: string;
  mimeCt: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  iv: string;
};

type ReadyFile = {
  id: string;
  name: string;
  mime: string;
  chunkCount: number;
  legacy: boolean;
  fileNonce: string;
  iv: string;
};

function isAbort(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && (err as { name: string }).name === "AbortError";
}

function triggerDownload(data: ArrayBuffer, name: string, mime: string) {
  const blob = new Blob([data], { type: mime || "application/octet-stream" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = name || "download";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

export function UnlockForm({ id, meta }: { id: string; meta: UnlockMeta }) {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  const [locked, setLocked] = useState(meta.locked);
  const [remaining, setRemaining] = useState(meta.remaining);
  const [completed, setCompleted] = useState(false);
  const [session, setSession] = useState<{
    ticket: string;
    saltEnc: string;
    lastAccess: boolean;
    files: ReadyFile[];
    password: string;
  } | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [saveLabel, setSaveLabel] = useState<string | null>(null);

  const heading = session
    ? session.files.length === 1
      ? session.files[0]?.name || "Unlocked"
      : `${session.files.length} files`
    : meta.fileCount === 1
      ? "Sealed file"
      : `${meta.fileCount} sealed files`;

  async function downloadOpened(
    opened: ReadyFile,
    ticket: string,
    saltEnc: string,
    pass: string,
  ) {
    setDownloadingId(opened.id);
    setSaveLabel(null);
    try {
      if (opened.legacy) {
        const ciphertext = await pullCiphertextChunks(ticket, opened.id, opened.chunkCount);
        const plaintext = await unsealFile(ciphertext, pass, saltEnc, opened.iv, opened.name);
        triggerDownload(plaintext, opened.name, opened.mime);
        return;
      }
      const sink = await beginSave(opened.name);
      try {
        const key = await deriveBatchKey(pass, saltEnc);
        let written = 0;
        for (let index = 0; index < opened.chunkCount; index += 1) {
          const pulled = await pullCipherChunk(ticket, opened.id, index);
          const plain = await decryptWithKey(key, pulled.bytes, pulled.iv, `${opened.fileNonce}:${index}`);
          const bytes = new Uint8Array(plain);
          await sink.write(bytes);
          written += bytes.byteLength;
          setSaveLabel(`Saving ${formatBytes(written)}`);
          zeroBytes(bytes);
        }
        await sink.finish();
      } catch (err) {
        await sink.abort();
        throw err;
      }
    } finally {
      setDownloadingId(null);
      setSaveLabel(null);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (locked || gone || session) return;
    setBusy(true);
    try {
      const verifier = await deriveVerifierHex(password, meta.saltAuth);
      const response = await fetch("/api/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: "unlock", id, verifier }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        ticket?: string;
        saltEnc?: string;
        remainingAfter?: number;
        lastAccess?: boolean;
        files?: ServerFile[];
      };
      if (!response.ok) {
        if (response.status === 404) setGone(true);
        if (response.status === 423) setLocked(true);
        throw new Error(payload.error || "Could not unlock the files.");
      }
      if (!payload.ticket || !payload.saltEnc || !payload.files?.length) {
        throw new Error("The server returned an incomplete batch.");
      }
      const key = await deriveBatchKey(password, payload.saltEnc);
      const ready: ReadyFile[] = [];
      for (const file of payload.files) {
        if (file.legacy) {
          ready.push({
            id: file.id,
            name: file.originalName || "download",
            mime: file.mimeType || "application/octet-stream",
            chunkCount: file.chunkCount,
            legacy: true,
            fileNonce: "",
            iv: file.iv,
          });
          continue;
        }
        const name = await decryptPadded(key, file.nameCt, file.nameIv, `${file.fileNonce}:name`, NAME_PAD_BYTES);
        const mime = await decryptPadded(key, file.mimeCt, file.mimeIv, `${file.fileNonce}:type`, MIME_PAD_BYTES);
        ready.push({
          id: file.id,
          name: name || "download",
          mime: mime || "application/octet-stream",
          chunkCount: file.chunkCount,
          legacy: false,
          fileNonce: file.fileNonce,
          iv: "",
        });
      }
      const remainingAfter = payload.remainingAfter ?? 0;
      setRemaining(remainingAfter);
      setSession({
        ticket: payload.ticket,
        saltEnc: payload.saltEnc,
        lastAccess: Boolean(payload.lastAccess),
        files: ready,
        password,
      });
      setPassword("");
      if (payload.lastAccess) {
        toast.success("This is the last download. Save the files now — they will be deleted when you leave.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not unlock the files.");
    } finally {
      setBusy(false);
    }
  }

  async function onDownload(file: ReadyFile) {
    if (!session) return;
    try {
      await downloadOpened(file, session.ticket, session.saltEnc, session.password);
      toast.success(`Saved ${file.name}`);
      if (session.lastAccess) setCompleted(true);
    } catch (err) {
      if (isAbort(err)) {
        toast.error("Save cancelled.");
        return;
      }
      toast.error(err instanceof Error ? err.message : "Download failed.");
    }
  }

  async function onDownloadAll() {
    if (!session) return;
    for (const file of session.files) {
      try {
        await downloadOpened(file, session.ticket, session.saltEnc, session.password);
      } catch (err) {
        if (isAbort(err)) {
          toast.error("Save cancelled.");
          return;
        }
        toast.error(err instanceof Error ? err.message : "Download failed.");
        return;
      }
    }
    toast.success("Saved all files.");
    if (session.lastAccess) setCompleted(true);
  }

  if (gone) {
    return (
      <div className="space-y-3">
        <h2 className="font-display text-3xl font-bold tracking-tight text-fg">
          {completed ? "Downloaded and deleted." : "This file is gone."}
        </h2>
        <p className="text-sm leading-relaxed text-muted text-pretty">
          {completed
            ? "The file was unlocked on this computer. The copy we held has been permanently deleted."
            : "It expired, was downloaded too many times, or was never here. There is nothing left to open."}
        </p>
      </div>
    );
  }

  if (locked) {
    return (
      <div className="space-y-3">
        <h2 className="font-display text-3xl font-bold tracking-tight text-fg">Too many tries.</h2>
        <p className="text-sm leading-relaxed text-muted text-pretty">
          The password was entered incorrectly too many times. The files will be deleted at {formatExpiry(meta.expiresAt)}.
        </p>
      </div>
    );
  }

  if (session) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <p className="text-xs font-medium tracking-wide text-muted">Unlocked</p>
          <h2 className="font-display text-3xl font-bold tracking-tight text-fg text-balance">{heading}</h2>
          <p className="text-sm text-muted">
            {remaining} {remaining === 1 ? "download" : "downloads"} left
            {" · "}
            expires {formatExpiry(meta.expiresAt)}
          </p>
          {session.lastAccess ? (
            <p className="text-xs text-danger">
              Last download. These files will be deleted when you leave this page.
            </p>
          ) : null}
        </div>
        <ul className="max-h-56 space-y-1 overflow-y-auto">
          {session.files.map((file) => (
            <li
              key={file.id}
              className="flex items-center gap-2 rounded-md bg-bg px-3 py-2 shadow-[var(--shadow-border)]"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-fg">{file.name}</p>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => onDownload(file)}
                disabled={downloadingId !== null}
              >
                {downloadingId === file.id ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Download />
                )}
                {downloadingId === file.id ? (saveLabel ?? "Saving") : "Save"}
              </Button>
            </li>
          ))}
        </ul>
        {session.files.length > 1 ? (
          <Button type="button" className="w-full" onClick={onDownloadAll} disabled={downloadingId !== null}>
            {downloadingId ? (
              <>
                <LoaderCircle className="animate-spin" />
                {saveLabel ?? "Saving"}
              </>
            ) : (
              "Save all"
            )}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="space-y-2">
        <p className="text-xs font-medium tracking-wide text-muted">Unlock</p>
        <h2 className="font-display text-3xl font-bold tracking-tight text-fg text-balance">{heading}</h2>
        <p className="text-sm text-muted">
          {remaining} {remaining === 1 ? "download" : "downloads"} left
          {" · "}
          expires {formatExpiry(meta.expiresAt)}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="unlock-password">Password</Label>
        <div className="relative">
          <Input
            id="unlock-password"
            type={showPassword ? "text" : "password"}
            autoComplete="off"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            className="pr-12"
            placeholder="The password set by the sender"
          />
          <button
            type="button"
            className="absolute right-1 top-1 inline-flex size-9 items-center justify-center text-muted hover:text-fg"
            onClick={() => setShowPassword((value) => !value)}
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>

      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? (
          <>
            <LoaderCircle className="animate-spin" />
            Unlocking
          </>
        ) : remaining === 1 ? (
          "Unlock and destroy after download"
        ) : (
          "Unlock"
        )}
      </Button>
    </form>
  );
}
