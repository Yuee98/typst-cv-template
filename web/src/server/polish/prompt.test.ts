import { describe, expect, it } from "vitest";
import { POLISH_REFERENCE_ROLES, POLISH_STYLE_PRESETS } from "@/lib/polish/contract";
import {
  buildPolishMessages,
  buildPolishPromptBlocks,
  buildSystemPrompt,
  buildUserPrompt,
  POLISH_STABLE_PROMPT_BLOCK_ID,
  POLISH_VARIABLE_PROMPT_BLOCK_ID,
  trimReferencesForLevel,
  type PolishPromptInput,
} from "./prompt";

function makeInput(overrides: Partial<PolishPromptInput> = {}): PolishPromptInput {
  return {
    language: "zh",
    sectionId: "experience",
    granularity: "item",
    items: [{ id: "i0", kind: "experience_bullet", text: "负责后端服务开发，将 P99 延迟降低 40%。" }],
    contextLevel: 0,
    references: [],
    ...overrides,
  };
}

describe("buildSystemPrompt — shared base", () => {
  it("contains the hard constraints and the JSON output contract", () => {
    const prompt = buildSystemPrompt("zh");
    expect(prompt).toContain("Never change, add, or remove facts");
    expect(prompt).toContain("numbers and counts");
    expect(prompt).toContain("currencies");
    expect(prompt).toContain("percentages");
    expect(prompt).toContain("dates and times");
    expect(prompt).toContain("units of measure");
    expect(prompt).toContain("URLs");
    expect(prompt).toContain("version numbers");
    expect(prompt).toContain("code-like technical names");
    expect(prompt).toContain("proper nouns");
    // semantic prohibitions: no role upgrades, attribution preserved
    expect(prompt).toContain("responsibility attribution");
    expect(prompt).toContain('"participated in" must not become "led"');
    // 1:1 mapping
    expect(prompt).toContain("never merge, split, reorder, add, or drop items");
    // context rule
    expect(prompt).toContain("Never polish, quote, or echo them");
    // user instruction subordination
    expect(prompt).toContain("subordinate to these constraints");
    // JSON contract
    expect(prompt).toContain('{"items":[{"id":"<input id>","polished":"<polished text>"}]}');
    expect(prompt).toContain("every input item id exactly once");
  });

  it("is identical for repeated calls (cache-friendly fixed prefix)", () => {
    expect(buildSystemPrompt("zh")).toBe(buildSystemPrompt("zh"));
  });
});

describe("buildSystemPrompt — language appendix", () => {
  it("zh appendix requires Chinese output and keeps proper nouns in original form", () => {
    const prompt = buildSystemPrompt("zh");
    expect(prompt).toContain("OUTPUT LANGUAGE: Simplified Chinese");
    expect(prompt).toContain("输出语言：简体中文");
    expect(prompt).toContain("an English technology name stays in English");
  });

  it("en appendix requires English output and keeps proper nouns in original form", () => {
    const prompt = buildSystemPrompt("en");
    expect(prompt).toContain("OUTPUT LANGUAGE: English");
    expect(prompt).toContain("a Chinese company name stays in Chinese");
  });

  it("zh and en system prompts differ only via the appendix", () => {
    expect(buildSystemPrompt("zh")).not.toBe(buildSystemPrompt("en"));
  });
});

describe("trimReferencesForLevel — server-side trimming, never trusting the client", () => {
  const references = POLISH_REFERENCE_ROLES.map((role) => ({
    role,
    label: `label-${role}`,
    text: `text-of-${role}`,
  }));

  it("level 0 drops every reference even if the client sent some", () => {
    expect(trimReferencesForLevel(0, references)).toEqual([]);
  });

  it("level 1 keeps only scope_metadata and sibling", () => {
    const trimmed = trimReferencesForLevel(1, references);
    expect(trimmed.map((reference) => reference.role)).toEqual(["scope_metadata", "sibling"]);
  });

  it("level 2 keeps all roles", () => {
    const trimmed = trimReferencesForLevel(2, references);
    expect(trimmed.map((reference) => reference.role)).toEqual([...POLISH_REFERENCE_ROLES]);
  });
});

