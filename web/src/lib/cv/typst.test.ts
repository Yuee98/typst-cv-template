import { describe, expect, it } from "vitest";

import { cloneCvData } from "@/lib/cv/cv-utils";
import { sampleCvDataEn } from "@/lib/cv/sample-data";
import { buildTypstDocument } from "@/lib/cv/typst";
import type { CvData } from "@/lib/cv/schema";

function makeData(): CvData {
  return cloneCvData(sampleCvDataEn);
}

describe("buildTypstDocument", () => {
  it("escapes fields emitted through Typst string-literal helpers", () => {
    const data = makeData();
    data.header.name = 'Ada "Grace"\nLovelace\\';
    data.header.subtitle = "Compiler & language tooling";
    data.profile = [{ body: 'Line "one"\nLine two\\' }];
    data.sectionTitles.profile.title = 'About "me"';

    const source = buildTypstDocument(data, { styleImportPath: 'style "quoted".typ' });

    expect(source).toContain(`#import ${JSON.stringify('style "quoted".typ')}: *`);
    expect(source).toContain(`  ${JSON.stringify(data.header.name)},`);
    expect(source).toContain(`#plain-item(${JSON.stringify(data.profile[0]!.body)})`);
    expect(source).toContain(`#resume-section(${JSON.stringify(data.sectionTitles.profile.title)})`);
  });

  it("normalizes section order, omits empty sections, and emits page-break controls", () => {
    const data = makeData();
    data.sectionOrder = ["profile", "publications", "profile"];
    data.profile = [{ body: "Profile body" }];
    data.skills = [];
    data.experience = [];
    data.education = [];
    data.research = [];
    data.publications = [
      {
        authors: "Ada Lovelace, Bob Stone",
        title: "A Study",
        venue: "Journal",
        year: "1843",
        url: "",
      },
    ];
    data.additional = [];
    data.sectionTitles.publications.pageBreakBefore = true;
    data.header.selfName = "Ada";

    const source = buildTypstDocument(data);
    const profileIndex = source.indexOf('#resume-section("Profile")');
    const publicationsIndex = source.indexOf('#resume-section("Publications")');

    expect(profileIndex).toBeGreaterThan(-1);
    expect(publicationsIndex).toBeGreaterThan(profileIndex);
    expect(source).not.toContain('#resume-section("Skills")');
    expect(source).toContain('#pagebreak()\n#resume-section("Publications")');
    expect(source).toContain("#underline[Ada Lovelace]");
    expect(source).toContain("  [A Study],");
  });

  it("preserves keep-together entries and optional empty dates", () => {
    const data = makeData();
    data.sectionOrder = ["experience", "education"];
    data.profile = [];
    data.skills = [];
    data.experience = [
      {
        org: "Company",
        date: "2020",
        projects: [
          {
            title: "Project",
            detail: "Detail",
            date: "",
            bullets: [{ body: "Work" }],
          },
        ],
      },
    ];
    data.research = [];
    data.publications = [];
    data.additional = [];
    data.education = [
      {
        org: "University",
        title: "Degree",
        detail: "Field",
        date: "",
        bullets: [{ body: "Thesis" }],
      },
    ];

    const source = buildTypstDocument(data);

    expect(source).toContain("date: none,");
    expect(source).toContain("keep: true,");
  });

  it("keeps section structure and publication highlighting independent of locale", () => {
    const zh = makeData();
    const en = makeData();
    zh.typstLang = "zh";
    en.typstLang = "en";
    zh.header.selfName = "Lin";
    en.header.selfName = "Lin";

    const zhSource = buildTypstDocument(zh);
    const enSource = buildTypstDocument(en);
    const zhSections = zhSource.slice(zhSource.indexOf("#resume-section"));
    const enSections = enSource.slice(enSource.indexOf("#resume-section"));

    expect(enSections).toBe(zhSections);
    expect(enSections).toContain("#underline[Lin Zhou]");
  });
});
