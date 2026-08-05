/**
 * Shared API contract for POST /api/polish.
 *
 * Source of truth: tmp/ai-polish-roadmap.md —「架构决策：API 契约」and
 * 「架构决策：润色粒度与能力矩阵」. Imported by BOTH the client (scope
 * builder / dialog) and the server (route handler); keep it free of
 * Node/DOM-specific APIs. Frozen after checkpoint CP1.
 *
 * Every wire object uses z.strictObject: unknown keys are REJECTED, never
 * silently stripped, so local-only fields (RHF `path`, header PII, …) can
 * never "validate" their way across the network boundary.
 */

import { z } from "zod";
import { ORDERED_SECTION_IDS, type CvSectionId } from "@/lib/cv/schema";

// ---------------------------------------------------------------------------
// Polishable sections, field kinds, and the capability matrix
// ---------------------------------------------------------------------------

export const POLISH_GRANULARITIES = ["item", "entry", "group", "section"] as const;
export type PolishGranularity = (typeof POLISH_GRANULARITIES)[number];

/** Free-text field kinds that v1 is allowed to polish (whitelist). */
export const POLISHABLE_FIELD_KINDS = [
  "profile",
  "skill_body",
  "experience_bullet",
  "education_bullet",
  "research_bullet",
  "additional_body",
] as const;
export type PolishableFieldKind = (typeof POLISHABLE_FIELD_KINDS)[number];

export interface PolishSectionCapability {
  /** The only field kind this section's polishable items may have. */
  readonly kind: PolishableFieldKind;
  /** Granularities offered for this section (editing scope). */
  readonly granularities: readonly PolishGranularity[];
}

/**
 * Editing-scope capability per section (roadmap capability matrix):
 *
 * - profile: item + entry (section-level is identical to entry-level, so the
 *   UI only offers two levels)
 * - skills / additional: item + section (entry-level has no independent
 *   meaning); `label` is context only
 * - experience: item + project entry + company group + section
 * - education / research: item + entry + section
 * - publications: absent on purpose — bibliographic facts, never polishable
 */
export const POLISH_CAPABILITY_MATRIX = {
  profile: { kind: "profile", granularities: ["item", "entry"] },
  skills: { kind: "skill_body", granularities: ["item", "section"] },
  experience: {
    kind: "experience_bullet",
    granularities: ["item", "entry", "group", "section"],
  },
  education: { kind: "education_bullet", granularities: ["item", "entry", "section"] },
  research: { kind: "research_bullet", granularities: ["item", "entry", "section"] },
  additional: { kind: "additional_body", granularities: ["item", "section"] },
} as const satisfies Partial<Record<CvSectionId, PolishSectionCapability>>;

export type PolishableSectionId = keyof typeof POLISH_CAPABILITY_MATRIX;

export function getSectionCapability(
  sectionId: CvSectionId,
): PolishSectionCapability | undefined {
  return (POLISH_CAPABILITY_MATRIX as Partial<Record<CvSectionId, PolishSectionCapability>>)[
    sectionId
  ];
}

// ---------------------------------------------------------------------------
// Limits — hard constraints (abuse protection), not UX hints
// ---------------------------------------------------------------------------

/** Transport cap: bodies larger than this are rejected with 413 before parsing. */
export const MAX_BODY_BYTES = 64 * 1024; // 64 KiB

export const MAX_ITEMS = 30;
export const MAX_ITEM_CHARS = 2000;
export const MAX_REFERENCES = 60;
export const MAX_REFERENCE_ITEM_CHARS = 2000;
/**
 * Per-reference label cap. Labels are prompt content (consumed by prompt
 * construction), so they also count toward the MAX_REFERENCE_CHARS aggregate
 * — every string forwarded into the prompt participates in a hard budget.
 */
export const MAX_REFERENCE_LABEL_CHARS = 200;
export const MAX_STYLE_INSTRUCTION_CHARS = 200;
export const ITEM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

