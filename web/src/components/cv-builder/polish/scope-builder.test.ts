import { describe, expect, it } from "vitest";

import {
  DEFAULT_SECTION_ORDER,
  ORDERED_SECTION_IDS,
  type CvData,
} from "@/lib/cv/schema";
import {
  ITEM_ID_PATTERN,
  MAX_ITEM_CHARS,
  MAX_ITEMS,
  MAX_REFERENCE_CHARS,
  MAX_REFERENCE_ITEM_CHARS,
  MAX_STYLE_INSTRUCTION_CHARS,
  POLISH_CAPABILITY_MATRIX,
  polishRequestSchema,
  type PolishContextLevel,
} from "@/lib/polish/contract";

import {
  buildPolishSnapshot,
  isPolishableText,
  MIN_POLISHABLE_TEXT_CHARS,
  type BuildPolishSnapshotInput,
  type PolishScope,
  type PolishSnapshot,
} from "./scope-builder";

const CLIENT_REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

function bullet(body: string) {
  return { body };
}

function makeCvData(): CvData {
  return {
    schemaVersion: 7,
    typstLang: "zh",
    sectionOrder: [...DEFAULT_SECTION_ORDER],
    header: {
      name: "张三",
      subtitle: "",
      email: "zhangsan@example.com",
      phone: "13800000000",
      selfName: "",
    },
    sectionTitles: Object.fromEntries(
      ORDERED_SECTION_IDS.map((id) => [
        id,
        { title: `${id} title`, isDisplay: true, pageBreakBefore: false },
      ]),
    ) as CvData["sectionTitles"],
    profile: [
      bullet("五年后端开发经验，专注高并发分布式系统。"),
      bullet("热爱开源，持续输出技术博客。"),
    ],
    skills: [
      { label: "编程语言", body: "TypeScript、Go、Rust，熟悉函数式编程范式。" },
      { label: "框架", body: "React、Next.js、NestJS，有大型项目实战经验。" },
      { label: "", body: "短" },
    ],
    experience: [
      {
        org: "阿里巴巴",
        date: "2020-2023",
        projects: [
          {
            title: "订单中台",
            detail: "核心交易链路重构",
            date: "2021-2023",
            bullets: [
              bullet("主导订单系统重构，支撑双 11 峰值每秒 50 万笔下单。"),
              bullet("引入分库分表方案，将核心查询 P99 延迟降低 60%。"),
            ],
          },
          {
            title: "营销平台",
            detail: "",
            date: "2020-2021",
            bullets: [bullet("搭建营销活动配置平台，上线周期从两周缩短到两天。")],
          },
        ],
      },
      {
        org: "字节跳动",
        date: "2018-2020",
        projects: [
          {
            title: "推荐系统",
            detail: "信息流推荐",
            date: "2018-2020",
            bullets: [
              bullet("优化推荐召回链路，点击率提升 12%。"),
              bullet("设计特征平台，支撑 200+ 模型特征在线服务。"),
            ],
          },
        ],
      },
    ],
    education: [
      {
        org: "清华大学",
        title: "计算机科学与技术 硕士",
        detail: "分布式系统方向",
        date: "2015-2018",
        bullets: [
          bullet("研究分布式一致性协议，发表 OSDI 论文一篇。"),
          bullet("GPA 3.8/4.0，获国家奖学金。"),
        ],
      },
      {
        org: "北京大学",
        title: "软件工程 本科",
        detail: "",
        date: "2011-2015",
        bullets: [bullet("担任学院科协主席，组织 10 余场技术讲座。")],
      },
    ],
    research: [
      {
        title: "分布式存储副本协议",
        date: "2017",
        bullets: [bullet("提出改进的副本同步协议，写入吞吐提升 30%。")],
      },
    ],
    publications: [
      { authors: "张三", title: "A Paper", venue: "OSDI", year: "2018", url: "https://example.com" },
    ],
    additional: [
      { label: "语言", body: "英语流利（CET-6），可作为工作语言。" },
      { label: "兴趣", body: "马拉松、摄影、开源社区贡献者。" },
    ],
  };
}

function build(
  overrides: Partial<BuildPolishSnapshotInput> & { scope: PolishScope },
) {
  return buildPolishSnapshot({
    documentId: "doc-1",
    cv: makeCvData(),
    language: "zh",
    level: 1,
    clientRequestId: CLIENT_REQUEST_ID,
    ...overrides,
  });
}

