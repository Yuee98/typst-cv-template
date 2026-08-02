import { describe, expect, it } from "vitest";
import type { PolishItem } from "@/lib/polish/contract";
import {
  diffProtectedTokens,
  extractProtectedTokens,
  passesLanguageRoughCheck,
  perItemPolishedCharCap,
  validatePolishOutput,
  type ProviderFinishReason,
  type RawModelOutput,
} from "./validate";

const ORIGINAL_ZH = "负责后端服务开发，将 P99 延迟降低 40%。";

function ctx(items: PolishItem[], language: "zh" | "en" = "zh") {
  return { items, language };
}

function singleItem(text: string = ORIGINAL_ZH): PolishItem[] {
  return [{ id: "i0", kind: "experience_bullet", text }];
}

function raw(
  items: { id: string; polished: string }[],
  finishReason: ProviderFinishReason = "stop",
): RawModelOutput {
  return { text: JSON.stringify({ items }), finishReason };
}

function rawText(text: string, finishReason: ProviderFinishReason = "stop"): RawModelOutput {
  return { text, finishReason };
}

describe("validatePolishOutput — happy path", () => {
  it("accepts a valid output and returns id/polished pairs", () => {
    const result = validatePolishOutput(
      raw([{ id: "i0", polished: "负责后端核心服务的开发与优化，将 P99 延迟降低 40%。" }]),
      ctx(singleItem()),
    );
    expect(result).toEqual({
      ok: true,
      items: [{ id: "i0", polished: "负责后端核心服务的开发与优化，将 P99 延迟降低 40%。" }],
    });
  });
});

describe("validatePolishOutput — finish_reason checkpoint", () => {
  it("length is a truncated (invalid) output", () => {
    const result = validatePolishOutput(raw([{ id: "i0", polished: "x" }], "length"), ctx(singleItem()));
    expect(result).toMatchObject({ ok: false, stage: "finish_reason", classification: "invalid_output" });
  });

  it("content_filter is an invalid output", () => {
    const result = validatePolishOutput(raw([], "content_filter"), ctx(singleItem()));
    expect(result).toMatchObject({ ok: false, stage: "finish_reason", classification: "invalid_output" });
  });

  it("unknown is an invalid output", () => {
    const result = validatePolishOutput(raw([], "unknown"), ctx(singleItem()));
    expect(result).toMatchObject({ ok: false, stage: "finish_reason", classification: "invalid_output" });
  });

  it("insufficient_system_resource is classified as an upstream fault", () => {
    const result = validatePolishOutput(raw([], "insufficient_system_resource"), ctx(singleItem()));
    expect(result).toMatchObject({ ok: false, stage: "finish_reason", classification: "upstream" });
  });
});

describe("validatePolishOutput — empty body / JSON parse / schema checkpoints", () => {
  it.each(["", "   \n  "])("rejects an empty body (%j)", (text) => {
    const result = validatePolishOutput(rawText(text), ctx(singleItem()));
    expect(result).toMatchObject({ ok: false, stage: "empty_content" });
  });

  it.each(["not json at all", '{"items": ['])("rejects unparseable JSON (%j)", (text) => {
    const result = validatePolishOutput(rawText(text), ctx(singleItem()));
    expect(result).toMatchObject({ ok: false, stage: "json_parse" });
  });

  it.each([
    "{}",
    "[1,2,3]",
    '{"items": "nope"}',
    '{"items": []}',
    '{"items": [{"id": "i0"}]}',
    '{"items": [{"polished": "x"}]}',
    '{"items": [{"id": 1, "polished": "x"}]}',
  ])("rejects structurally invalid JSON (%j)", (text) => {
    const result = validatePolishOutput(rawText(text), ctx(singleItem()));
    expect(result).toMatchObject({ ok: false, stage: "schema_validation" });
  });
});

