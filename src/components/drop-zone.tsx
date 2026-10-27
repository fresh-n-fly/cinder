import { FileUp, X } from "lucide-react";
import { useCallback, useState, type ChangeEvent, type DragEvent } from "react";
import { cn } from "@/lib/utils";
import { formatBytes, validateUploadBatch, validateUploadFile } from "@/lib/files";
import { MAX_BATCH_BYTES, MAX_BATCH_FILES } from "@/lib/constants";

type DropZoneProps = {
  files: File[];
  onFiles: (files: File[]) => void;
  error: string | null;
  onError: (message: string | null) => void;
};

export function DropZone({ files = [], onFiles, error, onError }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);

  const mergeFiles = useCallback(
    (incoming: File[]) => {
      if (incoming.length === 0) return;
      const next = [...files];
      let message: string | null = null;
      for (const file of incoming) {
        const single = validateUploadFile(file);
        if (single) {
          message = single;
          continue;
        }
        const trial = [...next, file];
        const batchError = validateUploadBatch(trial);
        if (batchError) {
          message = batchError;
          continue;
        }
        next.push(file);
      }
      onError(message);
      onFiles(next);
    },
    [files, onError, onFiles],
  );

  function onInput(event: ChangeEvent<HTMLInputElement>) {
    mergeFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    mergeFiles(Array.from(event.dataTransfer.files ?? []));
  }

  function removeAt(index: number) {
    const next = files.filter((_, i) => i !== index);
    onFiles(next);
    onError(next.length ? validateUploadBatch(next) : null);
  }

  const total = files.reduce((sum, file) => sum + file.size, 0);

  return (
    <div className="space-y-3">
      <label
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex min-h-36 cursor-pointer flex-col items-center justify-center gap-3 rounded-lg bg-bg px-4 py-8 text-center shadow-[var(--shadow-border)] transition-[box-shadow,background-color] duration-[var(--motion-quick)] ease-[var(--ease-out)]",
          dragging && "shadow-[var(--shadow-border-hover)] bg-surface",
          error && "shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-danger)_70%,transparent)]",
        )}
      >
        <input type="file" multiple className="sr-only" onChange={onInput} />
        <FileUp className="size-5 text-muted" strokeWidth={1.6} />
        <div className="space-y-1">
          <p className="text-sm text-fg">Drop files or browse</p>
          <p className="text-xs text-muted">
            Any file type · up to {MAX_BATCH_FILES} files · {formatBytes(MAX_BATCH_BYTES)} combined
          </p>
        </div>
      </label>

      {files.length > 0 ? (
        <ul className="max-h-48 space-y-1 overflow-y-auto">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
              className="flex items-center gap-2 rounded-md bg-bg px-3 py-2 shadow-[var(--shadow-border)]"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-fg">{file.name}</p>
                <p className="text-xs text-muted tabular-nums">{formatBytes(file.size)}</p>
              </div>
              <button
                type="button"
                className="inline-flex size-11 items-center justify-center text-muted hover:text-fg"
                onClick={() => removeAt(index)}
                aria-label={`Remove ${file.name}`}
              >
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {files.length > 1 ? (
        <p className="text-xs text-muted tabular-nums">
          {files.length} files · {formatBytes(total)}
        </p>
      ) : null}

      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