function expectOk(result: ReturnType<typeof build>): PolishSnapshot {
  if (!result.ok) throw new Error(`expected ok, got failure "${result.code}"`);
  return result.snapshot;
}

// ---------------------------------------------------------------------------
// scope -> targets mapping (capability matrix)
// ---------------------------------------------------------------------------

const MATRIX_CASES: Array<{
  name: string;
  scope: PolishScope;
  expectedPaths: string[];
}> = [
  {
    name: "profile item",
    scope: { sectionId: "profile", granularity: "item", itemId: "1" },
    expectedPaths: ["profile.1.body"],
  },
  {
    name: "profile entry (whole profile)",
    scope: { sectionId: "profile", granularity: "entry" },
    expectedPaths: ["profile.0.body", "profile.1.body"],
  },
  {
    name: "skills item",
    scope: { sectionId: "skills", granularity: "item", itemId: "0" },
    expectedPaths: ["skills.0.body"],
  },
  {
    name: "skills section (short item filtered out)",
    scope: { sectionId: "skills", granularity: "section" },
    expectedPaths: ["skills.0.body", "skills.1.body"],
  },
  {
    name: "experience item",
    scope: { sectionId: "experience", granularity: "item", itemId: "1.0.1" },
    expectedPaths: ["experience.1.projects.0.bullets.1.body"],
  },
  {
    name: "experience entry",
    scope: { sectionId: "experience", granularity: "entry", entryId: "0.0" },
    expectedPaths: [
      "experience.0.projects.0.bullets.0.body",
      "experience.0.projects.0.bullets.1.body",
    ],
  },
  {
    name: "experience company group",
    scope: { sectionId: "experience", granularity: "group", groupId: "0" },
    expectedPaths: [
      "experience.0.projects.0.bullets.0.body",
      "experience.0.projects.0.bullets.1.body",
      "experience.0.projects.1.bullets.0.body",
    ],
  },
  {
    name: "experience section",
    scope: { sectionId: "experience", granularity: "section" },
    expectedPaths: [
      "experience.0.projects.0.bullets.0.body",
      "experience.0.projects.0.bullets.1.body",
      "experience.0.projects.1.bullets.0.body",
      "experience.1.projects.0.bullets.0.body",
      "experience.1.projects.0.bullets.1.body",
    ],
  },
  {
    name: "education item",
    scope: { sectionId: "education", granularity: "item", itemId: "0.1" },
    expectedPaths: ["education.0.bullets.1.body"],
  },
  {
    name: "education entry",
    scope: { sectionId: "education", granularity: "entry", entryId: "1" },
    expectedPaths: ["education.1.bullets.0.body"],
  },
  {
    name: "education section",
    scope: { sectionId: "education", granularity: "section" },
    expectedPaths: [
      "education.0.bullets.0.body",
      "education.0.bullets.1.body",
      "education.1.bullets.0.body",
    ],
  },
  {
    name: "research item",
    scope: { sectionId: "research", granularity: "item", itemId: "0.0" },
    expectedPaths: ["research.0.bullets.0.body"],
  },
  {
    name: "research entry",
    scope: { sectionId: "research", granularity: "entry", entryId: "0" },
    expectedPaths: ["research.0.bullets.0.body"],
  },
  {
    name: "research section",
    scope: { sectionId: "research", granularity: "section" },
    expectedPaths: ["research.0.bullets.0.body"],
  },
  {
    name: "additional item",
    scope: { sectionId: "additional", granularity: "item", itemId: "1" },
    expectedPaths: ["additional.1.body"],
  },
  {
    name: "additional section",
    scope: { sectionId: "additional", granularity: "section" },
    expectedPaths: ["additional.0.body", "additional.1.body"],
  },
];

