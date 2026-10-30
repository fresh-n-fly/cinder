export type ByteSink = {
  write(chunk: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  abort(): Promise<void>;
};

type Writable = {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
};

type OpfsRoot = {
  getFileHandle: (
    name: string,
    opts: { create: boolean },
  ) => Promise<{ getFile: () => Promise<File>; createWritable: () => Promise<Writable> }>;
  removeEntry: (name: string) => Promise<void>;
  entries?: () => AsyncIterableIterator<[string, { kind: string; getFile?: () => Promise<File> }]>;
};

type LockManager = {
  request?: (name: string, callback: () => Promise<void>) => Promise<void>;
  query?: () => Promise<{ held?: { name?: string }[] }>;
};

type ReadyLockManager = Required<LockManager>;

const TEMP_PREFIX = "cinder-";
const LOCK_PREFIX = "cinder-save:";
const SAVE_WORKER = "/save-sw.js";
const SAVE_PATH = "/__cinder-save/";

function abortError(): Error {
  return new DOMException("Save cancelled.", "AbortError");
}

function sanitizeName(name: string): string {
  const base = name.replace(/[/\\]/g, "_").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return base.slice(0, 180) || "download";
}

function storageRoot(): Promise<OpfsRoot> | null {
  const storage = navigator.storage as unknown as { getDirectory?: () => Promise<OpfsRoot> } | undefined;
  return storage?.getDirectory ? storage.getDirectory() : null;
}

function locks(): ReadyLockManager | null {
  const manager = (navigator as unknown as { locks?: LockManager }).locks;
  if (typeof manager?.request !== "function" || typeof manager.query !== "function") return null;
  return manager as ReadyLockManager;
}

/** Hold a Web Lock until the returned function is called; it also ends when the tab closes. */
function holdLock(name: string): () => void {
  const manager = locks();
  if (!manager) return () => undefined;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  void manager.request(name, () => held).catch(() => undefined);
  return release;
}

/**
 * Remove decrypted temp files left in this site's private storage by an
 * earlier visit (for example a tab closed mid-download). Files still held by
 * an open tab's lock are left alone.
 */
export async function sweepStaleSaves(): Promise<void> {
  const rootPromise = storageRoot();
  if (!rootPromise) return;
  try {
    const root = await rootPromise;
    if (!root.entries) return;
    const manager = locks();
    const held = new Set(
      manager ? ((await manager.query()).held ?? []).map((lock) => lock.name ?? "") : [],
    );
    for await (const [name, handle] of root.entries()) {
      if (!name.startsWith(TEMP_PREFIX) || handle.kind !== "file") continue;
      if (held.has(`${LOCK_PREFIX}${name}`)) continue;
      if (!manager) {
        // Without Web Locks a live save in another tab cannot be told apart,
        // and its file time only updates when it closes: keep anything recent.
        const age = handle.getFile ? Date.now() - (await handle.getFile()).lastModified : 0;
        if (age < 24 * 60 * 60 * 1000) continue;
      }
      await root.removeEntry(name).catch(() => undefined);
    }
  } catch {
    // Storage access can be refused (private windows, quota). Nothing to sweep.
  }
}

/** Stream through the save worker into a normal browser download. */
async function beginWorkerSave(safeName: string): Promise<ByteSink | null> {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return null;
  let worker: ServiceWorker | null = null;
  try {
    await navigator.serviceWorker.register(SAVE_WORKER, { scope: "/" });
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 4000)),
    ]);
    worker = registration?.active ?? null;
  } catch {
    return null;
  }
  if (!worker) return null;

  const id = crypto.randomUUID();
  const channel = new MessageChannel();
  const port = channel.port1;
  const pulls: (() => void)[] = [];
  let credits = 0;
  let cancelled = false;
  let readyResolve: (ok: boolean) => void = () => undefined;
  const ready = new Promise<boolean>((resolve) => {
    readyResolve = resolve;
  });
  port.onmessage = (event) => {
    const type = (event.data as { type?: string } | null)?.type;
    if (type === "ready") readyResolve(true);
    else if (type === "pull") {
      const waiter = pulls.shift();
      if (waiter) waiter();
      else credits += 1;
    } else if (type === "cancelled") {
      cancelled = true;
      for (const waiter of pulls.splice(0)) waiter();
    }
  };
  worker.postMessage({ type: "cinder-save", id, name: safeName }, [channel.port2]);
  const ok = await Promise.race([
    ready,
    new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 4000)),
  ]);
  if (!ok) {
    port.close();
    return null;
  }

  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.src = `${SAVE_PATH}${id}`;
  document.body.appendChild(frame);
  // Messages to the worker keep it alive for the length of a long download.
  const ping = window.setInterval(() => worker?.postMessage({ type: "cinder-ping" }), 10_000);
  const cleanup = () => {
    window.clearInterval(ping);
    window.setTimeout(() => frame.remove(), 5_000);
  };
  /** Resolves true when the download asks for more bytes, false after `ms`. */
  const nextPull = (ms: number) =>
    new Promise<boolean>((resolve) => {
      if (credits > 0) {
        credits -= 1;
        resolve(true);
        return;
      }
      let waiter: () => void = () => undefined;
      const timer = window.setTimeout(() => {
        const at = pulls.indexOf(waiter);
        if (at >= 0) pulls.splice(at, 1);
        resolve(false);
      }, ms);
      waiter = () => {
        window.clearTimeout(timer);
        resolve(true);
      };
      pulls.push(waiter);
    });

  // The first read only happens once the browser has actually started the
  // download. If it never comes, this browser does not take downloads from
  // the worker: undo and let the caller fall back.
  if (!(await nextPull(8_000)) || cancelled) {
    port.postMessage({ type: "abort" });
    port.close();
    window.clearInterval(ping);
    frame.remove();
    return null;
  }
  credits += 1;

  const STALL_MS = 120_000;
  const stalled = () => new Error("The download stopped before it finished. Try again.");
  let settled = false;
  return {
    async write(chunk) {
      if (cancelled) throw abortError();
      if (!(await nextPull(STALL_MS))) throw stalled();
      if (cancelled) throw abortError();
      const copy = chunk.slice();
      port.postMessage({ type: "chunk", bytes: copy.buffer }, [copy.buffer]);
    },
    async finish() {
      if (settled) return;
      settled = true;
      if (!cancelled) {
        if (!(await nextPull(STALL_MS))) {
          port.postMessage({ type: "abort" });
          port.close();
          cleanup();
          throw stalled();
        }
        port.postMessage({ type: "end" });
      }
      port.close();
      cleanup();
      if (cancelled) throw abortError();
    },
    async abort() {
      if (settled) return;
      settled = true;
      port.postMessage({ type: "abort" });
      port.close();
      cleanup();
    },
  };
}

