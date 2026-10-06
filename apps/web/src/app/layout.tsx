import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Space_Grotesk } from "next/font/google";

import "../index.css";
import Header from "@/components/header";
import Providers from "@/components/providers";

const displayFont = Space_Grotesk({
  display: "swap",
  subsets: ["latin"],
  variable: "--ji-font-display",
  weight: ["500", "600", "700"],
});

const sansFont = IBM_Plex_Sans({
  display: "swap",
  subsets: ["latin"],
  variable: "--ji-font-sans",
  weight: ["400", "500", "600"],
});

const monoFont = IBM_Plex_Mono({
  display: "swap",
  subsets: ["latin"],
  variable: "--ji-font-mono",
  weight: ["400", "500", "600"],
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
