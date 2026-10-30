/*
 * Cinder save worker.
 *
 * Browsers without a "save file" picker cannot stream a large download from
 * a page. This worker turns decrypted bytes posted by the page into a normal
 * file download, so plaintext goes straight to the browser's download and is
 * never written to the site's own storage.
 *
 * It only answers /__cinder-save/<id> for an id the page registered a moment
 * earlier. Every other request passes through untouched.
 */
const PREFIX = "/__cinder-save/";
const pending = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function safeName(name) {
  const cleaned = String(name || "download").replace(/[\u0000-\u001f\u007f"\\/]/g, "_").slice(0, 180);
  return cleaned || "download";
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "cinder-save" || typeof data.id !== "string" || !event.ports[0]) return;
  const port = event.ports[0];
  const queue = [];
  let wake = null;
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });

  port.onmessage = (message) => {
    queue.push(message.data);
    if (wake) {
      const resume = wake;
      wake = null;
      resume();
    }
  };

  const next = () =>
    new Promise((resolve) => {
      if (queue.length) resolve(queue.shift());
      else wake = () => resolve(queue.shift());
    });

  const stream = new ReadableStream(
    {
      async pull(controller) {
        port.postMessage({ type: "pull" });
        const message = await next();
        if (message?.type === "chunk") {
          controller.enqueue(new Uint8Array(message.bytes));
        } else if (message?.type === "end") {
          controller.close();
          port.close();
          finished();
        } else {
          controller.error(new Error("Save aborted."));
          port.close();
          finished();
        }
      },
      cancel() {
        port.postMessage({ type: "cancelled" });
        port.close();
        finished();
      },
    },
    // Zero: pull only when the download actually reads, so the page can tell
    // whether the browser really started it.
    { highWaterMark: 0 },
  );

  pending.set(data.id, { stream, name: safeName(data.name) });
  // Unclaimed registrations do not linger.
  setTimeout(() => pending.delete(data.id), 30_000);
  port.postMessage({ type: "ready" });
  event.waitUntil(done);
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return;
  const id = url.pathname.slice(PREFIX.length);
  const entry = pending.get(id);
  pending.delete(id);
  if (!entry) {
    event.respondWith(new Response("Not found", { status: 404 }));
    return;
  }
  event.respondWith(
    new Response(entry.stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    }),
  );
});