/**
 * Output budget math (roadmap「总输出预算」). The AGGREGATE cap is
 * authoritative; per-item caps are sanity bounds:
 *
 * - Input: sum(items.text) ≤ MAX_TARGET_CHARS.
 * - Per result: polished.length ≤ min(MAX_POLISHED_ITEM_CHARS,
 *   ceil(original × 1.5) + PER_ITEM_POLISHED_SLACK_CHARS). The request-aware
 *   part (×1.5 + slack against the original text) is enforced by the
 *   orchestrator validator (unit 2.2); the absolute cap
 *   MAX_POLISHED_ITEM_CHARS is enforced by polishSuccessResponseSchema.
 * - Aggregate (authoritative): sum(polished.length) ≤
 *   MAX_TOTAL_POLISHED_CHARS = MAX_TARGET_CHARS × 1.5, enforced by
 *   polishSuccessResponseSchema. The sum of per-item caps can reach
 *   MAX_TARGET_CHARS × 1.5 + MAX_ITEMS × slack = 8700 > 7500; such a
 *   response is invalid by construction and burns a retry, so the token
 *   budget only needs to cover VALID responses.
 * - Tokens: the budget is a CONSERVATIVE expected-prose estimate, not a
 *   mathematical guarantee — JSON escaping inside content (quotes,
 *   backslashes, control characters) can make the raw response longer than
 *   decoded length + structural envelope, and character counts only estimate
 *   model tokens. POLISH_MAX_OUTPUT_TOKENS covers the valid worst case at
 *   ≈1 token per CJK character with real headroom; a pathological response
 *   that still overflows surfaces as finishReason "length" and is handled as
 *   ordinary invalid output / retry (unit 2.2), never as an impossible state.
 *   max_tokens per request is computed dynamically by
 *   computePolishMaxOutputTokens (single source for units 2.1/2.2), so
 *   oversized requests can neither truncate valid output nor blow up cost.
 */
export const MAX_TARGET_CHARS = 5000;
export const MAX_REFERENCE_CHARS = 10000;
export const MAX_TOTAL_POLISHED_CHARS = 7500;
/** Absolute per-result cap on polished length (roadmap: min(2400, …)). */
export const MAX_POLISHED_ITEM_CHARS = 2400;
/** Per-result slack on top of the ×1.5 polish factor (roadmap: +40). */
export const PER_ITEM_POLISHED_SLACK_CHARS = 40;
/**
 * Worst-case JSON structure of the model's raw response
 * (`{"items":[{"id":"…","polished":"…"},…]}`): 12 chars of wrapper plus,
 * per item, 24 chars of structure/separator plus up to 32 chars of id
 * (ITEM_ID_PATTERN). Does NOT cover in-content JSON escaping (see the
 * conservative-budget note above).
 */
export const POLISH_RESPONSE_ENVELOPE_CHARS = 12 + MAX_ITEMS * (24 + 32);
export const POLISH_MAX_OUTPUT_TOKENS = 10240;

/**
 * Per-result polished-length ceiling for a source text of `originalChars`
 * (the schema-level valid bound; the request-aware validator enforces the
 * same formula against the actual original text).
 */
export function maxPolishedCharsForItem(originalChars: number): number {
  return Math.min(
    MAX_POLISHED_ITEM_CHARS,
    Math.ceil(originalChars * 1.5) + PER_ITEM_POLISHED_SLACK_CHARS,
  );
}

/**
 * Dynamic max_tokens for a request — the single source of truth so units
 * 2.1/2.2 cannot reinterpret the formula independently:
 *
 *   sum of per-item valid ceilings (slack INCLUDED — many short items make
 *   the +40 dominate the ×1.5 factor) → clamped to the aggregate cap →
 *   plus the response envelope → clamped to POLISH_MAX_OUTPUT_TOKENS.
 */
export function computePolishMaxOutputTokens(items: ReadonlyArray<{ text: string }>): number {
  const maxContentChars = Math.min(
    MAX_TOTAL_POLISHED_CHARS,
    items.reduce((sum, item) => sum + maxPolishedCharsForItem(item.text.length), 0),
  );
  return Math.min(POLISH_MAX_OUTPUT_TOKENS, maxContentChars + POLISH_RESPONSE_ENVELOPE_CHARS);
}

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const itemIdSchema = z.string().regex(ITEM_ID_PATTERN);

/**
 * Wire text must carry substantive content: a whitespace-only target would
 * pass min(1) but can never produce a valid (nonblank) polished result —
 * the deterministic fake would echo it into an invalid success response,
 * and a real model would have nothing to polish. The UI's stricter <10
 * chars rule stays a UX policy on top of this wire floor.
 */
const nonBlankText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, { message: "text must not be blank" });

