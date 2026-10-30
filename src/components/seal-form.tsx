import { Eye, EyeOff, LoaderCircle, Shuffle } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { DropZone } from "@/components/drop-zone";
import { FileReceipt, type Receipt } from "@/components/file-receipt";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AAD_VERSION,
  CHUNK_PLAIN_BYTES,
  MIME_PAD_BYTES,
  MIN_PASSWORD_LENGTH,
  NAME_PAD_BYTES,
  SEAL_FORMAT,
} from "@/lib/constants";
import {
  chunkAad,
  createBatchKeys,
  encryptPadded,
  encryptWithKey,
  generatePassphrase,
  nameAad,
  passwordScore,
  randomHex,
  typeAad,
  validatePassword,
} from "@/lib/crypto/vault";
import {
  formatBytes,
  formatGmtDate,
  formatGmtTime,
  parseGmtDateTime,
  validateUploadBatch,
} from "@/lib/files";
import { cancelUpload, finishUpload, putCipherChunk, startUpload } from "@/lib/upload";
import { cn } from "@/lib/utils";

const PRESETS = [
  { label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { label: "3 days", ms: 3 * 24 * 60 * 60 * 1000 },
  { label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

const DOWNLOAD_PRESETS = [1, 3, 5, 10] as const;

function defaultExpiry(): { date: string; time: string } {
  const ms = Date.now() + 24 * 60 * 60 * 1000;
  return { date: formatGmtDate(ms), time: formatGmtTime(ms) };
}

const SCORE_LABEL = ["", "Weak", "Fair", "Good", "Strong"] as const;

export function SealForm() {
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [expiresDate, setExpiresDate] = useState(() => defaultExpiry().date);
  const [expiresTime, setExpiresTime] = useState(() => defaultExpiry().time);
  const [maxDownloads, setMaxDownloads] = useState(1);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  // Start from a generated password, shown so it can be copied. A typed one
  // must still pass the strength check.
  useEffect(() => {
    setPassword((current) => current || generatePassphrase());
    setShowPassword(true);
  }, []);

  const score = passwordScore(password);
  const activePreset = useMemo(() => {
    const parsed = parseGmtDateTime(expiresDate, expiresTime);
    if (!parsed) return null;
    return PRESETS.find((preset) => Math.abs(Date.now() + preset.ms - parsed.getTime()) < 90_000)?.label ?? null;
  }, [expiresDate, expiresTime]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const batchError = validateUploadBatch(files);
    if (batchError) {
      setFileError(batchError);
      return;
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      toast.error(passwordError);
      return;
    }
    const expires = parseGmtDateTime(expiresDate, expiresTime);
    if (!expires) {
      toast.error("Enter expiry as DD/MM/YYYY and a GMT time.");
      return;
    }

    setBusy(true);
    let uploadId: string | null = null;
    try {
      const keys = await createBatchKeys(password);
      const prepared: {
        file: File;
        fileNonce: string;
        chunkCount: number;
        nameIv: string;
        nameCt: string;
        mimeIv: string;
        mimeCt: string;
      }[] = [];
      const fileCount = files.length;
      for (let index = 0; index < fileCount; index += 1) {
        const file = files[index]!;
        const fileNonce = randomHex(16);
        const nameSealed = await encryptPadded(
          keys.key,
          file.name,
          nameAad(AAD_VERSION, fileNonce, index, fileCount),
          NAME_PAD_BYTES,
        );
        const mimeSealed = await encryptPadded(
          keys.key,
          file.type || "application/octet-stream",
          typeAad(AAD_VERSION, fileNonce, index, fileCount),
          MIME_PAD_BYTES,
        );
        prepared.push({
          file,
          fileNonce,
          chunkCount: Math.ceil(file.size / CHUNK_PLAIN_BYTES),
          nameIv: nameSealed.iv,
          nameCt: nameSealed.ciphertextHex,
          mimeIv: mimeSealed.iv,
          mimeCt: mimeSealed.ciphertextHex,
        });
      }

      uploadId = await startUpload();
      const packed: {
        fileIndex: number;
        fileNonce: string;
        nameIv: string;
        nameCt: string;
        mimeIv: string;
        mimeCt: string;
        chunkCount: number;
      }[] = [];

      for (let index = 0; index < prepared.length; index += 1) {
        const item = prepared[index]!;
        let chunkIndex = 0;
        for (let offset = 0; offset < item.file.size; offset += CHUNK_PLAIN_BYTES) {
          const end = Math.min(item.file.size, offset + CHUNK_PLAIN_BYTES);
          const slice = await item.file.slice(offset, end).arrayBuffer();
          const sealed = await encryptWithKey(
            keys.key,
            slice,
            chunkAad(AAD_VERSION, item.fileNonce, chunkIndex, item.chunkCount),
          );
          await putCipherChunk(uploadId, index, chunkIndex, sealed.iv, sealed.ciphertext);
          chunkIndex += 1;
          setProgress(
            `Sealing ${index + 1} of ${prepared.length} · ${formatBytes(end)} of ${formatBytes(item.file.size)}`,
          );
        }
        if (chunkIndex !== item.chunkCount) throw new Error("A file changed while it was being sealed.");
        packed.push({
          fileIndex: index,
          fileNonce: item.fileNonce,
          nameIv: item.nameIv,
          nameCt: item.nameCt,
          mimeIv: item.mimeIv,
          mimeCt: item.mimeCt,
          chunkCount: chunkIndex,
        });
      }

      setProgress("Finishing");
      const result = await finishUpload({
        uploadId,
        format: SEAL_FORMAT,
        saltAuth: keys.saltAuth,
        saltEnc: keys.saltEnc,
        authHash: keys.authHash,
        expiresAt: expires.toISOString(),
        maxDownloads,
        files: packed,
      });

      setReceipt({
        id: result.id,
        files: files.map((file) => ({ name: file.name, sizeBytes: file.size })),
        expiresAt: expires.toISOString(),
        maxDownloads,
        url: `${window.location.origin}/f/${result.id}`,
      });
      setFiles([]);
      setPassword(generatePassphrase());
      setShowPassword(true);
      setProgress(null);
    } catch (err) {
      if (uploadId) await cancelUpload(uploadId).catch(() => undefined);
      toast.error(err instanceof Error ? err.message : "Could not seal the files.");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  if (receipt) {
    return (
      <FileReceipt
        receipt={receipt}
        onReset={() => {
          setReceipt(null);
          setFileError(null);
        }}
      />
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="space-y-2">
        <h2 className="font-display text-2xl font-bold tracking-tight text-fg">Seal files</h2>
        <p className="text-sm leading-relaxed text-muted text-pretty">
          Lock your files with a password, then share a link. They are deleted on the date you set, or after the last allowed download.
        </p>
      </div>

      <DropZone files={files} onFiles={setFiles} error={fileError} onError={setFileError} />

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="password">Password</Label>
          <button
            type="button"
            className="inline-flex h-11 items-center gap-1.5 text-xs text-muted hover:text-fg"
            onClick={() => {
              setPassword(generatePassphrase());
              setShowPassword(true);
            }}
          >
            <Shuffle className="size-3.5" />
            Generate
          </button>
        </div>
        <div className="relative">
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={256}
            required
            className="pr-12"
            placeholder="12+ characters that are hard to guess"
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
        <div className="flex items-center gap-2">
          <div className="flex flex-1 gap-1">
            {[1, 2, 3, 4].map((step) => (
              <span
                key={step}
                className={cn("h-1 flex-1 rounded-full bg-border", score >= step && "bg-fg")}
              />
            ))}
          </div>
          <span className="text-xs text-muted">{SCORE_LABEL[score]}</span>
        </div>
      </div>

      <div className="space-y-2">
        <Label>Expires (GMT)</Label>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => {
                const ms = Date.now() + preset.ms;
                setExpiresDate(formatGmtDate(ms));
                setExpiresTime(formatGmtTime(ms));
              }}
              className={cn(
                "h-11 rounded-md px-3 text-xs text-muted shadow-[var(--shadow-border)] transition-colors duration-[var(--motion-quick)] hover:text-fg",
                activePreset === preset.label && "bg-primary text-primary-foreground shadow-none",
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Input
            id="expires-date"
            inputMode="numeric"
            autoComplete="off"
            placeholder="DD/MM/YYYY"
            value={expiresDate}
            onChange={(event) => setExpiresDate(event.target.value)}
            required
            aria-label="Expiry date, DD/MM/YYYY GMT"
          />
          <Input
            id="expires-time"
            type="time"
            value={expiresTime}
            onChange={(event) => setExpiresTime(event.target.value)}
            required
            className="w-[8.5rem]"
            aria-label="Expiry time, GMT"
          />
        </div>
        <p className="text-xs text-muted">Day/month/year. Time is GMT (Greenwich Mean Time).</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="downloads">Download limit</Label>
        <div className="flex flex-wrap gap-2">
          {DOWNLOAD_PRESETS.map((count) => (
            <button
              key={count}
              type="button"
              onClick={() => setMaxDownloads(count)}
              className={cn(
                "h-11 min-w-11 rounded-md px-3 text-xs text-muted shadow-[var(--shadow-border)] transition-colors duration-[var(--motion-quick)] hover:text-fg tabular-nums",
                maxDownloads === count && "bg-primary text-primary-foreground shadow-none",
              )}
            >
              {count === 1 ? "Once" : count}
            </button>
          ))}
        </div>
        <Input
          id="downloads"
          type="number"
          min={1}
          max={100}
          value={maxDownloads}
          onChange={(event) => setMaxDownloads(Number.parseInt(event.target.value, 10) || 1)}
        />
        <p className="text-xs text-muted">
          After the last download, the files are permanently deleted.
        </p>
      </div>

      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? (
          <>
            <LoaderCircle className="animate-spin" />
            {progress ?? "Sealing"}
          </>
        ) : (
          "Seal and get link"
        )}
      </Button>
    </form>
  );
}
