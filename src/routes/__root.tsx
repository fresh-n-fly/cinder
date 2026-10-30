import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useEffect } from "react";
import { Toaster } from "sonner";
import { APP_NAME, APP_TAGLINE } from "@/lib/constants";
import appCss from "../styles.css?url";

const title = `${APP_NAME} — ${APP_TAGLINE}`;

/** Remove decrypted temp files an earlier visit may have left in this browser. */
function StorageSweep() {
  useEffect(() => {
    void import("@/lib/save-file").then((module) => module.sweepStaleSaves()).catch(() => undefined);
  }, []);
  return null;
}
const description =
  "Send files that vanish. Lock them with a password, choose when they expire, and they are deleted for good.";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title },
      { name: "description", content: description },
      { name: "theme-color", content: "#0a0b0c" },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:image", content: "/og.jpg" },
      { property: "og:type", content: "website" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  component: () => (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="antialiased">
        <Outlet />
        <StorageSweep />
        <Toaster
          theme="dark"
          position="bottom-center"
          toastOptions={{
            style: {
              background: "#121417",
              color: "#eef0f2",
              border: "1px solid rgba(238,240,242,0.12)",
            },
          }}
        />
        <Scripts />
      </body>
    </html>
  ),
});
