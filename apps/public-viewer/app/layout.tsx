import { getBasePath, getImageFromServerSrc } from "@/app/utils/image-src";
import { Provider } from "@/components/ui/provider";
import { GoogleAnalytics } from "@next/third-parties/google";
import type { Metadata } from "next";
import "./global.css";

const enableGA =
  !!process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID &&
  (process.env.ENVIRONMENT === "production" || process.env.NODE_ENV === "production");

export const metadata: Metadata = {
  title: {
    default: "広聴AIオンライン",
    template: "%s - 広聴AIオンライン",
  },
  description: "広聴AIオンライン",
};

if (process.env.NEXT_PUBLIC_OUTPUT_MODE !== "export") {
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "http://localhost:3000");
  metadata.metadataBase = new URL(siteUrl + getBasePath());
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html suppressHydrationWarning lang={"ja"}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=BIZ+UDPGothic&display=swap" rel="stylesheet" />

        <link rel={"icon"} href={getImageFromServerSrc("/meta/icon.png")} sizes={"any"} />

        {enableGA && <GoogleAnalytics gaId={process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || ""} />}
      </head>
      <body>
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