describe("scope -> targets mapping (capability matrix)", () => {
  it("covers every valid (section, granularity) combination of the matrix", () => {
    const covered = new Set(
      MATRIX_CASES.map(({ scope }) => `${scope.sectionId}/${scope.granularity}`),
    );
    for (const [sectionId, capability] of Object.entries(POLISH_CAPABILITY_MATRIX)) {
      for (const granularity of capability.granularities) {
        expect(covered).toContain(`${sectionId}/${granularity}`);
      }
    }
  });

  it.each(MATRIX_CASES)(
    "resolves $name to RHF paths with contract ids and kind",
    ({ scope, expectedPaths }) => {
      const snapshot = expectOk(build({ scope }));
      const capability = POLISH_CAPABILITY_MATRIX[scope.sectionId as keyof typeof POLISH_CAPABILITY_MATRIX];

      expect(snapshot.targets.map((target) => target.path)).toEqual(expectedPaths);
      expect(snapshot.targets.map((target) => target.id)).toEqual(
        expectedPaths.map((_, index) => `i${index}`),
      );
      for (const target of snapshot.targets) {
        expect(target.id).toMatch(ITEM_ID_PATTERN);
      }
      // apiRequest mirrors the targets with the section's contract kind.
      expect(snapshot.apiRequest.items).toEqual(
        snapshot.targets.map(({ id, text }) => ({ id, kind: capability.kind, text })),
      );
      expect(snapshot.apiRequest.granularity).toBe(scope.granularity);
      expect(snapshot.apiRequest.sectionId).toBe(scope.sectionId);
    },
  );

  it.each(["item", "entry", "group", "section"] as const)(
    "rejects publications at granularity %s",
    (granularity) => {
      const result = build({ scope: { sectionId: "publications", granularity } });
      expect(result).toEqual({ ok: false, code: "section_not_polishable" });
    },
  );

  it.each([
    { sectionId: "profile", granularity: "section" },
    { sectionId: "skills", granularity: "entry" },
    { sectionId: "additional", granularity: "entry" },
    { sectionId: "education", granularity: "group" },
  ] as const)("rejects unsupported $sectionId/$granularity", (scope) => {
    expect(build({ scope })).toEqual({ ok: false, code: "granularity_not_supported" });
  });
});

describe("scope resolution failures", () => {
  it.each([
    { name: "item without itemId", scope: { sectionId: "experience", granularity: "item" } },
    {
      name: "item with wrong-depth itemId",
      scope: { sectionId: "experience", granularity: "item", itemId: "0.0" },
    },
    {
      name: "item with out-of-bounds itemId",
      scope: { sectionId: "experience", granularity: "item", itemId: "9.0.0" },
    },
    {
      name: "item with malformed itemId",
      scope: { sectionId: "experience", granularity: "item", itemId: "abc" },
    },
    {
      name: "entry without entryId",
      scope: { sectionId: "education", granularity: "entry" },
    },
    {
      name: "entry with out-of-bounds entryId",
      scope: { sectionId: "education", granularity: "entry", entryId: "9" },
    },
    {
      name: "experience entry at company depth",
      scope: { sectionId: "experience", granularity: "entry", entryId: "0" },
    },
    {
      name: "group without groupId",
      scope: { sectionId: "experience", granularity: "group" },
    },
    {
      name: "group with project-depth groupId",
      scope: { sectionId: "experience", granularity: "group", groupId: "0.0" },
    },
    {
      name: "group with out-of-bounds groupId",
      scope: { sectionId: "experience", granularity: "group", groupId: "9" },
    },
  ] as const)("returns invalid_scope for $name", ({ scope }) => {
    expect(build({ scope })).toEqual({ ok: false, code: "invalid_scope" });
  });

  it("returns no_targets for an empty section scope", () => {
    const cv = makeCvData();
    cv.research = [];
    const result = build({ cv, scope: { sectionId: "research", granularity: "section" } });
    expect(result).toEqual({ ok: false, code: "no_targets" });
  });
});

// ---------------------------------------------------------------------------
// Aggregate filter
// ---------------------------------------------------------------------------

