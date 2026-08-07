/**
 * Build-time browser gate for every AI Polish entry point and its matching
 * product copy. Only the exact string "true" enables the feature so static
 * exports and closed-state server deployments do not advertise unavailable
 * functionality.
 */
export function isAiPolishUiEnabled(
  flagValue: string | undefined = process.env.NEXT_PUBLIC_AI_POLISH_ENABLED,
): boolean {
  return flagValue === "true";
}
