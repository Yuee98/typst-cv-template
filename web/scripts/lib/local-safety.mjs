/**
 * Pure safety predicates for the real-key integration smoke (CP4 round-1
 * P0-1 / P0-2.3). No IO, no process.env — unit-tested by
 * local-safety.test.mjs so the guards a release gate depends on are
 * themselves proven.
 */

/**
 * Loopback hostnames the local Supabase may listen on. WHATWG URL keeps the
 * brackets on IPv6 hostnames ("[::1]"), so matching normalizes them away.
 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

function normalizeHostname(hostname) {
  return hostname.replace(/^\[|\]$/g, "");
}

/**
 * The smoke creates auth users and mutates AI runtime configuration with the
 * service-role key, so the configured Supabase URL MUST be loopback HTTP —
 * anything else (a hosted project, a LAN box, TLS) is refused before any
 * state changes. Pure check: the caller turns !ok into a fatal error and is
 * responsible for not printing secrets (origins are safe, keys never appear).
 */
export function checkLocalSupabaseUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "http:") {
    return { ok: false, reason: `protocol must be http:, got ${url.protocol}`, origin: url.origin };
  }
  const hostname = normalizeHostname(url.hostname);
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: `hostname must be loopback, got ${hostname}`, origin: url.origin };
  }
  return { ok: true, origin: url.origin };
}

/** Official DeepSeek API origin (mirrors DEFAULT_DEEPSEEK_BASE_URL in deepseek.ts). */
export const OFFICIAL_DEEPSEEK_ORIGIN = "https://api.deepseek.com";

/**
 * True only when a custom DEEPSEEK_BASE_URL still resolves to the official
 * origin (trailing slash / sub-path tolerated — same upstream). A proxy,
 * mock, or lookalike host is NOT the official integration and must be
 * rejected (or loudly disclaimed via --allow-custom-upstream).
 */
export function isOfficialDeepSeekBaseUrl(rawBaseUrl) {
  let url;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    return false;
  }
  return url.origin === OFFICIAL_DEEPSEEK_ORIGIN;
}
