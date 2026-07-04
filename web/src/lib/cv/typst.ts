import {
  normalizeSectionOrder,
  type Company,
  type CvData,
  type CvSectionId,
  type Project,
  type Publication,
  type ResumeEntry,
} from "./schema";

function typstString(value: string) {
  return JSON.stringify(value);
}

function typstOptional(value: string) {
  const trimmed = value.trim();
  return trimmed ? typstString(trimmed) : "none";
}

function typstTuple(items: string[]) {
  if (items.length === 0) {
    return "()";
  }

  return `(\n${items.map((item) => `    ${item},`).join("\n")}\n  )`;
}

function renderSection(
  section: { title: string; isDisplay: boolean },
  body: string[],
) {
  if (!section.isDisplay) return "";
  const nonEmptyBody = body.filter(Boolean);
  if (nonEmptyBody.length === 0) return "";

  return [`#resume-section(${typstString(section.title)})`, ...nonEmptyBody].join("\n");
}

function renderProject(project: Project) {
  const bullets = typstTuple(project.bullets.map((bullet) => typstString(bullet.body)));
  const date = typstOptional(project.date);

  return [
    "#project-entry(",
    `  ${typstString(project.title)},`,
    `  ${typstString(project.detail)},`,
    `  ${bullets},`,
    `  date: ${date},`,
    ")",
  ].join("\n");
}

function renderCompany(company: Company) {
  const projects = company.projects.map(renderProject).join("\n");

  return [
    "#company-entry(",
    `  ${typstString(company.org)},`,
    `  ${typstString(company.date)},`,
    ")[",
    projects,
    "]",
  ].join("\n");
}

function renderResumeEntry(entry: ResumeEntry) {
  const bullets = typstTuple(entry.bullets.map((bullet) => typstString(bullet.body)));

  return [
    "#resume-entry(",
    `  ${typstString(entry.org)},`,
    `  ${typstString(entry.title)},`,
    `  ${typstString(entry.detail)},`,
    `  ${typstString(entry.date)},`,
    `  ${bullets},`,
    ")",
  ].join("\n");
}

function renderAuthors(authors: string, selfName: string): string {
  if (!selfName.trim()) return typstString(authors);

  const segments = authors.split(",").map((s) => s.trim());
  const normalized = selfName.trim().toLowerCase();
  const parts = segments.map((segment) =>
    segment.toLowerCase().includes(normalized) ? `#underline[${segment}]` : segment,
  );
  return `[${parts.join(", ")}]`;
}

function renderPublication(pub: Publication, selfName: string): string {
  const titleContent = pub.url.trim()
    ? `[#link(${typstString(pub.url.trim())})[${pub.title}]]`
    : `[${pub.title}]`;

  return [
    "#publication(",
    `  ${renderAuthors(pub.authors, selfName)},`,
    `  ${titleContent},`,
    `  ${typstString(pub.venue)},`,
    `  ${typstString(pub.year)},`,
    ")",
  ].join("\n");
}

function renderContent(data: CvData) {
  const header = [
      "#resume-header(",
      `  ${typstString(data.header.name)},`,
      `  ${typstString(data.header.subtitle)},`,
      `  ${typstString(data.header.email)},`,
      `  ${typstString(data.header.phone)},`,
      ")",
    ].join("\n");

  const sectionRenderers: Record<CvSectionId, () => string> = {
    profile: () =>
      renderSection(
        data.sectionTitles.profile,
        data.profile.map((item) => `#plain-item(${typstString(item.body)})`),
      ),
    skills: () =>
      renderSection(
        data.sectionTitles.skills,
        data.skills.map(
          (item) => `#skill-item(${typstString(item.label)}, ${typstString(item.body)})`,
        ),
      ),
    experience: () => renderSection(data.sectionTitles.experience, data.experience.map(renderCompany)),
    education: () => renderSection(data.sectionTitles.education, data.education.map(renderResumeEntry)),
    research: () =>
      renderSection(
        data.sectionTitles.research,
        data.research.map((entry) =>
          [
            "#one-line-entry(",
            `  ${typstString(entry.title)},`,
            `  ${typstString(entry.date)},`,
            `  ${typstTuple(entry.bullets.map((bullet) => typstString(bullet.body)))},`,
            ")",
          ].join("\n"),
        ),
      ),
    publications: () =>
      renderSection(
        data.sectionTitles.publications,
        data.publications.map((item) => renderPublication(item, data.header.selfName)),
      ),
    additional: () =>
      renderSection(
        data.sectionTitles.additional,
        data.additional.map(
          (item) => `#skill-item(${typstString(item.label)}, ${typstString(item.body)})`,
        ),
      ),
  };

  const sections = [
    header,
    ...normalizeSectionOrder(data.sectionOrder).map((sectionId) => sectionRenderers[sectionId]()),
  ];

  return sections.filter(Boolean).join("\n\n");
}

function renderShowRule(data: CvData) {
  const fallbackName = data.typstLang === "zh" ? "简历" : "Resume";
  const name = data.header.name.trim() || fallbackName;
  const title = data.typstLang === "zh" ? `${name} - 简历` : `${name} - Resume`;

  const args = [
    `title: ${typstString(title)}`,
    `author: ${typstString(name)}`,
    `lang: ${typstString(data.typstLang)}`,
  ];

  if (data.bodyFont && data.bodyFont !== "__custom__") {
    const fontList = data.bodyFont
      .split(",")
      .map((f) => typstString(f.trim()))
      .join(", ");
    args.push(`font: (${fontList})`);
  }

  return `#show: resume-style.with(${args.join(", ")})`;
}

export function buildTypstDocument(data: CvData, options: { styleImportPath?: string } = {}) {
  const styleImportPath = options.styleImportPath ?? "/style.typ";
  return [`#import ${typstString(styleImportPath)}: *`, renderShowRule(data), renderContent(data)].join("\n\n");
}
