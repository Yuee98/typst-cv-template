import { describe, expect, it } from "vitest";

import { getSiteMetadata } from "@/i18n/site-metadata";

describe("getSiteMetadata", () => {
  it("uses neutral copy while AI polish is unavailable", () => {
    expect(getSiteMetadata("zh", "false")).toEqual({
      title: "在线简历生成器 | Typst CV Maker",
      description: "创建、预览、导出并可选同步简历文档。",
    });
  });

  it("uses AI-aware localized copy only for the exact enabled flag", () => {
    expect(getSiteMetadata("zh", "true")).toEqual({
      title: "AI 简历生成器 | Typst CV Maker",
      description:
        "使用结构化编辑与 Typst 实时预览创建专业简历，并通过 AI 润色优化表达；支持 PDF 导出与可选云端同步。",
    });
    expect(getSiteMetadata("en", "true")).toEqual({
      title: "AI CV Builder | Typst CV Maker",
      description:
        "Build professional CVs with structured editing, live Typst preview, AI-powered polishing, PDF export, and optional cloud sync.",
    });
  });
});