describe("buildUserPrompt — level trimming is applied inside the builder", () => {
  it("level 0 request with smuggled references emits none of their text", () => {
    const prompt = buildUserPrompt(
      makeInput({
        contextLevel: 0,
        references: [{ role: "profile", text: "绝不应出现的 profile 内容" }],
      }),
    );
    expect(prompt).not.toContain("绝不应出现的 profile 内容");
    expect(prompt).not.toContain("<context");
  });

  it("level 1 request with profile/skill references only emits scope_metadata/sibling", () => {
    const prompt = buildUserPrompt(
      makeInput({
        contextLevel: 1,
        references: [
          { role: "scope_metadata", text: "scope-meta 内容" },
          { role: "sibling", text: "sibling 内容" },
          { role: "profile", text: "profile 不应出现" },
          { role: "skill", text: "skill 不应出现" },
        ],
      }),
    );
    expect(prompt).toContain("scope-meta 内容");
    expect(prompt).toContain("sibling 内容");
    expect(prompt).not.toContain("profile 不应出现");
    expect(prompt).not.toContain("skill 不应出现");
  });

  it("level 2 emits all references with their roles and labels", () => {
    const prompt = buildUserPrompt(
      makeInput({
        contextLevel: 2,
        references: [{ role: "profile", label: "Profile 摘要", text: "profile 内容" }],
      }),
    );
    expect(prompt).toContain('<context role="profile" label="Profile 摘要">');
    expect(prompt).toContain("profile 内容");
    expect(prompt).toContain("never polish, quote, or echo them");
  });
});

describe("buildUserPrompt — style injection", () => {
  it("expands every preset into a distinct directive", () => {
    const directives = POLISH_STYLE_PRESETS.map((stylePreset) =>
      buildUserPrompt(makeInput({ stylePreset })),
    );
    for (const [index, directive] of directives.entries()) {
      expect(directive).toContain("STYLE:");
      for (const [otherIndex, other] of directives.entries()) {
        if (otherIndex !== index) expect(directive).not.toBe(other);
      }
    }
  });

  it("quantified preset only highlights existing numbers, never invents metrics", () => {
    const prompt = buildUserPrompt(makeInput({ stylePreset: "quantified" }));
    expect(prompt).toContain("already present in the original text");
    expect(prompt).toContain("Never invent, infer, or rescale any metric");
  });

  it("management preset never implies managing people or teams", () => {
    const prompt = buildUserPrompt(makeInput({ stylePreset: "management" }));
    expect(prompt).toContain("never imply the writer managed people, teams, or budgets");
  });

  it("styleInstruction is injected inside <style_instruction> tags", () => {
    const prompt = buildUserPrompt(makeInput({ styleInstruction: "突出量化成果" }));
    expect(prompt).toContain("<style_instruction>\n突出量化成果\n</style_instruction>");
  });

  it("omits style sections entirely when neither preset nor instruction is given", () => {
    const prompt = buildUserPrompt(makeInput());
    expect(prompt).not.toContain("STYLE:");
    expect(prompt).not.toContain("<style_instruction>");
  });
});

describe("buildUserPrompt — items, granularity, retry feedback", () => {
  it("renders every item with its id", () => {
    const prompt = buildUserPrompt(
      makeInput({
        items: [
          { id: "i0", kind: "experience_bullet", text: "第一条" },
          { id: "i1", kind: "experience_bullet", text: "第二条" },
        ],
      }),
    );
    expect(prompt).toContain('<item id="i0">\n第一条\n</item>');
    expect(prompt).toContain('<item id="i1">\n第二条\n</item>');
    expect(prompt).toContain("return every id exactly once");
  });

  it.each([
    ["item", "a single text item"],
    ["entry", "all text items of one entry"],
    ["group", "all text items grouped under one company"],
    ["section", "all text items of one section"],
  ] as const)("describes the %s granularity scope", (granularity, scope) => {
    expect(buildUserPrompt(makeInput({ granularity }))).toContain(scope);
  });

  it("appends retry feedback with the previous failure reason", () => {
    const prompt = buildUserPrompt(
      makeInput({ retryFeedback: 'polished text is empty for ids: i0' }),
    );
    expect(prompt).toContain("your previous response failed validation");
    expect(prompt).toContain("polished text is empty for ids: i0");
    expect(prompt).toContain("return the corrected JSON for ALL items");
  });

  it("omits the retry section on the first attempt", () => {
    expect(buildUserPrompt(makeInput())).not.toContain("failed validation");
  });

  it("ends with the JSON-only reminder", () => {
    expect(buildUserPrompt(makeInput())).toContain(
      'Respond with JSON only: {"items":[{"id":"...","polished":"..."}]}',
    );
  });
});