describe("validatePolishOutput — ID exact-set checkpoint", () => {
  const twoItems: PolishItem[] = [
    { id: "i0", kind: "experience_bullet", text: "第一条原文。" },
    { id: "i1", kind: "experience_bullet", text: "第二条原文。" },
  ];

  it("rejects a missing id", () => {
    const result = validatePolishOutput(raw([{ id: "i0", polished: "第一条润色。" }]), ctx(twoItems));
    expect(result).toMatchObject({ ok: false, stage: "id_set_mismatch" });
    if (!result.ok) expect(result.reason).toContain("i1");
  });

  it("rejects an unexpected extra id", () => {
    const result = validatePolishOutput(
      raw([
        { id: "i0", polished: "第一条润色。" },
        { id: "i1", polished: "第二条润色。" },
        { id: "i9", polished: "多出来的。" },
      ]),
      ctx(twoItems),
    );
    expect(result).toMatchObject({ ok: false, stage: "id_set_mismatch" });
    if (!result.ok) expect(result.reason).toContain("i9");
  });

  it("rejects a duplicated id", () => {
    const result = validatePolishOutput(
      raw([
        { id: "i0", polished: "第一条润色。" },
        { id: "i0", polished: "重复的第一条。" },
      ]),
      ctx(twoItems),
    );
    expect(result).toMatchObject({ ok: false, stage: "id_set_mismatch" });
    if (!result.ok) expect(result.reason).toContain("i0");
  });

  it("accepts ids in a different order (set equality, not sequence)", () => {
    const result = validatePolishOutput(
      raw([
        { id: "i1", polished: "第二条润色。" },
        { id: "i0", polished: "第一条润色。" },
      ]),
      ctx(twoItems),
    );
    expect(result.ok).toBe(true);
  });
});

describe("validatePolishOutput — per-item non-empty checkpoint", () => {
  it.each(["", "   ", " \n\t "])("rejects an empty polished string (%j)", (polished) => {
    const result = validatePolishOutput(raw([{ id: "i0", polished }]), ctx(singleItem()));
    expect(result).toMatchObject({ ok: false, stage: "empty_item" });
  });
});

describe("perItemPolishedCharCap", () => {
  it("is ceil(original × 1.5) + 40 below the absolute ceiling", () => {
    expect(perItemPolishedCharCap(100)).toBe(190);
    expect(perItemPolishedCharCap(20)).toBe(70);
  });

  it("is clamped at 2400 for long originals", () => {
    expect(perItemPolishedCharCap(2000)).toBe(2400);
  });
});

describe("validatePolishOutput — length checkpoints", () => {
  it("accepts polished text exactly at the per-item cap", () => {
    const items = singleItem("原".repeat(100));
    const result = validatePolishOutput(raw([{ id: "i0", polished: "润".repeat(190) }]), ctx(items));
    expect(result.ok).toBe(true);
  });

  it("rejects polished text one char over the per-item cap", () => {
    const items = singleItem("原".repeat(100));
    const result = validatePolishOutput(raw([{ id: "i0", polished: "润".repeat(191) }]), ctx(items));
    expect(result).toMatchObject({ ok: false, stage: "length_cap" });
  });

  it("applies the 2400 absolute ceiling to long originals", () => {
    const items = singleItem("原".repeat(2000));
    const result = validatePolishOutput(raw([{ id: "i0", polished: "润".repeat(2401) }]), ctx(items));
    expect(result).toMatchObject({ ok: false, stage: "length_cap" });
  });

  it("rejects when the total polished length exceeds MAX_TOTAL_POLISHED_CHARS", () => {
    // 5 × 1000 original chars (total 5000, within the contract); per-item cap
    // 1540 each → 5 × 1540 = 7700 > 7500 total cap.
    const items = Array.from({ length: 5 }, (_, index) => ({
      id: `i${index}`,
      kind: "experience_bullet" as const,
      text: "原".repeat(1000),
    }));
    const output = items.map((item) => ({ id: item.id, polished: "润".repeat(1540) }));
    const result = validatePolishOutput(raw(output), ctx(items));
    expect(result).toMatchObject({ ok: false, stage: "total_length_cap" });
  });
});

describe("passesLanguageRoughCheck", () => {
  it("zh: rejects output that is essentially all English", () => {
    expect(
      passesLanguageRoughCheck(
        "Led backend service development and reduced latency significantly across core systems.",
        "zh",
      ),
    ).toBe(false);
  });

  it("zh: accepts mixed zh/en text (no false kill)", () => {
    expect(
      passesLanguageRoughCheck("负责后端服务的开发与优化，improved system stability，将延迟显著降低。", "zh"),
    ).toBe(true);
  });

  it("en: rejects output that is essentially all Chinese", () => {
    expect(
      passesLanguageRoughCheck("全面主导后端核心服务的架构设计与持续优化工作，显著提升系统稳定性。", "en"),
    ).toBe(false);
  });

  it("en: accepts English text containing a Chinese proper noun (no false kill)", () => {
    expect(passesLanguageRoughCheck("Led a 12-person team at 阿里巴巴, growing revenue steadily.", "en")).toBe(
      true,
    );
  });

  it("skips the check for short text in either language", () => {
    expect(passesLanguageRoughCheck("SDK development done.", "zh")).toBe(true);
    expect(passesLanguageRoughCheck("完成了。", "en")).toBe(true);
  });
});

