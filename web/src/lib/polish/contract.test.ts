import { describe, expect, it } from "vitest";
import { ORDERED_SECTION_IDS, type CvSectionId } from "@/lib/cv/schema";
import {
  getSectionCapability,
  ITEM_ID_PATTERN,
  MAX_BODY_BYTES,
  MAX_ITEM_CHARS,
  MAX_ITEMS,
  MAX_POLISHED_ITEM_CHARS,
  MAX_REFERENCE_CHARS,
  MAX_REFERENCE_ITEM_CHARS,
  MAX_REFERENCE_LABEL_CHARS,
  MAX_REFERENCES,
  MAX_STYLE_INSTRUCTION_CHARS,
  MAX_TARGET_CHARS,
  MAX_TOTAL_POLISHED_CHARS,
  PER_ITEM_POLISHED_SLACK_CHARS,
  POLISH_CAPABILITY_MATRIX,
  POLISH_ERROR_CODES,
  POLISH_ERROR_HTTP_STATUS,
  POLISH_MAX_OUTPUT_TOKENS,
  POLISH_REFERENCE_ROLES,
  POLISH_RESPONSE_ENVELOPE_CHARS,
  POLISHABLE_FIELD_KINDS,
  polishErrorResponseSchema,
  polishQuotaResponseSchema,
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

describe("polishRequestSchema — strict wire objects", () => {
  // z.object would silently strip unknown keys, letting local-only fields
  // (RHF paths, header PII) "validate" across the network boundary. Every
  // wire object is a strictObject and must reject them instead.
  it("rejects a top-level header (PII stays local)", () => {
    const request = makeRequest();
    request.header = { name: "User Name", email: "user@example.com" };
    expect(accepts(request)).toBe(false);
  });

  it("rejects items[].path (RHF paths stay local)", () => {
    const request = makeRequest();
    request.items = [
      {
        id: "i0",
        kind: "experience_bullet",
        text: "Original text",
        path: "experience.0.projects.0.bullets.0.body",
      },
    ];
    expect(accepts(request)).toBe(false);
  });

  it("rejects an unknown context property", () => {
    const request = makeRequest();
    request.context = { level: 0, references: [], company: "ACME" };
    expect(accepts(request)).toBe(false);
  });

  it("rejects an unknown reference property", () => {
    const request = makeRequest();
    request.context = {
      level: 2,
      references: [{ role: "sibling", text: "参考", sourceId: "exp-1" }],
    };
    expect(accepts(request)).toBe(false);
  });

  it("rejects any other unknown top-level property", () => {
    const request = makeRequest();
    request.debug = true;
    expect(accepts(request)).toBe(false);
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
    request.granularity = "section";
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
    request.granularity = "section";
    request.items = [
      { id: "i0", kind: "experience_bullet", text: "第一条 bullet 文本。" },
      { id: "i0", kind: "experience_bullet", text: "第二条 bullet 文本。" },
    ];
    expect(accepts(request)).toBe(false);
  });
});

describe("polishRequestSchema — item granularity cardinality", () => {
  it("rejects item granularity with more than one item", () => {
    const request = makeRequest();
    request.items = [
      { id: "i0", kind: "experience_bullet", text: "第一条 bullet 文本。" },
      { id: "i1", kind: "experience_bullet", text: "第二条 bullet 文本。" },
    ];
    expect(accepts(request)).toBe(false);
  });

  it.each(["entry", "section"] as const)(
    "keeps %s granularity variable-length",
    (granularity) => {
      const request = makeRequest();
      request.granularity = granularity;
      request.items = [
        { id: "i0", kind: "experience_bullet", text: "第一条 bullet 文本。" },
        { id: "i1", kind: "experience_bullet", text: "第二条 bullet 文本。" },
      ];
      expect(accepts(request)).toBe(true);
    },
  );
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
    tooMany.granularity = "section";
    tooMany.items = Array.from({ length: MAX_ITEMS + 1 }, (_, index) => ({
      id: `i${index}`,
      kind: "experience_bullet",
      text: "一条 bullet 文本。",
    }));
    expect(accepts(tooMany)).toBe(false);

    const atMax = makeRequest();
    atMax.granularity = "section";
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

  it("rejects a reference label over MAX_REFERENCE_LABEL_CHARS", () => {
    const request = makeRequest();
    request.context = {
      level: 2,
      references: [{ role: "sibling", label: "x".repeat(MAX_REFERENCE_LABEL_CHARS + 1), text: "参考" }],
    };
    expect(accepts(request)).toBe(false);

    const atMax = makeRequest();
    atMax.context = {
      level: 2,
      references: [{ role: "sibling", label: "x".repeat(MAX_REFERENCE_LABEL_CHARS), text: "参考" }],
    };
    expect(accepts(atMax)).toBe(true);
  });

  it("counts reference labels toward the aggregate MAX_REFERENCE_CHARS budget", () => {
    // 50 × (1 char text + 200 char label) = 10050 > MAX_REFERENCE_CHARS,
    // even though every text is trivially short.
    const overViaLabels = makeRequest();
    overViaLabels.context = {
      level: 2,
      references: Array.from({ length: 50 }, (_, index) => ({
        role: "sibling",
        label: "x".repeat(MAX_REFERENCE_LABEL_CHARS),
        text: `${index}`,
      })),
    };
    expect(50 * (1 + MAX_REFERENCE_LABEL_CHARS)).toBeGreaterThan(MAX_REFERENCE_CHARS);
    expect(accepts(overViaLabels)).toBe(false);

    // The same shape without labels stays well under the budget.
    const sameWithoutLabels = makeRequest();
    sameWithoutLabels.context = {
      level: 2,
      references: Array.from({ length: 50 }, (_, index) => ({
        role: "sibling",
        text: `${index}`,
      })),
    };
    expect(accepts(sameWithoutLabels)).toBe(true);
  });

  it("rejects total target characters over MAX_TARGET_CHARS", () => {
    const request = makeRequest();
    request.granularity = "section";
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

  it("budget constants stay mutually consistent (worst-case valid output fits the token budget)", () => {
    // Input aggregate caps are reachable: they sit below count × per-item caps.
    expect(MAX_TARGET_CHARS).toBeLessThanOrEqual(MAX_ITEMS * MAX_ITEM_CHARS);
    expect(MAX_REFERENCE_CHARS).toBeLessThanOrEqual(
      MAX_REFERENCES * (MAX_REFERENCE_ITEM_CHARS + MAX_REFERENCE_LABEL_CHARS),
    );

    // The aggregate output cap mirrors the ×1.5 polish factor on the input
    // budget and is the AUTHORITATIVE output limit.
    expect(MAX_TOTAL_POLISHED_CHARS).toBe(Math.ceil(MAX_TARGET_CHARS * 1.5));

    // The sum of per-item caps may exceed the aggregate (per-item slack);
    // that is fine because the aggregate is authoritative — but the per-item
    // caps must not starve the aggregate either.
    const worstCasePerItemSum =
      Math.ceil(MAX_TARGET_CHARS * 1.5) + MAX_ITEMS * PER_ITEM_POLISHED_SLACK_CHARS;
    expect(worstCasePerItemSum).toBeGreaterThan(MAX_TOTAL_POLISHED_CHARS);
    const perItemCapAtMaxOriginal = Math.min(
      MAX_POLISHED_ITEM_CHARS,
      Math.ceil(MAX_ITEM_CHARS * 1.5) + PER_ITEM_POLISHED_SLACK_CHARS,
    );
    expect(MAX_ITEMS * perItemCapAtMaxOriginal).toBeGreaterThanOrEqual(MAX_TOTAL_POLISHED_CHARS);
    expect(MAX_POLISHED_ITEM_CHARS).toBeLessThanOrEqual(MAX_TOTAL_POLISHED_CHARS);

    // The envelope constant really covers a maximal serialization of the
    // model's raw response ({"items":[{"id":"…","polished":"…"},…]}).
    const maximalEnvelopeJson = JSON.stringify({
      items: Array.from({ length: MAX_ITEMS }, () => ({ id: "i".padEnd(32, "x"), polished: "" })),
    });
    expect(POLISH_RESPONSE_ENVELOPE_CHARS).toBeGreaterThanOrEqual(maximalEnvelopeJson.length);

    // A worst-case VALID raw response must fit the token budget at ~1 token
    // per character (Chinese worst case).
    expect(MAX_TOTAL_POLISHED_CHARS + POLISH_RESPONSE_ENVELOPE_CHARS).toBeLessThanOrEqual(
      POLISH_MAX_OUTPUT_TOKENS,
    );
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
  const QUOTA = { limit: 20, remaining: 19, resetAt: "2026-08-03T00:00:00.000Z" };

  function makeSuccessResponse(): Record<string, unknown> {
    return {
      requestId: "req-01",
      items: [
        { id: "i0", polished: "主导后端服务开发，将接口 P99 延迟降低 40%。" },
        { id: "i1", polished: "另一条润色结果。" },
      ],
      quota: { ...QUOTA },
    };
  }

  it("accepts a valid success response", () => {
    expect(polishSuccessResponseSchema.safeParse(makeSuccessResponse()).success).toBe(true);
  });

  it("rejects success responses with unknown fields at any nesting level", () => {
    const topLevel = { ...makeSuccessResponse(), usage: { promptTokens: 1 } };
    expect(polishSuccessResponseSchema.safeParse(topLevel).success).toBe(false);

    const inResultItem = makeSuccessResponse();
    inResultItem.items = [{ id: "i0", polished: "润色结果。", finishReason: "stop" }];
    expect(polishSuccessResponseSchema.safeParse(inResultItem).success).toBe(false);

    const inQuota = makeSuccessResponse();
    inQuota.quota = { ...QUOTA, used: 1 };
    expect(polishSuccessResponseSchema.safeParse(inQuota).success).toBe(false);
  });

  it("rejects an empty result list and more than MAX_ITEMS results", () => {
    const empty = makeSuccessResponse();
    empty.items = [];
    expect(polishSuccessResponseSchema.safeParse(empty).success).toBe(false);

    const tooMany = makeSuccessResponse();
    tooMany.items = Array.from({ length: MAX_ITEMS + 1 }, (_, index) => ({
      id: `i${index}`,
      polished: "润色结果。",
    }));
    expect(polishSuccessResponseSchema.safeParse(tooMany).success).toBe(false);

    const atMax = makeSuccessResponse();
    atMax.items = Array.from({ length: MAX_ITEMS }, (_, index) => ({
      id: `i${index}`,
      polished: "润色结果。",
    }));
    expect(polishSuccessResponseSchema.safeParse(atMax).success).toBe(true);
  });

  it("rejects duplicate result ids", () => {
    const response = makeSuccessResponse();
    response.items = [
      { id: "i0", polished: "结果 A。" },
      { id: "i0", polished: "结果 B。" },
    ];
    expect(polishSuccessResponseSchema.safeParse(response).success).toBe(false);
  });

  it("rejects empty and whitespace-only polished text without trimming the stored value", () => {
    const empty = makeSuccessResponse();
    empty.items = [{ id: "i0", polished: "" }];
    expect(polishSuccessResponseSchema.safeParse(empty).success).toBe(false);

    const blank = makeSuccessResponse();
    blank.items = [{ id: "i0", polished: "  \n\t  " }];
    expect(polishSuccessResponseSchema.safeParse(blank).success).toBe(false);

    // Leading/trailing whitespace around real content is kept as-is.
    const padded = makeSuccessResponse();
    padded.items = [{ id: "i0", polished: "  润色结果。  " }];
    const parsed = polishSuccessResponseSchema.safeParse(padded);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.items[0].polished).toBe("  润色结果。  ");
    }
  });

  it("rejects a single result over MAX_POLISHED_ITEM_CHARS", () => {
    const response = makeSuccessResponse();
    response.items = [{ id: "i0", polished: "x".repeat(MAX_POLISHED_ITEM_CHARS + 1) }];
    expect(polishSuccessResponseSchema.safeParse(response).success).toBe(false);
  });

  it("enforces the aggregate MAX_TOTAL_POLISHED_CHARS cap", () => {
    // Each result is individually under the per-item cap, but the sum
    // exceeds the aggregate budget.
    const response = makeSuccessResponse();
    response.items = [0, 1, 2, 3].map((index) => ({
      id: `i${index}`,
      polished: "x".repeat(MAX_POLISHED_ITEM_CHARS),
    }));
    expect(4 * MAX_POLISHED_ITEM_CHARS).toBeGreaterThan(MAX_TOTAL_POLISHED_CHARS);
    expect(polishSuccessResponseSchema.safeParse(response).success).toBe(false);

    const atCap = makeSuccessResponse();
    // 3 × 2400 + 300 = MAX_TOTAL_POLISHED_CHARS exactly, each item under the
    // per-item cap.
    atCap.items = [0, 1, 2].map((index) => ({
      id: `i${index}`,
      polished: "x".repeat(MAX_POLISHED_ITEM_CHARS),
    }));
    (atCap.items as { id: string; polished: string }[]).push({
      id: "i3",
      polished: "y".repeat(MAX_TOTAL_POLISHED_CHARS - 3 * MAX_POLISHED_ITEM_CHARS),
    });
    expect(polishSuccessResponseSchema.safeParse(atCap).success).toBe(true);
  });

  it("rejects quota with remaining > limit", () => {
    const response = makeSuccessResponse();
    response.quota = { limit: 20, remaining: 25, resetAt: "2026-08-03T00:00:00.000Z" };
    expect(polishSuccessResponseSchema.safeParse(response).success).toBe(false);

    const atLimit = makeSuccessResponse();
    atLimit.quota = { limit: 20, remaining: 20, resetAt: "2026-08-03T00:00:00.000Z" };
    expect(polishSuccessResponseSchema.safeParse(atLimit).success).toBe(true);
  });

  it("rejects success responses with empty polished text or bad quota", () => {
    const emptyPolished = makeSuccessResponse();
    emptyPolished.items = [{ id: "i0", polished: "" }];
    expect(polishSuccessResponseSchema.safeParse(emptyPolished).success).toBe(false);

    const badQuota = makeSuccessResponse();
    badQuota.quota = { limit: 20, remaining: -1, resetAt: "not-a-date" };
    expect(polishSuccessResponseSchema.safeParse(badQuota).success).toBe(false);
  });

  it("freezes the GET /api/polish/quota success envelope", () => {
    const valid = { requestId: "req-02", quota: { ...QUOTA } };
    expect(polishQuotaResponseSchema.safeParse(valid).success).toBe(true);

    // Unknown top-level fields are rejected (strict), missing requestId too.
    expect(polishQuotaResponseSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(polishQuotaResponseSchema.safeParse({ quota: { ...QUOTA } }).success).toBe(false);
    // The quota cross-field rule applies here as well.
    const overRemaining = {
      requestId: "req-02",
      quota: { limit: 20, remaining: 21, resetAt: "2026-08-03T00:00:00.000Z" },
    };
    expect(polishQuotaResponseSchema.safeParse(overRemaining).success).toBe(false);
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

  it("rejects error responses with unknown codes or unknown fields", () => {
    const response = {
      requestId: "req-01",
      error: { code: "NOT_A_CODE", message: "nope" },
    };
    expect(polishErrorResponseSchema.safeParse(response).success).toBe(false);

    const unknownTopLevel = {
      requestId: "req-01",
      error: { code: "AI_DISABLED", message: "disabled" },
      stack: "boom",
    };
    expect(polishErrorResponseSchema.safeParse(unknownTopLevel).success).toBe(false);

    const unknownNested = {
      requestId: "req-01",
      error: { code: "AI_DISABLED", message: "disabled", detail: "raw upstream body" },
    };
    expect(polishErrorResponseSchema.safeParse(unknownNested).success).toBe(false);
  });
});

describe("type inference", () => {
  it("PolishRequest sectionId is a CvSectionId", () => {
    const parsed = polishRequestSchema.parse(makeRequest()) satisfies PolishRequest;
    const sectionId: CvSectionId = parsed.sectionId;
    expect(ORDERED_SECTION_IDS).toContain(sectionId);
  });
});