describe("buildPolishMessages", () => {
  it("returns system + user messages with level trimming applied", () => {
    const messages = buildPolishMessages(
      makeInput({
        contextLevel: 1,
        references: [{ role: "skill", text: "不应出现的 skill 内容" }],
      }),
    );
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[0].content).toBe(buildSystemPrompt("zh"));
    expect(messages[1].content).not.toContain("不应出现的 skill 内容");
  });

  it("is compiled from the same source as the canonical V2 prompt blocks", () => {
    const input = makeInput({
      stylePreset: "concise",
      contextLevel: 1,
      references: [{ role: "sibling", text: "相邻条目" }],
    });
    const prompt = buildPolishPromptBlocks(input);

    expect(buildPolishMessages(input)).toEqual(
      prompt.blocks.map((block) => ({
        role: block.role === "developer" ? "system" : "user",
        content: block.content,
      })),
    );
  });
});

describe("buildPolishPromptBlocks", () => {
  it("emits one stable developer prefix followed by one variable user suffix", () => {
    expect(buildPolishPromptBlocks(makeInput())).toEqual({
      blocks: [
        {
          id: POLISH_STABLE_PROMPT_BLOCK_ID,
          role: "developer",
          stability: "stable",
          content: buildSystemPrompt("zh"),
        },
        {
          id: POLISH_VARIABLE_PROMPT_BLOCK_ID,
          role: "user",
          stability: "variable",
          content: buildUserPrompt(makeInput()),
        },
      ],
      explicitCacheBoundaryAfter: POLISH_STABLE_PROMPT_BLOCK_ID,
    });
  });

  it("keeps every request-derived value after the cache boundary", () => {
    const requestValues = [
      "private-section-id",
      "private-item-id",
      "private CV text",
      "private-reference-label",
      "private reference text",
      "private custom style",
      "private retry feedback",
    ];
    const prompt = buildPolishPromptBlocks(
      makeInput({
        sectionId: requestValues[0],
        items: [{ id: requestValues[1], kind: "experience_bullet", text: requestValues[2] }],
        contextLevel: 2,
        references: [{ role: "profile", label: requestValues[3], text: requestValues[4] }],
        styleInstruction: requestValues[5],
        retryFeedback: requestValues[6],
      }),
    );

    const boundaryIndex = prompt.blocks.findIndex(
      (block) => block.id === prompt.explicitCacheBoundaryAfter,
    );
    const stablePrefix = prompt.blocks
      .slice(0, boundaryIndex + 1)
      .map((block) => block.content)
      .join("\n");
    const variableSuffix = prompt.blocks
      .slice(boundaryIndex + 1)
      .map((block) => block.content)
      .join("\n");

    for (const value of requestValues) {
      expect(stablePrefix).not.toContain(value);
      expect(variableSuffix).toContain(value);
    }
  });

  it("keeps the stable prefix independent of request data for the same locale", () => {
    const first = buildPolishPromptBlocks(makeInput());
    const second = buildPolishPromptBlocks(
      makeInput({
        sectionId: "projects",
        items: [{ id: "different", kind: "experience_bullet", text: "entirely different" }],
        stylePreset: "management",
      }),
    );

    expect(first.blocks[0]).toEqual(second.blocks[0]);
    expect(first.blocks[1]).not.toEqual(second.blocks[1]);
  });
});
