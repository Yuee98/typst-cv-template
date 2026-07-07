import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

import { ThemeProvider } from "@/components/theme/theme-provider";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Online CV Builder | Typst CV Maker",
  description: "Create, preview, export, and optionally sync CV documents.",
};

/**
 * Root layout shared by every route.
 *
 * The theme provider lives here, above the `[locale]` segment, so it is NOT
 * remounted when the user switches language. Next.js keys the `[locale]`
 * segment by its param value (`createRouterCacheKey` => `locale|<locale>|...`),
 * so changing the locale remounts the whole `[locale]` subtree. Keeping the
 * theme provider out of that subtree prevents next-themes' no-flash `<script>`
 * from being re-created during a client-side render, which is what triggered
 * the "Encountered a script tag while rendering React component" warning.
 *
 * `<html lang>` is intentionally omitted here (the root layout does not know
 * the active locale); it is mirrored onto `documentElement` by `HtmlLangSync`
 * from the `[locale]` layout.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} antialiased`}
    >
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
        </ThemeProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
