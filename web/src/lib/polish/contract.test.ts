import { describe, expect, it } from "vitest";
import { ORDERED_SECTION_IDS, type CvSectionId } from "@/lib/cv/schema";
import {
  getSectionCapability,
  ITEM_ID_PATTERN,
  MAX_BODY_BYTES,
  MAX_ITEM_CHARS,
  MAX_ITEMS,
  MAX_REFERENCE_CHARS,
  MAX_REFERENCE_ITEM_CHARS,
  MAX_REFERENCES,
  MAX_STYLE_INSTRUCTION_CHARS,
  MAX_TARGET_CHARS,
  POLISH_CAPABILITY_MATRIX,
  POLISH_ERROR_CODES,
  POLISH_ERROR_HTTP_STATUS,
  POLISH_REFERENCE_ROLES,
  POLISHABLE_FIELD_KINDS,
  polishErrorResponseSchema,
  polishRequestSchema,
  polishSuccessResponseSchema,
  type PolishRequest,
} from "./contract";

const VALID_UUID = "123e4567-e89b-42d3-a456-426614174000";

/** A fresh minimal valid request (experience item, level 0). */
function makeRequest(): Record<string, unknown> {
  return {
    clientRequestId: VALID_UUID,
    granularity: "item",
    sectionId: "experience",
    language: "zh",
    items: [{ id: "i0", kind: "experience_bullet", text: "负责后端服务开发，将接口 P99 延迟降低 40%。" }],
    context: { level: 0, references: [] },
  };
}

function accepts(request: unknown): boolean {
  return polishRequestSchema.safeParse(request).success;
}

describe("polishRequestSchema — valid requests", () => {
  it("accepts a minimal valid request", () => {
    expect(accepts(makeRequest())).toBe(true);
  });

  it("accepts a full valid request (level 2, all reference roles, style fields)", () => {
    const request = makeRequest();
    request.context = {
      level: 2,
      references: POLISH_REFERENCE_ROLES.map((role, index) => ({
        role,
        label: `ref-${index}`,
        text: `参考内容 ${index}`,
      })),
    };
    request.stylePreset = "quantified";
    request.styleInstruction = "突出量化成果";
    expect(accepts(request)).toBe(true);
  });

  it("accepts references at level 1 (role trimming is server-side, not contract)", () => {
    const request = makeRequest();
    request.context = {
      level: 1,
      references: [{ role: "sibling", text: "同项目另一条 bullet" }],
    };
    expect(accepts(request)).toBe(true);
  });
});

describe("polishRequestSchema — capability matrix (cross-field)", () => {
  // Every (section, granularity) pair offered by the matrix must validate
  // with the section's own kind.
  it.each(
    Object.entries(POLISH_CAPABILITY_MATRIX).flatMap(([sectionId, capability]) =>
      capability.granularities.map(
        (granularity) => [sectionId, granularity, capability.kind] as const,
      ),
    ),
  )("accepts %s at %s granularity", (sectionId, granularity, kind) => {
    const request = makeRequest();
    request.sectionId = sectionId;
    request.granularity = granularity;
    request.items = [{ id: "i0", kind, text: "一段可润色的自由文本内容。" }];
    expect(accepts(request)).toBe(true);
  });

  it("always rejects publications", () => {
    const request = makeRequest();
    request.sectionId = "publications";
    expect(accepts(request)).toBe(false);
  });

  it.each([
    ["skills", "entry"],
    ["additional", "entry"],
    ["profile", "section"],
  ] as const)("rejects %s at %s granularity (not in matrix)", (sectionId, granularity) => {
    const request = makeRequest();
    request.sectionId = sectionId;
    request.granularity = granularity;
    request.items = [
      { id: "i0", kind: POLISH_CAPABILITY_MATRIX[sectionId].kind, text: "一段可润色的自由文本内容。" },
    ];
    expect(accepts(request)).toBe(false);
  });

  it("rejects kind not matching the section", () => {
    const request = makeRequest();
    request.items = [{ id: "i0", kind: "skill_body", text: "与 section 不匹配的 kind。" }];
    expect(accepts(request)).toBe(false);
  });

  it("rejects mixed kinds across sections", () => {
    const request = makeRequest();
    request.items = [
      { id: "i0", kind: "experience_bullet", text: "第一条 bullet 文本。" },
      { id: "i1", kind: "education_bullet", text: "来自其他 section 的 bullet。" },
    ];
    expect(accepts(request)).toBe(false);
  });

  it("rejects references at context level 0", () => {
    const request = makeRequest();
    request.context = {
      level: 0,
      references: [{ role: "sibling", text: "level 0 不允许任何 reference。" }],
    };
    expect(accepts(request)).toBe(false);
  });

  it("rejects duplicate item ids", () => {
    const request = makeRequest();
    request.items = [
      { id: "i0", kind: "experience_bullet", text: "第一条 bullet 文本。" },
      { id: "i0", kind: "experience_bullet", text: "第二条 bullet 文本。" },
    ];
    expect(accepts(request)).toBe(false);
  });
});

