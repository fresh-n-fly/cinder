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

function sanitizeName(name: string): string {
  const base = name.replace(/[/\\]/g, "_").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return base.slice(0, 180) || "download";
}

/**
 * Open a disk stream before any other await so the browser still counts this
 * click as the user's gesture. Falls back to the origin-private file system
 * when the browser has no save picker.
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

  const storage = navigator.storage as unknown as {
    getDirectory?: () => Promise<{
      getFileHandle: (
        name: string,
        opts: { create: boolean },
      ) => Promise<{ getFile: () => Promise<File>; createWritable: () => Promise<Writable> }>;
      removeEntry: (name: string) => Promise<void>;
    }>;
  };
  if (!storage.getDirectory) {
    throw new Error("This browser cannot save a file this large. Try Chrome or Edge.");
  }
  const root = await storage.getDirectory();
  const tempName = `cinder-${crypto.randomUUID()}`;
  const handle = await root.getFileHandle(tempName, { create: true });
  const writable = await handle.createWritable();
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
      window.setTimeout(() => {
        URL.revokeObjectURL(href);
        void root.removeEntry(tempName).catch(() => undefined);
      }, 120_000);
    },
    async abort() {
      if (settled) return;
      settled = true;
      await writable.abort().catch(() => undefined);
      await root.removeEntry(tempName).catch(() => undefined);
    },
  };
}
