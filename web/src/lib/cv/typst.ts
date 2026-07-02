import type { Company, CvData, Project, ResumeEntry } from "./schema";

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

function renderSection(title: string, body: string[]) {
  const nonEmptyBody = body.filter(Boolean);
  if (nonEmptyBody.length === 0) {
    return "";
  }

  return [`#resume-section(${typstString(title)})`, ...nonEmptyBody].join("\n");
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

function renderContent(data: CvData) {
  const sections = [
    [
      "#resume-header(",
      `  ${typstString(data.header.name)},`,
      `  ${typstString(data.header.subtitle)},`,
      `  ${typstString(data.header.email)},`,
      `  ${typstString(data.header.phone)},`,
      ")",
    ].join("\n"),
    renderSection(
      data.sectionTitles.profile,
      data.profile.map((item) => `#plain-item(${typstString(item.body)})`),
    ),
    renderSection(
      data.sectionTitles.skills,
      data.skills.map(
        (item) => `#skill-item(${typstString(item.label)}, ${typstString(item.body)})`,
      ),
    ),
    renderSection(data.sectionTitles.experience, data.experience.map(renderCompany)),
    renderSection(data.sectionTitles.education, data.education.map(renderResumeEntry)),
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
    renderSection(
      data.sectionTitles.publications,
      data.publications.map(
        (item) => `#publication(${typstString(item.label)}, ${typstString(item.body)})`,
      ),
    ),
    renderSection(
      data.sectionTitles.additional,
      data.additional.map(
        (item) => `#skill-item(${typstString(item.label)}, ${typstString(item.body)})`,
      ),
    ),
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

export function buildTypstDocument(data: CvData) {
  return ['#import "/style.typ": *', renderShowRule(data), renderContent(data)].join("\n\n");
}