describe("validatePolishOutput — language rough-check checkpoint", () => {
  it("zh request + all-English output is rejected", () => {
    const result = validatePolishOutput(
      raw([
        {
          id: "i0",
          polished: "Led backend development and reduced latency across systems.",
        },
      ]),
      ctx(singleItem(), "zh"),
    );
    expect(result).toMatchObject({ ok: false, stage: "language_mismatch" });
  });

  it("zh request + mixed zh/en output passes (中英混排不误杀)", () => {
    const result = validatePolishOutput(
      raw([
        {
          id: "i0",
          polished: "负责后端服务的开发与优化，improved system stability，将 P99 延迟降低 40%。",
        },
      ]),
      ctx(singleItem(), "zh"),
    );
    expect(result.ok).toBe(true);
  });

  it("en request + all-Chinese output is rejected", () => {
    const items: PolishItem[] = [
      { id: "i0", kind: "experience_bullet", text: "Led backend development, improving P99 latency by 40%." },
    ];
    const result = validatePolishOutput(
      raw([
        {
          id: "i0",
          polished:
            "全面主导后端核心服务的架构设计、性能治理与持续优化工作，围绕 P99 延迟与 40% 提升等关键指标推进落地。",
        },
      ]),
      ctx(items, "en"),
    );
    expect(result).toMatchObject({ ok: false, stage: "language_mismatch" });
  });

  it("en request + English output with a Chinese company name passes (中英混排不误杀)", () => {
    const items: PolishItem[] = [
      {
        id: "i0",
        kind: "experience_bullet",
        text: "Led a 12-person team at Alibaba, growing revenue by 40% year over year.",
      },
    ];
    const result = validatePolishOutput(
      raw([
        { id: "i0", polished: "Led a 12-person team at 阿里巴巴, growing revenue by 40% year over year." },
      ]),
      ctx(items, "en"),
    );
    expect(result.ok).toBe(true);
  });
});

describe("extractProtectedTokens / diffProtectedTokens", () => {
  it("extracts numbers, percentages, dates, URLs, versions, currencies, tech names", () => {
    const tokens = extractProtectedTokens(
      "2024年3月 将 https://example.com/docs 从 v1.2.3 升级，节省 $12,000，QPS 提升 40%，P99 降至 200ms，基于 Node.js 与 C++。",
    );
    expect(tokens).toEqual(
      [
        "$12,000",
        "200ms",
        "2024年3月",
        "40%",
        "C++",
        "Node.js",
        "P99",
        "QPS",
        "https://example.com/docs",
        "v1.2.3",
      ].sort(),
    );
  });

  it("extracts times, comma-grouped numbers, CJK magnitudes and month-year dates", () => {
    expect(extractProtectedTokens("每日 14:30 同步，服务 1,000 名用户，营收 5亿。")).toEqual(
      ["1,000", "14:30", "5亿"].sort(),
    );
    expect(extractProtectedTokens("Promoted in Jan 2024.")).toEqual(["Jan2024"]);
  });

  it("normalizes insignificant whitespace inside tokens", () => {
    expect(diffProtectedTokens("节省 300美元。", "节省 300 美元。")).toEqual({ missing: [], added: [] });
    expect(diffProtectedTokens("2024年 3月 上线。", "2024 年 3 月上线。")).toEqual({ missing: [], added: [] });
  });

  it("detects the merge of two identical numbers (multiset, not set)", () => {
    const diff = diffProtectedTokens("Q1 营收增长 30%，Q2 营收增长 30%。", "Q1、Q2 营收均增长 30%。");
    expect(diff.missing).toEqual(['"30%" ×1']);
    expect(diff.added).toEqual([]);
  });

  it("detects changed numbers in both directions", () => {
    const diff = diffProtectedTokens("延迟降低 40%。", "延迟降低 50%。");
    expect(diff.missing).toEqual(['"40%" ×1']);
    expect(diff.added).toEqual(['"50%" ×1']);
  });
});

