const PUBLIC_PATH = /^\/(?:zh|en)(?:\/(?:terms|privacy|ai-terms))?\/?$/;

export function filterPublicEvent<T extends { url: string }>(event: T, currentUrl: string): T | null {
  try {
    const current = new URL(currentUrl);
    const target = new URL(event.url, current.origin);
    if (target.origin !== current.origin || !PUBLIC_PATH.test(current.pathname)
      || !PUBLIC_PATH.test(target.pathname)) return null;
    // Query and hash are never useful dimensions for these four public pages.
    target.search = "";
    target.hash = "";
    return { ...event, url: target.href };
  } catch {
    return null;
  }
}