export const polishItemSchema = z.strictObject({
  id: itemIdSchema,
  kind: z.enum(POLISHABLE_FIELD_KINDS),
  text: nonBlankText(MAX_ITEM_CHARS),
});

export const POLISH_REFERENCE_ROLES = ["scope_metadata", "sibling", "profile", "skill"] as const;
export type PolishReferenceRole = (typeof POLISH_REFERENCE_ROLES)[number];

export const polishReferenceSchema = z.strictObject({
  role: z.enum(POLISH_REFERENCE_ROLES),
  label: z.string().max(MAX_REFERENCE_LABEL_CHARS).optional(),
  text: nonBlankText(MAX_REFERENCE_ITEM_CHARS),
});

export const POLISH_CONTEXT_LEVELS = [0, 1, 2] as const;

export const polishContextSchema = z.strictObject({
  level: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  references: z.array(polishReferenceSchema).max(MAX_REFERENCES),
});

export const POLISH_STYLE_PRESETS = [
  "professional",
  "concise",
  "quantified",
  "management",
] as const;
export type PolishStylePreset = (typeof POLISH_STYLE_PRESETS)[number];

export const polishRequestSchema = z
  .strictObject({
    /** Dedup key generated per "confirm polish"; never sent to the provider. */
    clientRequestId: z.uuid(),
    granularity: z.enum(POLISH_GRANULARITIES),
    sectionId: z.enum(ORDERED_SECTION_IDS),
    language: z.enum(["zh", "en"]),
    items: z.array(polishItemSchema).min(1).max(MAX_ITEMS),
    context: polishContextSchema,
    stylePreset: z.enum(POLISH_STYLE_PRESETS).optional(),
    styleInstruction: z.string().max(MAX_STYLE_INSTRUCTION_CHARS).optional(),
  })
  .superRefine((request, ctx) => {
    const capability = getSectionCapability(request.sectionId);
    if (!capability) {
      // publications (and any future non-polishable section) is always rejected.
      ctx.addIssue({
        code: "custom",
        path: ["sectionId"],
        message: `section "${request.sectionId}" is not polishable`,
      });
      return;
    }

    if (!capability.granularities.includes(request.granularity)) {
      ctx.addIssue({
        code: "custom",
        path: ["granularity"],
        message: `granularity "${request.granularity}" is not supported for section "${request.sectionId}"`,
      });
    }

    // "item" granularity targets exactly one item; entry/group/section stay
    // variable-length because the wire format deliberately does not encode
    // project/entry grouping.
    if (request.granularity === "item" && request.items.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "item granularity requires exactly one target item",
      });
    }

    const seenIds = new Set<string>();
    for (const [index, item] of request.items.entries()) {
      if (item.kind !== capability.kind) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "kind"],
          message: `kind "${item.kind}" does not match section "${request.sectionId}" ("${capability.kind}" expected)`,
        });
      }
      if (seenIds.has(item.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "id"],
          message: `duplicate item id "${item.id}"`,
        });
      }
      seenIds.add(item.id);
    }

    if (request.context.level === 0 && request.context.references.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["context", "references"],
        message: "references must be empty at context level 0",
      });
    }

    const totalTargetChars = request.items.reduce((sum, item) => sum + item.text.length, 0);
    if (totalTargetChars > MAX_TARGET_CHARS) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: `total target characters ${totalTargetChars} exceeds MAX_TARGET_CHARS (${MAX_TARGET_CHARS})`,
      });
    }

    // Labels count toward the aggregate: they are prompt content too.
    const totalReferenceChars = request.context.references.reduce(
      (sum, reference) => sum + reference.text.length + (reference.label?.length ?? 0),
      0,
    );
    if (totalReferenceChars > MAX_REFERENCE_CHARS) {
      ctx.addIssue({
        code: "custom",
        path: ["context", "references"],
        message: `total reference characters ${totalReferenceChars} exceeds MAX_REFERENCE_CHARS (${MAX_REFERENCE_CHARS})`,
      });
    }
  });

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

export const polishQuotaSchema = z
  .strictObject({
    limit: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    /** DB time, ISO UTC. */
    resetAt: z.iso.datetime(),
  })
  .superRefine((quota, ctx) => {
    if (quota.remaining > quota.limit) {
      ctx.addIssue({
        code: "custom",
        path: ["remaining"],
        message: `remaining (${quota.remaining}) exceeds limit (${quota.limit})`,
      });
    }
  });