describe("validatePolishOutput — protected spans checkpoint", () => {
  it("passes when all spans are preserved verbatim through rewording", () => {
    const items = singleItem("负责后端性能优化，P99 延迟从 200ms 降至 120ms，QPS 提升 40%。");
    const result = validatePolishOutput(
      raw([{ id: "i0", polished: "负责后端性能优化工作，将 P99 延迟从 200ms 降至 120ms，QPS 提升 40%。" }]),
      ctx(items),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects the merge of two identical numbers (相同数字合并边界)", () => {
    const items = singleItem("Q1 营收增长 30%，Q2 营收增长 30%。");
    const result = validatePolishOutput(raw([{ id: "i0", polished: "Q1、Q2 营收均增长 30%。" }]), ctx(items));
    expect(result).toMatchObject({ ok: false, stage: "protected_spans" });
    if (!result.ok) expect(result.reason).toContain('"30%" ×1');
  });

  it("rejects an invented metric that never appeared in the original", () => {
    const items = singleItem("负责后端服务开发。");
    const result = validatePolishOutput(
      raw([{ id: "i0", polished: "负责后端服务开发，QPS 提升 50%。" }]),
      ctx(items),
    );
    expect(result).toMatchObject({ ok: false, stage: "protected_spans" });
    if (!result.ok) expect(result.reason).toContain('"50%" ×1');
  });

  it("rejects a duplicated technical name (exact multiset equality)", () => {
    const items = singleItem("负责 Node.js 后端开发。");
    const result = validatePolishOutput(
      raw([{ id: "i0", polished: "负责 Node.js 后端开发，优化 Node.js 服务性能。" }]),
      ctx(items),
    );
    expect(result).toMatchObject({ ok: false, stage: "protected_spans" });
    if (!result.ok) expect(result.reason).toContain('"Node.js" ×1');
  });

  it("rejects a changed tech metric (P99 → P95)", () => {
    const items = singleItem("将 P99 延迟降低。");
    const result = validatePolishOutput(raw([{ id: "i0", polished: "将 P95 延迟降低。" }]), ctx(items));
    expect(result).toMatchObject({ ok: false, stage: "protected_spans" });
  });

  it("rejects a reformatted date (dates are preserved verbatim)", () => {
    const items = singleItem("2024年3月 项目上线。");
    const result = validatePolishOutput(raw([{ id: "i0", polished: "2024-03 项目上线。" }]), ctx(items));
    expect(result).toMatchObject({ ok: false, stage: "protected_spans" });
  });

  it("accepts a preserved fullwidth percent and rejects a changed one", () => {
    const items = singleItem("营收增长 40％。");
    expect(
      validatePolishOutput(raw([{ id: "i0", polished: "实现营收增长 40％。" }]), ctx(items)).ok,
    ).toBe(true);
    expect(validatePolishOutput(raw([{ id: "i0", polished: "实现营收增长 50％。" }]), ctx(items))).toMatchObject(
      { ok: false, stage: "protected_spans" },
    );
  });

  it("accepts a preserved URL and rejects a changed one", () => {
    const items = singleItem("项目文档见 https://example.com/docs 。");
    expect(
      validatePolishOutput(raw([{ id: "i0", polished: "项目文档详见 https://example.com/docs 。" }]), ctx(items))
        .ok,
    ).toBe(true);
    expect(
      validatePolishOutput(raw([{ id: "i0", polished: "项目文档详见 https://example.com/other 。" }]), ctx(items)),
    ).toMatchObject({ ok: false, stage: "protected_spans" });
  });

  it("accepts a preserved version number and rejects a changed one", () => {
    const items = singleItem("主导 v2.3.1 版本发布。");
    expect(validatePolishOutput(raw([{ id: "i0", polished: "主导 v2.3.1 版本的发布。" }]), ctx(items)).ok).toBe(
      true,
    );
    expect(
      validatePolishOutput(raw([{ id: "i0", polished: "主导 v2.4.0 版本的发布。" }]), ctx(items)),
    ).toMatchObject({ ok: false, stage: "protected_spans" });
  });

  it("checks spans per item independently", () => {
    // "40%" appears in item i1's original but not i0's; moving it into i0's
    // polished text must fail even though the whole-response multiset matches.
    const items: PolishItem[] = [
      { id: "i0", kind: "experience_bullet", text: "负责后端开发。" },
      { id: "i1", kind: "experience_bullet", text: "将 P99 延迟降低 40%。" },
    ];
    const result = validatePolishOutput(
      raw([
        { id: "i0", polished: "负责后端开发，性能提升 40%。" },
        { id: "i1", polished: "将 P99 延迟显著降低。" },
      ]),
      ctx(items),
    );
    expect(result).toMatchObject({ ok: false, stage: "protected_spans" });
  });
});