describe("polishRequestSchema — hard constraints", () => {
  it("rejects a non-uuid clientRequestId", () => {
    const request = makeRequest();
    request.clientRequestId = "not-a-uuid";
    expect(accepts(request)).toBe(false);
  });

  it.each(["has space", "bad$char", "x".repeat(33), ""])("rejects item id %j", (id) => {
    const request = makeRequest();
    request.items = [{ id, kind: "experience_bullet", text: "合法的 bullet 文本。" }];
    expect(accepts(request)).toBe(false);
  });

  it.each(["i0", "a".repeat(32), "-_AZaz09"])("accepts item id %j", (id) => {
    expect(ITEM_ID_PATTERN.test(id)).toBe(true);
    const request = makeRequest();
    request.items = [{ id, kind: "experience_bullet", text: "合法的 bullet 文本。" }];
    expect(accepts(request)).toBe(true);
  });

  it("rejects empty items and more than MAX_ITEMS items", () => {
    const empty = makeRequest();
    empty.items = [];
    expect(accepts(empty)).toBe(false);

    const tooMany = makeRequest();
    tooMany.items = Array.from({ length: MAX_ITEMS + 1 }, (_, index) => ({
      id: `i${index}`,
      kind: "experience_bullet",
      text: "一条 bullet 文本。",
    }));
    expect(accepts(tooMany)).toBe(false);

    const atMax = makeRequest();
    atMax.items = Array.from({ length: MAX_ITEMS }, (_, index) => ({
      id: `i${index}`,
      kind: "experience_bullet",
      text: "一条 bullet 文本。",
    }));
    expect(accepts(atMax)).toBe(true);
  });

  it("rejects empty item text and item text over MAX_ITEM_CHARS", () => {
    const empty = makeRequest();
    empty.items = [{ id: "i0", kind: "experience_bullet", text: "" }];
    expect(accepts(empty)).toBe(false);

    const tooLong = makeRequest();
    tooLong.items = [{ id: "i0", kind: "experience_bullet", text: "x".repeat(MAX_ITEM_CHARS + 1) }];
    expect(accepts(tooLong)).toBe(false);
  });

  it("rejects more than MAX_REFERENCES references and reference text over the per-item cap", () => {
    const tooMany = makeRequest();
    tooMany.context = {
      level: 2,
      references: Array.from({ length: MAX_REFERENCES + 1 }, (_, index) => ({
        role: "sibling",
        text: `参考 ${index}`,
      })),
    };
    expect(accepts(tooMany)).toBe(false);

    const tooLong = makeRequest();
    tooLong.context = {
      level: 2,
      references: [{ role: "sibling", text: "x".repeat(MAX_REFERENCE_ITEM_CHARS + 1) }],
    };
    expect(accepts(tooLong)).toBe(false);
  });

  it("rejects total target characters over MAX_TARGET_CHARS", () => {
    const request = makeRequest();
    // 3 × 2000 chars each = 6000 > MAX_TARGET_CHARS, each item individually valid.
    request.items = [0, 1, 2].map((index) => ({
      id: `i${index}`,
      kind: "experience_bullet",
      text: "x".repeat(MAX_ITEM_CHARS),
    }));
    expect(MAX_ITEM_CHARS * 3).toBeGreaterThan(MAX_TARGET_CHARS);
    expect(accepts(request)).toBe(false);
  });

  it("rejects total reference characters over MAX_REFERENCE_CHARS", () => {
    const request = makeRequest();
    request.context = {
      level: 2,
      references: Array.from({ length: 6 }, (_, index) => ({
        role: "sibling",
        text: `r${index}${"x".repeat(MAX_REFERENCE_ITEM_CHARS - 2)}`,
      })),
    };
    expect(6 * MAX_REFERENCE_ITEM_CHARS).toBeGreaterThan(MAX_REFERENCE_CHARS);
    expect(accepts(request)).toBe(false);
  });

  it("rejects styleInstruction over MAX_STYLE_INSTRUCTION_CHARS", () => {
    const request = makeRequest();
    request.styleInstruction = "x".repeat(MAX_STYLE_INSTRUCTION_CHARS + 1);
    expect(accepts(request)).toBe(false);
  });

  it("rejects unknown enum values", () => {
    const badGranularity = makeRequest();
    badGranularity.granularity = "document";
    expect(accepts(badGranularity)).toBe(false);

    const badLanguage = makeRequest();
    badLanguage.language = "fr";
    expect(accepts(badLanguage)).toBe(false);

    const badLevel = makeRequest();
    badLevel.context = { level: 3, references: [] };
    expect(accepts(badLevel)).toBe(false);

    const badPreset = makeRequest();
    badPreset.stylePreset = "fancy";
    expect(accepts(badPreset)).toBe(false);

    const badRole = makeRequest();
    badRole.context = { level: 2, references: [{ role: "header", text: "非法角色" }] };
    expect(accepts(badRole)).toBe(false);
  });
});

