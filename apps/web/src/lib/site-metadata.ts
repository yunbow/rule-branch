import type { Metadata } from "next";

export const SITE_DESCRIPTION = "コードの変化に合わせて、開発ルールの更新とレビューを支援します。";

const publicUrl = process.env.RULEBRANCH_PUBLIC_URL;
export const metadataBase = publicUrl ? new URL(publicUrl) : undefined;

export function socialMetadata(path: string, title: string): Pick<Metadata, "openGraph" | "twitter"> {
  if (!metadataBase) return {};

  return {
    openGraph: {
      type: "website",
      locale: "ja_JP",
      siteName: "RuleBranch",
      title,
      description: SITE_DESCRIPTION,
      url: path,
      images: [{
        url: "/brand/og-image.png",
        width: 1200,
        height: 630,
        alt: "RuleBranch — コードとともに育つ開発ルール",
      }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: SITE_DESCRIPTION,
      images: ["/brand/og-image.png"],
    },
  };
}
