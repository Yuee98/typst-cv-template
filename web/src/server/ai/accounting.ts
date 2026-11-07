import { z } from "zod";
import { assertNormalizedUsage, type NormalizedUsage } from "./inference";
const nanos = z.string().regex(/^(0|[1-9][0-9]*)$/).refine(value => BigInt(value) <= BigInt("9223372036854775807"));
export const priceSchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  calculator_kind: z.literal("linear_token_v1"),
  parameters: z.strictObject({}),
  components: z.strictObject({
    INPUT_STANDARD: nanos,
    INPUT_CACHE_READ: nanos,
    INPUT_CACHE_WRITE: nanos,
    OUTPUT: nanos
  })
});
export type Price = z.infer<typeof priceSchema>;
/** Sum exact integer products and round up once; reasoning is already included in output. */
export function calculateCost(usage: NormalizedUsage, raw: Price): {
  estimated: string | null;
  known: string | null;
  reasons: string[];
} {
  const price = priceSchema.parse(raw);
  assertNormalizedUsage(usage);
  const r = price.components;
  let numerator = BigInt(usage.inputStandardTokens) * BigInt(r.INPUT_STANDARD) + BigInt(usage.inputCacheReadTokens) * BigInt(r.INPUT_CACHE_READ) + BigInt(usage.outputTokens) * BigInt(r.OUTPUT);
  const reasons: string[] = [];
  if (usage.inputCacheWriteTokens === null) {
    if (BigInt(r.INPUT_CACHE_WRITE) !== BigInt(0)) reasons.push("INPUT_CACHE_WRITE_UNKNOWN");
  } else if (usage.inputCacheWriteTokens > 0) {
    numerator += BigInt(usage.inputCacheWriteTokens) * BigInt(r.INPUT_CACHE_WRITE);
  }
  if (!usage.usageComplete) reasons.push("USAGE_INCOMPLETE");
  const amount = (numerator + BigInt(999999)) / BigInt(1000000);
  if (amount > BigInt("9223372036854775807")) return {
    estimated: null,
    known: null,
    reasons: ["COST_OVERFLOW"]
  };
  return {
    estimated: reasons.length ? null : amount.toString(),
    known: amount.toString(),
    reasons
  };
}
export function usageForDatabase(usage: NormalizedUsage | null) {
  return usage === null ? {
    input_total: null,
    cache_read: null,
    cache_write: null,
    input_standard: null,
    output: null,
    reasoning: null
  } : {
    input_total: String(usage.inputTotalTokens),
    cache_read: String(usage.inputCacheReadTokens),
    cache_write: usage.inputCacheWriteTokens === null ? null : String(usage.inputCacheWriteTokens),
    input_standard: String(usage.inputStandardTokens),
    output: String(usage.outputTokens),
    reasoning: usage.reasoningTokens === null ? null : String(usage.reasoningTokens)
  };
}