const polishResultItemSchema = z.strictObject({
  id: itemIdSchema,
  polished: z.string().min(1).max(MAX_POLISHED_ITEM_CHARS),
});

export const polishSuccessResponseSchema = z
  .strictObject({
    /** Server-generated; also echoed in the X-Request-Id header. */
    requestId: z.string().min(1),
    items: z.array(polishResultItemSchema).min(1).max(MAX_ITEMS),
    quota: polishQuotaSchema,
  })
  .superRefine((response, ctx) => {
    const seenIds = new Set<string>();
    let totalPolishedChars = 0;
    for (const [index, item] of response.items.entries()) {
      if (seenIds.has(item.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "id"],
          message: `duplicate result id "${item.id}"`,
        });
      }
      seenIds.add(item.id);
      // Whitespace-only output is rejected, but the stored value is NOT
      // trimmed — validation only, no transformation.
      if (item.polished.trim().length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "polished"],
          message: "polished text must not be blank",
        });
      }
      totalPolishedChars += item.polished.length;
    }
    // Aggregate output cap — the authoritative output budget. Exact equality
    // against the request's id set stays with the request-aware validator
    // (unit 2.2); the standalone wire schema cannot know the request.
    if (totalPolishedChars > MAX_TOTAL_POLISHED_CHARS) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: `total polished characters ${totalPolishedChars} exceeds MAX_TOTAL_POLISHED_CHARS (${MAX_TOTAL_POLISHED_CHARS})`,
      });
    }
  });

/**
 * Frozen success envelope of GET /api/polish/quota:
 * `{ requestId, quota: { limit, remaining, resetAt } }` — the requestId
 * mirrors X-Request-Id like every other polish response; the quota payload
 * itself is identical to the one embedded in the POST success response.
 * Errors reuse polishErrorResponseSchema.
 */
export const polishQuotaResponseSchema = z.strictObject({
  /** Server-generated; also echoed in the X-Request-Id header. */
  requestId: z.string().min(1),
  quota: polishQuotaSchema,
});

export const POLISH_ERROR_CODES = [
  "INVALID_REQUEST",
  "UNAUTHORIZED",
  "AI_TERMS_REQUIRED",
  "REQUEST_IN_PROGRESS",
  "DUPLICATE_REQUEST",
  "PAYLOAD_TOO_LARGE",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
  "UPSTREAM_ERROR",
  "INVALID_MODEL_OUTPUT",
  "AI_DISABLED",
  "SERVICE_UNAVAILABLE",
  "UPSTREAM_TIMEOUT",
] as const;
export type PolishErrorCode = (typeof POLISH_ERROR_CODES)[number];

/** Error code ↔ HTTP status mapping (roadmap error table). */
export const POLISH_ERROR_HTTP_STATUS = {
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  AI_TERMS_REQUIRED: 403,
  REQUEST_IN_PROGRESS: 409,
  DUPLICATE_REQUEST: 409,
  PAYLOAD_TOO_LARGE: 413,
  QUOTA_EXCEEDED: 429,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  UPSTREAM_ERROR: 502,
  INVALID_MODEL_OUTPUT: 502,
  AI_DISABLED: 503,
  SERVICE_UNAVAILABLE: 503,
  UPSTREAM_TIMEOUT: 504,
} as const satisfies Record<PolishErrorCode, number>;

export const polishErrorResponseSchema = z.strictObject({
  requestId: z.string().min(1),
  error: z.strictObject({
    code: z.enum(POLISH_ERROR_CODES),
    message: z.string(),
    resetAt: z.iso.datetime().optional(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
  }),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type PolishItem = z.infer<typeof polishItemSchema>;
export type PolishReference = z.infer<typeof polishReferenceSchema>;
export type PolishContextLevel = z.infer<typeof polishContextSchema>["level"];
export type PolishLanguage = z.infer<typeof polishRequestSchema>["language"];
export type PolishRequest = z.infer<typeof polishRequestSchema>;
export type PolishQuota = z.infer<typeof polishQuotaSchema>;
export type PolishSuccessResponse = z.infer<typeof polishSuccessResponseSchema>;
export type PolishQuotaResponse = z.infer<typeof polishQuotaResponseSchema>;
export type PolishErrorResponse = z.infer<typeof polishErrorResponseSchema>;
