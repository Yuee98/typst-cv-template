/**
 * Output validation pipeline for the AI polish feature (unit 2.2).
 *
 * Source of truth: tmp/ai-polish-roadmap.md —「架构决策：系统 prompt 与输出验证」
 * 「输出与验证流水线」. Checkpoints run in roadmap order:
 *
 *   finish_reason → non-empty body → JSON parse → zod schema → ID exact-set →
 *   per-item non-empty → per-item length cap → total length cap →
 *   language rough check → protected spans (per item, multiset compare)
 *
 * The HTTP-success checkpoint is enforced upstream by the provider, which
 * throws on non-2xx (roadmap「职责边界」); this pipeline starts at
 * finish_reason. The model output is always treated as untrusted input
 * (roadmap Invariant 5).
 *
 * Failure reasons are concise, English, and model-feedable: they are embedded
 * in the retry prompt. They reference item ids and protected tokens only and
 * never quote CV body text, so they stay within the logging constraints of
 * roadmap Invariant 8 (handlers must still log only the stage, not reasons).
 */

import { z } from "zod";
import {
  MAX_TOTAL_POLISHED_CHARS,
  maxPolishedCharsForItem,
  type PolishItem,
  type PolishLanguage,
} from "@/lib/polish/contract";

/**
 * Version stamp recorded in the request ledger metadata by the handler
 * (roadmap validator_version column). Bump on any validation-rule change.
 */
export const POLISH_VALIDATOR_VERSION = "2026-08-validator-v1";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Normalized finish reasons, structurally identical to the provider's. */
export type ProviderFinishReason =
  | "stop"
  | "length"
  | "content_filter"
  | "insufficient_system_resource"
  | "unknown";

export interface RawModelOutput {
  text: string;
  finishReason: ProviderFinishReason;
}

export const POLISH_VALIDATION_FAILURE_STAGES = Object.freeze([
  "finish_reason",
  "empty_content",
  "json_parse",
  "schema_validation",
  "id_set_mismatch",
  "empty_item",
  "length_cap",
  "total_length_cap",
  "language_mismatch",
  "protected_spans",
] as const);

export type PolishValidationFailureStage =
  (typeof POLISH_VALIDATION_FAILURE_STAGES)[number];

export interface PolishValidationFailure {
  ok: false;
  stage: PolishValidationFailureStage;
  /**
   * "invalid_output" → final API error INVALID_MODEL_OUTPUT (502);
   * "upstream" → treated as an upstream failure (roadmap:
   * insufficient_system_resource is an upstream fault, quota refundable).
   */
  classification: "invalid_output" | "upstream";
  /** Concise model-feedable reason (no CV body text). Fed back on retry. */
  reason: string;
}

export interface PolishValidationSuccess {
  ok: true;
  items: { id: string; polished: string }[];
}

export type PolishValidationResult = PolishValidationSuccess | PolishValidationFailure;

function fail(
  stage: PolishValidationFailureStage,
  classification: "invalid_output" | "upstream",
  reason: string,
): PolishValidationFailure {
  return { ok: false, stage, classification, reason };
}

// ---------------------------------------------------------------------------
// Length caps (roadmap「长度策略」: hard upper bound only)
// ---------------------------------------------------------------------------

/**
 * Hard per-item cap: min(2400, ceil(original × 1.5) + 40) — the CP1-frozen
 * single-source helper from the contract. There is exactly ONE
 * implementation (contract.ts); this alias only keeps the historic export
 * name for existing callers/tests.
 */
export const perItemPolishedCharCap = maxPolishedCharsForItem;

// ---------------------------------------------------------------------------
// Language rough check (roadmap: only block obviously wrong-language output;
// short text and mixed zh/en text skip hard rejection)
// ---------------------------------------------------------------------------

const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const LATIN_CHAR = /[A-Za-z]/g;

/** Below this many letters the check is skipped (short text is ambiguous). */
const LANGUAGE_CHECK_MIN_CHARS = 20;
/** Fail only when ≥90% of the letters are in the wrong script. */
const LANGUAGE_WRONG_SCRIPT_RATIO = 0.9;

export function passesLanguageRoughCheck(text: string, language: PolishLanguage): boolean {
  const cjk = text.match(CJK_CHAR)?.length ?? 0;
  const latin = text.match(LATIN_CHAR)?.length ?? 0;
  const total = cjk + latin;
  if (total < LANGUAGE_CHECK_MIN_CHARS) return true;
  const cjkRatio = cjk / total;
  if (language === "zh") return cjkRatio >= 1 - LANGUAGE_WRONG_SCRIPT_RATIO;
  return cjkRatio <= LANGUAGE_WRONG_SCRIPT_RATIO;
}