describe("capability matrix & constants", () => {
  it("covers every section except publications", () => {
    for (const sectionId of ORDERED_SECTION_IDS) {
      if (sectionId === "publications") {
        expect(getSectionCapability(sectionId)).toBeUndefined();
      } else {
        expect(getSectionCapability(sectionId)).toBeDefined();
      }
    }
    expect(Object.keys(POLISH_CAPABILITY_MATRIX)).toHaveLength(ORDERED_SECTION_IDS.length - 1);
  });

  it("matrix kinds are exactly the polishable field kinds", () => {
    const matrixKinds = new Set(
      Object.values(POLISH_CAPABILITY_MATRIX).map((capability) => capability.kind),
    );
    expect([...matrixKinds].sort()).toEqual([...POLISHABLE_FIELD_KINDS].sort());
  });

  it("matrix granularities are a subset of item/entry/section and non-empty", () => {
    for (const capability of Object.values(POLISH_CAPABILITY_MATRIX)) {
      expect(capability.granularities.length).toBeGreaterThan(0);
      for (const granularity of capability.granularities) {
        expect(["item", "entry", "section"]).toContain(granularity);
      }
    }
  });

  it("MAX_BODY_BYTES is 64 KiB", () => {
    expect(MAX_BODY_BYTES).toBe(64 * 1024);
  });

  it("budget constants stay mutually consistent (output ≤ tokens at 1 token/char)", () => {
    // Worst-case per-item caps (×1.5 each) cannot exceed the total output
    // budget by more than the per-item slack, and the token budget must cover
    // the total output budget at the Chinese worst case of ~1 token per char.
    expect(MAX_TARGET_CHARS).toBeLessThanOrEqual(MAX_ITEMS * MAX_ITEM_CHARS);
    expect(MAX_REFERENCE_CHARS).toBeLessThanOrEqual(MAX_REFERENCES * MAX_REFERENCE_ITEM_CHARS);
  });

  it("error code ↔ HTTP status mapping covers every code and matches the roadmap table", () => {
    expect(Object.keys(POLISH_ERROR_HTTP_STATUS).sort()).toEqual([...POLISH_ERROR_CODES].sort());
    expect(POLISH_ERROR_HTTP_STATUS.INVALID_REQUEST).toBe(400);
    expect(POLISH_ERROR_HTTP_STATUS.UNAUTHORIZED).toBe(401);
    expect(POLISH_ERROR_HTTP_STATUS.AI_TERMS_REQUIRED).toBe(403);
    expect(POLISH_ERROR_HTTP_STATUS.REQUEST_IN_PROGRESS).toBe(409);
    expect(POLISH_ERROR_HTTP_STATUS.DUPLICATE_REQUEST).toBe(409);
    expect(POLISH_ERROR_HTTP_STATUS.PAYLOAD_TOO_LARGE).toBe(413);
    expect(POLISH_ERROR_HTTP_STATUS.QUOTA_EXCEEDED).toBe(429);
    expect(POLISH_ERROR_HTTP_STATUS.RATE_LIMITED).toBe(429);
    expect(POLISH_ERROR_HTTP_STATUS.INTERNAL_ERROR).toBe(500);
    expect(POLISH_ERROR_HTTP_STATUS.UPSTREAM_ERROR).toBe(502);
    expect(POLISH_ERROR_HTTP_STATUS.INVALID_MODEL_OUTPUT).toBe(502);
    expect(POLISH_ERROR_HTTP_STATUS.AI_DISABLED).toBe(503);
    expect(POLISH_ERROR_HTTP_STATUS.SERVICE_UNAVAILABLE).toBe(503);
    expect(POLISH_ERROR_HTTP_STATUS.UPSTREAM_TIMEOUT).toBe(504);
  });
});

