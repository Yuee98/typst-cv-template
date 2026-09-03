import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// STATIC_EXPORT is owned by scripts/run-next-mode.mjs (single source of truth):
// "true"  → static export for Pages (no API routes, no AI UI — Invariant 9)
// "false" → server build for Vercel (includes the generated /api/polish routes)
const isStaticExport = process.env.STATIC_EXPORT === "true";

const nextConfig: NextConfig = {
  // trailingSlash stays on for the static export (current Pages behavior) but
  // must stay off in server mode — otherwise every POST /api/polish is met
  // with a 308 redirect to the trailing-slash URL.
  ...(isStaticExport ? { output: "export" as const, trailingSlash: true as const } : {}),
  ...(!isStaticExport
    ? {
        async headers() {
          return [
            {
              source: "/:locale/admin/:path*",
              headers: [
                { key: "Referrer-Policy", value: "no-referrer" },
              ],
            },
          ];
        },
      }
    : {}),
};

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(nextConfig);
