/**
 * Pure safety predicates for local integration endpoints. No IO, no process.env — unit-tested by
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
  if (url.username || url.password) return { ok: false, reason: "credentials in URL are forbidden" };
  const hostname = normalizeHostname(url.hostname);
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: `hostname must be loopback, got ${hostname}`, origin: url.origin };
  }
  return { ok: true, origin: url.origin };
}
