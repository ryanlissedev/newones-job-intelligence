import type { Metadata } from "next";
import localFont from "next/font/local";

import "../index.css";
import Header from "@/components/header";
import Providers from "@/components/providers";

// Self-hosted (OFL-1.1, latin subset from @fontsource 5.3.0, see ./fonts/LICENSE-*.txt) so the
// build never fetches Google Fonts: a failed fonts.googleapis.com fetch broke CI and Coolify builds.
const displayFont = localFont({
  display: "swap",
  src: [
    {
      path: "./fonts/space-grotesk-latin-500-normal.woff2",
      style: "normal",
      weight: "500",
    },
    {
      path: "./fonts/space-grotesk-latin-600-normal.woff2",
      style: "normal",
      weight: "600",
    },
    {
      path: "./fonts/space-grotesk-latin-700-normal.woff2",
      style: "normal",
      weight: "700",
    },
  ],
  variable: "--ji-font-display",
});

const sansFont = localFont({
  display: "swap",
  src: [
    {
      path: "./fonts/ibm-plex-sans-latin-400-normal.woff2",
      style: "normal",
      weight: "400",
    },
    {
      path: "./fonts/ibm-plex-sans-latin-500-normal.woff2",
      style: "normal",
      weight: "500",
    },
    {
      path: "./fonts/ibm-plex-sans-latin-600-normal.woff2",
      style: "normal",
      weight: "600",
    },
  ],
  variable: "--ji-font-sans",
});

const monoFont = localFont({
  display: "swap",
  src: [
    {
      path: "./fonts/ibm-plex-mono-latin-400-normal.woff2",
      style: "normal",
      weight: "400",
    },
    {
      path: "./fonts/ibm-plex-mono-latin-500-normal.woff2",
      style: "normal",
      weight: "500",
    },
    {
      path: "./fonts/ibm-plex-mono-latin-600-normal.woff2",
      style: "normal",
      weight: "600",
    },
  ],
  variable: "--ji-font-mono",
});

export const metadata: Metadata = {
  description:
    "Doorzoek opdrachten uit meerdere bronnen met snelle Boolean search en volledige herkomstinformatie.",
  title: "Newones",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="nl"
      suppressHydrationWarning
      className={`${displayFont.variable} ${sansFont.variable} ${monoFont.variable}`}
    >
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <Providers>
          <div className="grid min-h-dvh w-full min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr]">
            <a
              href="#main-content"
              className="fixed top-2 left-2 z-[100] -translate-y-20 rounded-md bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-transform focus:translate-y-0 focus:outline-none focus:ring-2 focus:ring-ring"
            >
              Naar hoofdinhoud
            </a>
            <Header />
            {children}
          </div>
        </Providers>
      </body>
    </html>
  );
}
