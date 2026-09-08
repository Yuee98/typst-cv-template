import "server-only";

/** Source commit embedded by Next's build configuration; diagnostic only. */
export function runtimeBuildProvenance(): string | null {
  const commit = process.env.CV_SOURCE_COMMIT;
  return commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null;
}
