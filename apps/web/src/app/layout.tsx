import type { Metadata } from "next";
import type { ReactNode } from "react";
import "../globals.css";
import { ToastProvider } from "../components/ui/index.tsx";
import { metadataBase, SITE_DESCRIPTION, socialMetadata } from "../lib/site-metadata.ts";

export const metadata: Metadata = {
  metadataBase,
  title: "RuleBranch",
  description: SITE_DESCRIPTION,
  icons: {
    icon: [
      { url: "/favicon.ico", type: "image/x-icon", sizes: "16x16 32x32 48x48" },
      { url: "/brand/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/brand/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/brand/apple-touch-icon.png", type: "image/png", sizes: "180x180" }],
  },
  ...socialMetadata("/", "RuleBranch"),
};

// Every route depends on the per-request session/runtime (composition root wired via
// instrumentation at server startup, never during `next build`'s static generation
// workers), so nothing in this app can be meaningfully prerendered as static HTML.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="ja"><body><ToastProvider>{children}</ToastProvider></body></html>;
}
