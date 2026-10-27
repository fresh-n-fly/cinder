import { MAX_BATCH_BYTES, MAX_BATCH_FILES } from "@/lib/constants";

export function validateUploadFile(file: File): string | null {
  if (file.size <= 0) return "That file is empty.";
  if (file.size > MAX_BATCH_BYTES) {
    return `${file.name} is over ${formatBytes(MAX_BATCH_BYTES)}.`;
  }
  return null;
}

export function validateUploadBatch(files: File[]): string | null {
  if (files.length === 0) return "Choose at least one file.";
  if (files.length > MAX_BATCH_FILES) {
    return `A batch can hold ${MAX_BATCH_FILES} files.`;
  }
  let total = 0;
  for (const file of files) {
    const error = validateUploadFile(file);
    if (error) return error;
    total += file.size;
    if (total > MAX_BATCH_BYTES) {
      return `Everything combined can be at most ${formatBytes(MAX_BATCH_BYTES)}.`;
    }
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
  }
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${formatGmtDate(date.getTime())} ${formatGmtTime(date.getTime())} GMT`;
}

export function formatGmtDate(ms: number): string {
  const date = new Date(ms);
  return `${pad2(date.getUTCDate())}/${pad2(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}

export function formatGmtTime(ms: number): string {
  const date = new Date(ms);
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

export function parseGmtDateTime(date: string, time: string): Date | null {
  const dateMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date.trim());
  const timeMatch = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(time.trim());
  if (!dateMatch || !timeMatch) return null;
  const day = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const year = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const utc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return check;
}

export function chunkCountFor(size: number, chunkBytes: number): number {
  return Math.max(1, Math.ceil(size / chunkBytes));
}