/** Last resort: a temp file in the site's private storage, removed as soon as possible. */
async function beginOpfsSave(safeName: string): Promise<ByteSink> {
  const rootPromise = storageRoot();
  if (!rootPromise) {
    throw new Error("This browser cannot save a file this large. Try Chrome or Edge.");
  }
  const root = await rootPromise;
  const tempName = `${TEMP_PREFIX}${crypto.randomUUID()}`;
  const release = holdLock(`${LOCK_PREFIX}${tempName}`);
  const handle = await root.getFileHandle(tempName, { create: true });
  const writable = await handle.createWritable();
  const remove = async () => {
    await root.removeEntry(tempName).catch(() => undefined);
    release();
  };
  let settled = false;
  return {
    write: (chunk) => writable.write(chunk),
    async finish() {
      if (settled) return;
      settled = true;
      await writable.close();
      const file = await handle.getFile();
      const href = URL.createObjectURL(file);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = safeName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Give the browser time to copy the file out, scaled to its size. If the
      // tab closes first, the lock ends and the next visit sweeps the file.
      const delay = Math.min(10 * 60 * 1000, 30_000 + Math.ceil(file.size / (50 * 1024 * 1024)) * 1000);
      window.setTimeout(() => {
        URL.revokeObjectURL(href);
        void remove();
      }, delay);
    },
    async abort() {
      if (settled) return;
      settled = true;
      await writable.abort().catch(() => undefined);
      await remove();
    },
  };
}

/**
 * Order of preference: the browser's save picker (opened before any other
 * await so the click still counts as the user's gesture), then a streamed
 * download through the save worker (nothing kept in site storage), then a
 * temp file in the site's private storage. The worker path checks that the
 * browser really started the download and falls back if it did not.
 */
export async function beginSave(filename: string): Promise<ByteSink> {
  const safeName = sanitizeName(filename);
  const picker = (
    window as unknown as {
      showSaveFilePicker?: (options: { suggestedName?: string }) => Promise<{
        createWritable: () => Promise<Writable>;
      }>;
    }
  ).showSaveFilePicker;
  if (typeof picker === "function") {
    const handle = await picker({ suggestedName: safeName });
    const writable = await handle.createWritable();
    let settled = false;
    return {
      write: (chunk) => writable.write(chunk),
      async finish() {
        if (settled) return;
        settled = true;
        await writable.close();
      },
      async abort() {
        if (settled) return;
        settled = true;
        await writable.abort();
      },
    };
  }

  const streamed = await beginWorkerSave(safeName);
  if (streamed) return streamed;
  return beginOpfsSave(safeName);
}
