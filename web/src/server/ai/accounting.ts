import { z } from "zod";
import type { NormalizedUsage } from "./inference";
const nanos = z.string().regex(/^(0|[1-9][0-9]*)$/).refine(value => BigInt(value) <= BigInt("9223372036854775807"));
/** The database alone calculates cost from these four frozen native-currency rates. */
export const priceSchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  input_standard_nanos_per_million: nanos,
  input_cache_read_nanos_per_million: nanos,
  input_cache_write_nanos_per_million: nanos,
  output_nanos_per_million: nanos
});
export type Price = z.infer<typeof priceSchema>;
export function usageForDatabase(usage: NormalizedUsage | null) {
  const decimal = (value: number | null | undefined) => value == null ? null : String(value);
  return {
    input_total: decimal(usage?.inputTotalTokens),
    input_standard: decimal(usage?.inputStandardTokens),
    cache_read: decimal(usage?.inputCacheReadTokens),
    cache_write: decimal(usage?.inputCacheWriteTokens),
    output: decimal(usage?.outputTokens),
    reasoning: decimal(usage?.reasoningTokens)
  };
}