describe("aggregate filter", () => {
  it("isPolishableText implements the shared disable rule", () => {
    expect(isPolishableText("")).toBe(false);
    expect(isPolishableText("   ")).toBe(false);
    expect(isPolishableText("a".repeat(MIN_POLISHABLE_TEXT_CHARS - 1))).toBe(false);
    expect(isPolishableText("a".repeat(MIN_POLISHABLE_TEXT_CHARS))).toBe(true);
    expect(isPolishableText(`  ${"a".repeat(MIN_POLISHABLE_TEXT_CHARS)}  `)).toBe(true);
  });

  it("excludes blank and <10 char targets from a section scope", () => {
    const cv = makeCvData();
    cv.additional = [
      { label: "保留", body: "这段内容足够长，应当保留在 targets 中。" },
      { label: "空白", body: "   " },
      { label: "过短", body: "123456789" },
    ];
    const snapshot = expectOk(build({ cv, scope: { sectionId: "additional", granularity: "section" } }));
    expect(snapshot.targets.map((target) => target.path)).toEqual(["additional.0.body"]);
  });

  it("keeps the untrimmed stored text of a padded but long-enough target", () => {
    const cv = makeCvData();
    const padded = `  ${"这是一段有足够长度的填充文本。"}  `;
    cv.profile = [bullet(padded)];
    const snapshot = expectOk(build({ cv, scope: { sectionId: "profile", granularity: "entry" } }));
    expect(snapshot.targets[0].text).toBe(padded);
  });

  it("returns no_targets when the whole scope is filtered out", () => {
    const cv = makeCvData();
    cv.profile = [bullet("短"), bullet("   ")];
    expect(build({ cv, scope: { sectionId: "profile", granularity: "entry" } })).toEqual({
      ok: false,
      code: "no_targets",
    });
  });

  it("returns no_targets for a single short item scope", () => {
    const result = build({ scope: { sectionId: "skills", granularity: "item", itemId: "2" } });
    expect(result).toEqual({ ok: false, code: "no_targets" });
  });

  it("drops references that repeat a target text", () => {
    const cv = makeCvData();
    cv.education[0].bullets = [
      bullet("完全相同的一段 bullet 文本内容。"),
      bullet("完全相同的一段 bullet 文本内容。"),
    ];
    const snapshot = expectOk(
      build({ cv, scope: { sectionId: "education", granularity: "item", itemId: "0.0" } }),
    );
    expect(snapshot.apiRequest.context.references).not.toContainEqual(
      expect.objectContaining({ text: "完全相同的一段 bullet 文本内容。" }),
    );
  });

  it("deduplicates identical reference texts keeping the first occurrence", () => {
    const cv = makeCvData();
    cv.education[0].bullets = [
      bullet("目标 bullet，内容足够长。"),
      bullet("兄弟 bullet，出现了两次的文本。"),
      bullet("兄弟 bullet，出现了两次的文本。"),
    ];
    const snapshot = expectOk(
      build({ cv, scope: { sectionId: "education", granularity: "item", itemId: "0.0" } }),
    );
    const siblingTexts = snapshot.apiRequest.context.references
      .filter((reference) => reference.role === "sibling")
      .map((reference) => reference.text);
    expect(siblingTexts).toEqual(["兄弟 bullet，出现了两次的文本。"]);
  });
});

// ---------------------------------------------------------------------------
// Context levels
// ---------------------------------------------------------------------------

