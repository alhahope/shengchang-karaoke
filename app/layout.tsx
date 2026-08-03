import type { Metadata } from "next";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
  ?? "https://shengchang-karaoke.re-xgrant9838.chatgpt.site";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const title = "声场 · 你的私人K歌房";
const description = "在电脑上导入伴奏和歌词，开启麦克风，录下你的演唱。";
const iconPath = `${basePath}/favicon.png`;
const socialImageUrl = `${siteUrl}/og.png`;

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  icons: { icon: iconPath, shortcut: iconPath },
  openGraph: {
    title,
    description,
    type: "website",
    images: [{ url: socialImageUrl, width: 1728, height: 917, alt: "声场—你的私人K歌房" }],
  },
  twitter: { card: "summary_large_image", title, description, images: [socialImageUrl] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
