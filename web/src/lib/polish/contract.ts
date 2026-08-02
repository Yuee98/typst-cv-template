/**
 * Shared API contract for POST /api/polish.
 *
 * Source of truth: tmp/ai-polish-roadmap.md —「架构决策：API 契约」and
 * 「架构决策：润色粒度与能力矩阵」. Imported by BOTH the client (scope
 * builder / dialog) and the server (route handler); keep it free of
 * Node/DOM-specific APIs. Frozen after checkpoint CP1.
 */

import { z } from "zod";
import { ORDERED_SECTION_IDS, type CvSectionId } from "@/lib/cv/schema";

// ---------------------------------------------------------------------------
// Polishable sections, field kinds, and the capability matrix
// ---------------------------------------------------------------------------

export const POLISH_GRANULARITIES = ["item", "entry", "section"] as const;
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
 * - experience / education / research: all three levels
 * - publications: absent on purpose — bibliographic facts, never polishable
 */
export const POLISH_CAPABILITY_MATRIX = {
  profile: { kind: "profile", granularities: ["item", "entry"] },
  skills: { kind: "skill_body", granularities: ["item", "section"] },
  experience: { kind: "experience_bullet", granularities: ["item", "entry", "section"] },
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
export const MAX_STYLE_INSTRUCTION_CHARS = 200;
export const ITEM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

/**
 * The three budget constants are mutually consistent (roadmap「总输出预算」):
 * sum(items.text) ≤ MAX_TARGET_CHARS → polished output is capped by
 * MAX_TOTAL_POLISHED_CHARS ≈ MAX_TARGET_CHARS × 1.5 (the per-item hard cap is
 * ceil(original × 1.5) + 40) → POLISH_MAX_OUTPUT_TOKENS covers
 * MAX_TOTAL_POLISHED_CHARS plus JSON structure overhead even at the Chinese
 * worst case of ≈1 token per character. max_tokens per request is computed
 * dynamically as min(POLISH_MAX_OUTPUT_TOKENS, totalTargetChars × 1.5 + JSON
 * overhead) so oversized requests can neither truncate nor blow up cost.
 */
export const MAX_TARGET_CHARS = 5000;
export const MAX_REFERENCE_CHARS = 10000;
export const MAX_TOTAL_POLISHED_CHARS = 7500;
export const POLISH_MAX_OUTPUT_TOKENS = 8192;

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const itemIdSchema = z.string().regex(ITEM_ID_PATTERN);

export const polishItemSchema = z.object({
  id: itemIdSchema,
  kind: z.enum(POLISHABLE_FIELD_KINDS),
  text: z.string().min(1).max(MAX_ITEM_CHARS),
});

export const POLISH_REFERENCE_ROLES = ["scope_metadata", "sibling", "profile", "skill"] as const;
export type PolishReferenceRole = (typeof POLISH_REFERENCE_ROLES)[number];

export const polishReferenceSchema = z.object({
  role: z.enum(POLISH_REFERENCE_ROLES),
  label: z.string().optional(),
  text: z.string().min(1).max(MAX_REFERENCE_ITEM_CHARS),
});

export const POLISH_CONTEXT_LEVELS = [0, 1, 2] as const;

export const polishContextSchema = z.object({
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
  .object({
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

    const totalReferenceChars = request.context.references.reduce(
      (sum, reference) => sum + reference.text.length,
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

export const polishQuotaSchema = z.object({
  limit: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  /** DB time, ISO UTC. */
  resetAt: z.iso.datetime(),
});

export const polishSuccessResponseSchema = z.object({
  /** Server-generated; also echoed in the X-Request-Id header. */
  requestId: z.string().min(1),
  items: z.array(z.object({ id: itemIdSchema, polished: z.string().min(1) })),
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

export const polishErrorResponseSchema = z.object({
  requestId: z.string().min(1),
  error: z.object({
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
export type PolishErrorResponse = z.infer<typeof polishErrorResponseSchema>;