describe("context levels", () => {
  it("level 0 sends no references", () => {
    const snapshot = expectOk(
      build({
        level: 0,
        scope: { sectionId: "experience", granularity: "item", itemId: "0.0.0" },
      }),
    );
    expect(snapshot.apiRequest.context).toEqual({ level: 0, references: [] });
  });

  it("level 1 sends scope metadata and same-entry siblings only", () => {
    const snapshot = expectOk(
      build({
        scope: { sectionId: "experience", granularity: "item", itemId: "0.0.0" },
      }),
    );
    const references = snapshot.apiRequest.context.references;
    expect(references).toEqual([
      { role: "scope_metadata", label: "公司", text: "阿里巴巴" },
      { role: "scope_metadata", label: "项目", text: "订单中台" },
      { role: "scope_metadata", label: "项目详情", text: "核心交易链路重构" },
      { role: "sibling", text: "引入分库分表方案，将核心查询 P99 延迟降低 60%。" },
    ]);
    // No content from other companies or sections leaks into level 1.
    const sent = JSON.stringify(snapshot.apiRequest);
    expect(sent).not.toContain("字节跳动");
    expect(sent).not.toContain("营销平台");
  });

  it("level 1 entry scope uses sibling entries in the same parent container", () => {
    const snapshot = expectOk(
      build({
        scope: { sectionId: "experience", granularity: "entry", entryId: "0.0" },
      }),
    );
    const references = snapshot.apiRequest.context.references;
    const siblingTexts = references
      .filter((reference) => reference.role === "sibling")
      .map((reference) => reference.text);
    // Sibling project of the same company, but not other companies.
    expect(siblingTexts).toEqual(["搭建营销活动配置平台，上线周期从两周缩短到两天。"]);
    // Blank metadata fields (营销平台 detail) are not sent; the target entry's
    // metadata is.
    expect(references).toContainEqual({ role: "scope_metadata", label: "公司", text: "阿里巴巴" });
  });

  it("level 1 company group sends every project metadata field and no siblings", () => {
    const snapshot = expectOk(
      build({
        scope: { sectionId: "experience", granularity: "group", groupId: "0" },
      }),
    );
    const references = snapshot.apiRequest.context.references;
    expect(references.filter((reference) => reference.role === "sibling")).toEqual([]);
    expect(references).toEqual([
      { role: "scope_metadata", label: "公司", text: "阿里巴巴" },
      { role: "scope_metadata", label: "项目", text: "订单中台" },
      { role: "scope_metadata", label: "项目详情", text: "核心交易链路重构" },
      { role: "scope_metadata", label: "项目", text: "营销平台" },
    ]);
  });

  it("level 1 section scope sends per-entry metadata and no siblings", () => {
    const snapshot = expectOk(
      build({ scope: { sectionId: "education", granularity: "section" } }),
    );
    const references = snapshot.apiRequest.context.references;
    expect(references.filter((reference) => reference.role === "sibling")).toEqual([]);
    expect(references).toEqual([
      { role: "scope_metadata", label: "机构", text: "清华大学" },
      { role: "scope_metadata", label: "名称", text: "计算机科学与技术 硕士" },
      { role: "scope_metadata", label: "详情", text: "分布式系统方向" },
      { role: "scope_metadata", label: "机构", text: "北京大学" },
      { role: "scope_metadata", label: "名称", text: "软件工程 本科" },
    ]);
  });

  it("level 1 skills item sends the item label as metadata and bodies as siblings", () => {
    const snapshot = expectOk(
      build({ scope: { sectionId: "skills", granularity: "item", itemId: "0" } }),
    );
    // Siblings are context, not targets: any non-blank body is sent, even a
    // short one (the <10 filter applies to targets only).
    expect(snapshot.apiRequest.context.references).toEqual([
      { role: "scope_metadata", label: "类别", text: "编程语言" },
      { role: "sibling", text: "React、Next.js、NestJS，有大型项目实战经验。" },
      { role: "sibling", text: "短" },
    ]);
  });

  it("level 2 adds profile and skill references", () => {
    const snapshot = expectOk(
      build({
        level: 2,
        scope: { sectionId: "experience", granularity: "item", itemId: "0.0.0" },
      }),
    );
    const references = snapshot.apiRequest.context.references;
    const roles = new Set(references.map((reference) => reference.role));
    expect(roles).toEqual(new Set(["scope_metadata", "sibling", "profile", "skill"]));
    expect(references).toContainEqual({
      role: "profile",
      label: "个人简介",
      text: "五年后端开发经验，专注高并发分布式系统。",
    });
    expect(references).toContainEqual({ role: "skill", label: "技能", text: "编程语言" });
  });

  it("level 2 never repeats target texts via profile references", () => {
    const snapshot = expectOk(
      build({
        level: 2,
        scope: { sectionId: "profile", granularity: "item", itemId: "0" },
      }),
    );
    const targetText = snapshot.targets[0].text;
    expect(
      snapshot.apiRequest.context.references.some((reference) => reference.text === targetText),
    ).toBe(false);
  });

  it("localizes reference labels via the language input", () => {
    const snapshot = expectOk(
      build({
        language: "en",
        scope: { sectionId: "experience", granularity: "item", itemId: "0.0.0" },
      }),
    );
    expect(snapshot.apiRequest.language).toBe("en");
    expect(snapshot.apiRequest.context.references[0]).toEqual({
      role: "scope_metadata",
      label: "Company",
      text: "阿里巴巴",
    });
  });

  it("never sends header PII at any level", () => {
    for (const level of [0, 1, 2] as PolishContextLevel[]) {
      const snapshot = expectOk(
        build({
          level,
          scope: { sectionId: "experience", granularity: "section" },
        }),
      );
      const sent = JSON.stringify(snapshot.apiRequest);
      expect(sent).not.toContain("zhangsan@example.com");
      expect(sent).not.toContain("13800000000");
    }
  });
});