// ---------------------------------------------------------------------------
// Protected spans (roadmap: numbers & counts, currencies, percentages,
// dates/times, units, URLs, version numbers, code-like technical names)
// ---------------------------------------------------------------------------

/**
 * Single scanning pattern; alternatives are ordered by priority (earliest
 * wins at a given position). The SAME extraction runs on original and output,
 * so tokenizer quirks apply equally to both sides of the multiset compare.
 *
 * Ordering invariants (do not regress):
 * - the currency-magnitude form (£27bn) precedes the plain currency form so
 *   the magnitude suffix is never truncated away;
 * - number+unit forms (200 ms / 32 GB) precede the plain-number forms so the
 *   unit is never split off its number;
 * - the multiword phrase form (SQL Server) precedes the single-word acronym
 *   form so the phrase is captured whole.
 */
const PROTECTED_TOKEN_SOURCES: readonly string[] = [
  // URLs (brackets/quotes/CJK sentence punctuation terminate the token)
  String.raw`https?:\/\/[^\s"'<>()\[\]{}（）【】「」、。，；：！？…]+`,
  // Chinese dates: 2024年8月15日 / 2024年8月 / 2024年 / 8月15日
  String.raw`\d{4}\s*年(?:\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)?`,
  String.raw`\d{1,2}\s*月\s*\d{1,2}\s*日`,
  // ISO-ish dates: 2024-08-15 / 2024/08 (boundary-guarded so 2024-2025 scans as two numbers)
  String.raw`(?<![\d/.-])\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?(?![\d/.-])`,
  // English month-year: Jan 2024 / January, 2024 / 2024 Jan
  String.raw`(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*,?\s*\d{4}`,
  String.raw`\d{4}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?`,
  // Times: 14:30 / 14:30:00
  String.raw`(?<![\d:.])\d{1,2}:\d{2}(?::\d{2})?(?![\d:.])`,
  // Version numbers: v1.2.3 / 1.2.3 / 1.2
  String.raw`(?<![\w.])v?\d+(?:\.\d+){1,3}(?![\w.])`,
  // Percentages: 40% / 40％
  String.raw`\d+(?:\.\d+)?\s*[%％]`,
  // Currency with magnitude suffix FIRST (£27bn / $3m / ¥2k) so the suffix is
  // never truncated to the bare amount (£27bn must not scan as £27)
  String.raw`[$€£¥￥]\s*\d[\d,]*(?:\.\d+)?\s*(?:bn|tn|m|k)(?![A-Za-z])`,
  // Currencies: $1,000 / ¥300 / 100 USD / 300美元
  String.raw`[$€£¥￥]\s*\d[\d,]*(?:\.\d+)?`,
  String.raw`\d[\d,]*(?:\.\d+)?\s*(?:USD|CNY|RMB|EUR|GBP|JPY|HKD|dollars?|元|美元|欧元|日元|人民币|港元)`,
  // Number + unit, whitespace optional (200 ms / 32 GB / 5GHz): longest unit
  // alternatives first, and the unit is required so bare numbers fall through
  String.raw`\d+(?:\.\d+)?\s*(?:ms|GHz|MHz|kHz|KiB|MiB|GiB|TiB|KB|MB|GB|TB|PB|kWh|Hz|kW|MW|kg|mg|km|cm|mm|lb|sec|min|hr|[WVEhsmg])(?![A-Za-z])`,
  // Multiword technical names as a phrase: an ALL-CAPS word followed by
  // capitalized words (SQL Server, API Gateway). Must precede the
  // single-word acronym pattern below so "SQL Server" is captured whole.
  String.raw`\b[A-Z]{2,}\d*(?:\s+[A-Z][A-Za-z0-9]*)+`,
  // Code-like technical names
  String.raw`(?<![\w.])(?:\.[A-Za-z0-9]+)+`, // leading-dot frameworks: .NET
  String.raw`[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+`, // Node.js, ASP.NET
  String.raw`\b[A-Za-z](?:\+\+|#)(?![\w+#])`, // C++, C#, F# (lookahead: \b fails before CJK/space)
  String.raw`[A-Za-z]*[a-z][A-Z][A-Za-z0-9]*`, // camelCase/PascalCase: JavaScript, iOS, eBay
  String.raw`[A-Za-z][A-Za-z0-9]*\d[A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*`, // letter-led alnum mixes: P99, ES6, SHA256
  String.raw`\d+[A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*`, // digit-led alnum mixes: 200ms, 5G, 3D
  String.raw`\b[A-Z]{2,}\d*\b`, // all-caps acronyms/terms: API, SDK, KPI
  // Numbers and counts (comma groups, decimals, optional CJK magnitude suffix 万/亿/千/百)
  String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?[万亿千百]?`,
  String.raw`\d+(?:\.\d+)?[万亿千百]?`,
];

const PROTECTED_TOKEN_PATTERN = new RegExp(PROTECTED_TOKEN_SOURCES.join("|"), "g");

/** Whitespace inside a token is insignificant ("2024 年" ≡ "2024年"); trailing sentence punctuation is dropped. */
function normalizeProtectedToken(token: string): string {
  return token.replace(/\s+/g, "").replace(/[.,;:!?。，；：！？]+$/, "");
}

/** Extract the protected-span multiset (as a sorted token array) from text. */
export function extractProtectedTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(PROTECTED_TOKEN_PATTERN)) {
    const normalized = normalizeProtectedToken(match[0]);
    if (normalized.length > 0) tokens.push(normalized);
  }
  return tokens.sort();
}

export interface ProtectedTokenDiff {
  /** Tokens whose output count is lower than the original count (lost). */
  missing: string[];
  /** Tokens whose output count is higher than the original count (invented/duplicated). */
  added: string[];
}

/**
 * Multiset compare of protected spans (roadmap「multiset 比较」): exact
 * equality per token. Losing a token (including merging two identical
 * numbers into one, e.g. "30% … 30%" → "30%") fails; so does inventing or
 * duplicating one — an invented metric is a fact change. Mismatches are fed
 * back verbatim on retry, so the second attempt can restore the counts.
 */
export function diffProtectedTokens(original: string, polished: string): ProtectedTokenDiff {
  const counts = new Map<string, number>();
  for (const token of extractProtectedTokens(original)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  for (const token of extractProtectedTokens(polished)) {
    counts.set(token, (counts.get(token) ?? 0) - 1);
  }
  const missing: string[] = [];
  const added: string[] = [];
  for (const [token, count] of counts) {
    if (count < 0) added.push(`"${token}" ×${-count}`);
    if (count > 0) missing.push(`"${token}" ×${count}`);
  }
  return { missing, added };
}

// ---------------------------------------------------------------------------
// Output schema (structure only; semantic checkpoints run separately)
// ---------------------------------------------------------------------------

const polishModelOutputSchema = z.object({
  items: z
    .array(z.object({ id: z.string().min(1), polished: z.string() }))
    .min(1),
});

// ---------------------------------------------------------------------------
// Validation pipeline
// ---------------------------------------------------------------------------

const MAX_REASON_ENTRIES = 5;

export function validatePolishOutput(
  output: RawModelOutput,
  context: { items: PolishItem[]; language: PolishLanguage },
): PolishValidationResult {
  // 1. finish_reason — only "stop" enters normal validation; "length" is a
  // truncated (invalid) output; insufficient_system_resource is an upstream
  // fault (roadmap finish_reason semantics).
  if (output.finishReason !== "stop") {
    if (output.finishReason === "insufficient_system_resource") {
      return fail(
        "finish_reason",
        "upstream",
        `provider finish_reason "${output.finishReason}" (upstream capacity problem)`,
      );
    }
    if (output.finishReason === "length") {
      return fail("finish_reason", "invalid_output", `model output was truncated (finish_reason "length")`);
    }
    return fail("finish_reason", "invalid_output", `abnormal finish_reason "${output.finishReason}"`);
  }

  // 2. non-empty body
  if (output.text.trim().length === 0) {
    return fail("empty_content", "invalid_output", "response body is empty");
  }

  // 3. JSON parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.text);
  } catch {
    return fail("json_parse", "invalid_output", "response body is not valid JSON");
  }

  // 4. zod structure
  const schemaResult = polishModelOutputSchema.safeParse(parsed);
  if (!schemaResult.success) {
    const issue = schemaResult.error.issues[0];
    const path = issue?.path.join(".") ?? "";
    return fail(
      "schema_validation",
      "invalid_output",
      `response does not match {"items":[{"id","polished"}]} (${path}: ${issue?.message ?? "invalid"})`,
    );
  }
  const outputItems = schemaResult.data.items;

  // 5. ID exact-set: output ids must match request item ids one-to-one.
  const expectedIds = context.items.map((item) => item.id);
  const expectedCounts = new Map<string, number>();
  for (const id of expectedIds) expectedCounts.set(id, (expectedCounts.get(id) ?? 0) + 1);
  const actualCounts = new Map<string, number>();
  for (const item of outputItems) actualCounts.set(item.id, (actualCounts.get(item.id) ?? 0) + 1);
  const missingIds: string[] = [];
  const unexpectedIds: string[] = [];
  const duplicateIds: string[] = [];
  for (const id of expectedCounts.keys()) {
    const actual = actualCounts.get(id) ?? 0;
    if (actual === 0) missingIds.push(id);
    if (actual > 1) duplicateIds.push(id);
  }
  for (const id of actualCounts.keys()) {
    if (!expectedCounts.has(id)) unexpectedIds.push(id);
  }
  if (missingIds.length > 0 || unexpectedIds.length > 0 || duplicateIds.length > 0) {
    const parts: string[] = [];
    if (missingIds.length > 0) parts.push(`missing ids: ${missingIds.slice(0, MAX_REASON_ENTRIES).join(", ")}`);
    if (unexpectedIds.length > 0) parts.push(`unexpected ids: ${unexpectedIds.slice(0, MAX_REASON_ENTRIES).join(", ")}`);
    if (duplicateIds.length > 0) parts.push(`duplicate ids: ${duplicateIds.slice(0, MAX_REASON_ENTRIES).join(", ")}`);
    return fail("id_set_mismatch", "invalid_output", `output item ids do not match the request (${parts.join("; ")})`);
  }

  const originalById = new Map(context.items.map((item) => [item.id, item]));

  // 6. per-item non-empty
  const emptyIds = outputItems.filter((item) => item.polished.trim().length === 0).map((item) => item.id);
  if (emptyIds.length > 0) {
    return fail(
      "empty_item",
      "invalid_output",
      `polished text is empty for ids: ${emptyIds.slice(0, MAX_REASON_ENTRIES).join(", ")}`,
    );
  }

  // 7. per-item length cap: min(2400, ceil(original × 1.5) + 40)
  for (const item of outputItems) {
    const original = originalById.get(item.id);
    if (!original) continue; // unreachable after the exact-set check
    const cap = perItemPolishedCharCap(original.text.length);
    if (item.polished.length > cap) {
      return fail(
        "length_cap",
        "invalid_output",
        `polished text for id "${item.id}" is ${item.polished.length} chars, exceeding the cap of ${cap} (original ${original.text.length} chars)`,
      );
    }
  }

  // 8. total output cap
  const totalPolishedChars = outputItems.reduce((sum, item) => sum + item.polished.length, 0);
  if (totalPolishedChars > MAX_TOTAL_POLISHED_CHARS) {
    return fail(
      "total_length_cap",
      "invalid_output",
      `total polished length ${totalPolishedChars} chars exceeds MAX_TOTAL_POLISHED_CHARS (${MAX_TOTAL_POLISHED_CHARS})`,
    );
  }

  // 9. language rough check (per item; short/mixed text skips hard rejection)
  for (const item of outputItems) {
    if (!passesLanguageRoughCheck(item.polished, context.language)) {
      return fail(
        "language_mismatch",
        "invalid_output",
        `polished text for id "${item.id}" is not primarily in the required output language "${context.language}"`,
      );
    }
  }

  // 10. protected spans (per item, multiset compare)
  for (const item of outputItems) {
    const original = originalById.get(item.id);
    if (!original) continue; // unreachable after the exact-set check
    const diff = diffProtectedTokens(original.text, item.polished);
    if (diff.missing.length > 0 || diff.added.length > 0) {
      const parts: string[] = [];
      if (diff.missing.length > 0) parts.push(`lost protected tokens: ${diff.missing.slice(0, MAX_REASON_ENTRIES).join(", ")}`);
      if (diff.added.length > 0) parts.push(`invented or duplicated protected tokens: ${diff.added.slice(0, MAX_REASON_ENTRIES).join(", ")}`);
      return fail(
        "protected_spans",
        "invalid_output",
        `polished text for id "${item.id}" must preserve numbers, dates, currencies, URLs, versions and technical names verbatim (${parts.join("; ")})`,
      );
    }
  }

  return { ok: true, items: outputItems.map((item) => ({ id: item.id, polished: item.polished })) };
}