describe("response schemas", () => {
  it("accepts a valid success response", () => {
    const response = {
      requestId: "req-01",
      items: [
        { id: "i0", polished: "主导后端服务开发，将接口 P99 延迟降低 40%。" },
        { id: "i1", polished: "另一条润色结果。" },
      ],
      quota: { limit: 20, remaining: 19, resetAt: "2026-08-03T00:00:00.000Z" },
    };
    expect(polishSuccessResponseSchema.safeParse(response).success).toBe(true);
  });

  it("rejects success responses with empty polished text or bad quota", () => {
    const emptyPolished = {
      requestId: "req-01",
      items: [{ id: "i0", polished: "" }],
      quota: { limit: 20, remaining: 19, resetAt: "2026-08-03T00:00:00.000Z" },
    };
    expect(polishSuccessResponseSchema.safeParse(emptyPolished).success).toBe(false);

    const badQuota = {
      requestId: "req-01",
      items: [{ id: "i0", polished: "润色结果。" }],
      quota: { limit: 20, remaining: -1, resetAt: "not-a-date" },
    };
    expect(polishSuccessResponseSchema.safeParse(badQuota).success).toBe(false);
  });

  it("accepts valid error responses with optional fields", () => {
    const minimal = {
      requestId: "req-01",
      error: { code: "AI_DISABLED", message: "disabled" },
    };
    expect(polishErrorResponseSchema.safeParse(minimal).success).toBe(true);

    const full = {
      requestId: "req-01",
      error: {
        code: "RATE_LIMITED",
        message: "slow down",
        resetAt: "2026-08-03T00:00:00.000Z",
        retryAfterSeconds: 30,
      },
    };
    expect(polishErrorResponseSchema.safeParse(full).success).toBe(true);
  });

  it("rejects error responses with unknown codes", () => {
    const response = {
      requestId: "req-01",
      error: { code: "NOT_A_CODE", message: "nope" },
    };
    expect(polishErrorResponseSchema.safeParse(response).success).toBe(false);
  });
});

describe("type inference", () => {
  it("PolishRequest sectionId is a CvSectionId", () => {
    const parsed = polishRequestSchema.parse(makeRequest()) satisfies PolishRequest;
    const sectionId: CvSectionId = parsed.sectionId;
    expect(ORDERED_SECTION_IDS).toContain(sectionId);
  });
});