// ---------------------------------------------------------------------------
// Disclosure consistency
// ---------------------------------------------------------------------------

describe("disclosure", () => {
  it("mirrors the exact text sets of apiRequest (filtered content)", () => {
    const snapshot = expectOk(
      build({
        level: 2,
        stylePreset: "concise",
        styleInstruction: "突出量化成果",
        scope: { sectionId: "experience", granularity: "section" },
      }),
    );
    const { disclosure, apiRequest } = snapshot;

    expect(new Set(disclosure.targets.map((target) => target.text))).toEqual(
      new Set(apiRequest.items.map((item) => item.text)),
    );
    expect(new Set(disclosure.references.map((reference) => reference.text))).toEqual(
      new Set(apiRequest.context.references.map((reference) => reference.text)),
    );
    expect(disclosure.targets.map((target) => target.id)).toEqual(
      apiRequest.items.map((item) => item.id),
    );
    expect(disclosure.stylePreset).toBe(apiRequest.stylePreset);
    expect(disclosure.styleInstruction).toBe(apiRequest.styleInstruction);
    expect(disclosure.totalTargetChars).toBe(
      apiRequest.items.reduce((sum, item) => sum + item.text.length, 0),
    );
    expect(disclosure.totalReferenceChars).toBe(
      apiRequest.context.references.reduce(
        (sum, reference) => sum + reference.text.length + (reference.label?.length ?? 0),
        0,
      ),
    );
  });

  it("omits a blank style instruction from both apiRequest and disclosure", () => {
    const snapshot = expectOk(
      build({
        styleInstruction: "   ",
        scope: { sectionId: "profile", granularity: "entry" },
      }),
    );
    expect(snapshot.apiRequest.styleInstruction).toBeUndefined();
    expect(snapshot.disclosure.styleInstruction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Contract round-trip
// ---------------------------------------------------------------------------

describe("apiRequest contract round-trip", () => {
  const LEVELS: PolishContextLevel[] = [0, 1, 2];

  it.each(
    MATRIX_CASES.flatMap(({ name, scope }) =>
      LEVELS.map((level) => ({ name: `${name} @ level ${level}`, scope, level })),
    ),
  )("$name validates against polishRequestSchema", ({ scope, level }) => {
    const snapshot = expectOk(build({ scope, level }));
    const parsed = polishRequestSchema.safeParse(snapshot.apiRequest);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(snapshot.apiRequest);
    }
  });

  it("passes through clientRequestId and documentId", () => {
    const snapshot = expectOk(
      build({ scope: { sectionId: "profile", granularity: "entry" } }),
    );
    expect(snapshot.apiRequest.clientRequestId).toBe(CLIENT_REQUEST_ID);
    expect(snapshot.documentId).toBe("doc-1");
  });
});

// ---------------------------------------------------------------------------
// Hard caps
// ---------------------------------------------------------------------------

describe("hard caps", () => {
  it("fails when targets exceed MAX_ITEMS", () => {
    const cv = makeCvData();
    cv.profile = Array.from({ length: MAX_ITEMS + 1 }, (_, index) =>
      bullet(`第 ${index} 段足够长的 profile 文本。`),
    );
    expect(build({ cv, scope: { sectionId: "profile", granularity: "entry" } })).toEqual({
      ok: false,
      code: "too_many_targets",
    });
  });

  it("fails when a single target exceeds MAX_ITEM_CHARS", () => {
    const cv = makeCvData();
    cv.profile = [bullet("长".repeat(MAX_ITEM_CHARS + 1))];
    expect(
      build({ cv, scope: { sectionId: "profile", granularity: "item", itemId: "0" } }),
    ).toEqual({ ok: false, code: "targets_too_large" });
  });

  it("fails when total target chars exceed the budget", () => {
    const cv = makeCvData();
    cv.profile = Array.from({ length: 3 }, () => bullet("字".repeat(1900)));
    expect(build({ cv, scope: { sectionId: "profile", granularity: "entry" } })).toEqual({
      ok: false,
      code: "targets_too_large",
    });
  });

  it("fails when references exceed the count cap", () => {
    const cv = makeCvData();
    cv.skills = Array.from({ length: 61 }, (_, index) => ({
      label: `技能${index}`,
      body: "足够长的一段技能描述文本。",
    }));
    const result = build({
      cv,
      level: 2,
      scope: { sectionId: "skills", granularity: "item", itemId: "0" },
    });
    expect(result).toEqual({ ok: false, code: "references_too_large" });
  });

  it("fails when total reference chars exceed the budget", () => {
    const cv = makeCvData();
    // Distinct texts: identical ones would be deduplicated into one reference.
    cv.profile = Array.from({ length: 6 }, (_, index) =>
      bullet(`第${index}段` + "参".repeat(MAX_REFERENCE_ITEM_CHARS - 110)),
    );
    const result = build({
      cv,
      level: 2,
      scope: { sectionId: "experience", granularity: "item", itemId: "0.0.0" },
    });
    expect(result).toEqual({ ok: false, code: "references_too_large" });
  });

  it("counts reference labels toward the aggregate budget (contract alignment)", () => {
    const cv = makeCvData();
    cv.skills = [];
    // Sized so the text-only sum stays under MAX_REFERENCE_CHARS while the
    // text+label sum (the contract's accounting) trips it: the pre-check must
    // fail as references_too_large, not fall through to invalid_request.
    cv.profile = Array.from({ length: 5 }, (_, index) =>
      bullet(`第${index}段` + "参".repeat(1990 - 5)),
    );
    const result = build({
      cv,
      level: 2,
      scope: { sectionId: "experience", granularity: "item", itemId: "0.0.0" },
    });
    expect(result).toEqual({ ok: false, code: "references_too_large" });

    // Guard the sizing premise: text-only accounting would have passed.
    const cv2 = makeCvData();
    cv2.skills = [];
    cv2.profile = Array.from({ length: 5 }, (_, index) =>
      bullet(`第${index}段` + "参".repeat(1990 - 5)),
    );
    const probe = buildPolishSnapshot({
      documentId: "doc-1",
      cv: cv2,
      language: "zh",
      level: 2,
      scope: { sectionId: "experience", granularity: "item", itemId: "0.0.0" },
      clientRequestId: CLIENT_REQUEST_ID,
    });
    if (probe.ok) throw new Error("premise broken: expected the label-inclusive budget to trip");
    const textOnly = 5 * 1990 + "阿里巴巴".length + "订单中台".length + "核心交易链路重构".length;
    expect(textOnly).toBeLessThanOrEqual(MAX_REFERENCE_CHARS);
  });

  it("drops an oversized reference instead of truncating it", () => {
    const cv = makeCvData();
    cv.education[0].bullets[1] = bullet("长".repeat(MAX_REFERENCE_ITEM_CHARS + 1));
    const snapshot = expectOk(
      build({ cv, scope: { sectionId: "education", granularity: "item", itemId: "0.0" } }),
    );
    expect(snapshot.apiRequest.context.references.some((reference) => reference.role === "sibling")).toBe(false);
  });

  it("fails on an over-long style instruction", () => {
    const result = build({
      styleInstruction: "长".repeat(MAX_STYLE_INSTRUCTION_CHARS + 1),
      scope: { sectionId: "profile", granularity: "entry" },
    });
    expect(result).toEqual({ ok: false, code: "style_instruction_too_long" });
  });
});

// ---------------------------------------------------------------------------
// Stale-guard inputs
// ---------------------------------------------------------------------------

describe("referencePaths", () => {
  it("lists the unique source paths of every sent reference", () => {
    const snapshot = expectOk(
      build({
        scope: { sectionId: "experience", granularity: "item", itemId: "0.0.0" },
      }),
    );
    expect(snapshot.referencePaths).toEqual([
      "experience.0.org",
      "experience.0.projects.0.title",
      "experience.0.projects.0.detail",
      "experience.0.projects.0.bullets.1.body",
    ]);
  });

  it("contains no target paths", () => {
    const snapshot = expectOk(
      build({
        level: 2,
        scope: { sectionId: "education", granularity: "section" },
      }),
    );
    const targetPaths = new Set(snapshot.targets.map((target) => target.path));
    for (const path of snapshot.referencePaths) {
      expect(targetPaths.has(path)).toBe(false);
    }
  });
});
