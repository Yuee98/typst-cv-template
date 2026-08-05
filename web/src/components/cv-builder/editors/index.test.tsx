// @vitest-environment jsdom
/**
 * Flag-off layout neutrality (relay #6): with NEXT_PUBLIC_AI_POLISH_ENABLED
 * unset, section headers must keep their original three-column structure and
 * contain NO empty action slot — the feature is absent, not merely hidden.
 * The wiring achieves this by omitting the SectionHeader `actions` prop
 * entirely when the flag is off (never a truthy element that renders null).
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { FormProvider, useForm, type UseFormReturn } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SECTION_ORDER, ORDERED_SECTION_IDS, type CvData } from "@/lib/cv/schema";

import messages from "../../../../messages/en.json";
import { PolishEntryProvider } from "../polish/polish-entry-context";
import type { PolishScope } from "../polish/scope-builder";
import { CvEditor } from "./index";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

function makeCvData(): CvData {
  const bullet = (body: string) => ({ body });
  return {
    schemaVersion: 7,
    typstLang: "zh",
    sectionOrder: [...DEFAULT_SECTION_ORDER],
    header: { name: "张三", subtitle: "", email: "", phone: "", selfName: "" },
    sectionTitles: Object.fromEntries(
      ORDERED_SECTION_IDS.map((id) => [
        id,
        { title: `${id} title`, isDisplay: true, pageBreakBefore: false },
      ]),
    ) as CvData["sectionTitles"],
    profile: [bullet("五年后端开发经验，专注高并发分布式系统。")],
    skills: [{ label: "编程语言", body: "TypeScript、Go、Rust，熟悉函数式编程范式。" }],
    experience: [
      {
        org: "Example Corp",
        date: "2020-2024",
        projects: [
          {
            title: "Platform",
            detail: "Core services",
            date: "2020-2024",
            bullets: [bullet("Built and operated the core platform services at scale.")],
          },
        ],
      },
    ],
    education: [],
    research: [],
    publications: [],
    additional: [],
  };
}

function Wrapper({
  form,
  withPolishEntry,
  requestPolish,
}: {
  form: UseFormReturn<CvData>;
  withPolishEntry: boolean;
  requestPolish: (scope: PolishScope) => void;
}) {
  const content = <CvEditor />;
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <FormProvider {...form}>
        {withPolishEntry ? (
          <PolishEntryProvider value={{ requestPolish }}>{content}</PolishEntryProvider>
        ) : (
          content
        )}
      </FormProvider>
    </NextIntlClientProvider>
  );
}

function Harness({
  withPolishEntry,
  requestPolish = vi.fn(),
}: {
  withPolishEntry: boolean;
  requestPolish?: (scope: PolishScope) => void;
}) {
  const form = useForm<CvData>({ defaultValues: makeCvData() });
  return <Wrapper form={form} withPolishEntry={withPolishEntry} requestPolish={requestPolish} />;
}

/** Activate the profile section tab and return its section-header grid. */
function openProfileSectionHeader(container: HTMLElement): HTMLElement {
  // SortableSectionTab overrides the accessible name with the drag hint.
  const tab = screen.getByRole("tab", {
    name: messages.Editors.aria.dragSection.replace("{label}", messages.Editors.tabs.profile),
  });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
  const grid = container.querySelector("div.grid.gap-3");
  if (!(grid instanceof HTMLElement)) throw new Error("section header grid not found");
  return grid;
}

function openExperienceSection(): void {
  const tab = screen.getByRole("tab", {
    name: messages.Editors.aria.dragSection.replace(
      "{label}",
      messages.Editors.tabs.experience,
    ),
  });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
}

const THREE_COL = "sm:grid-cols-[minmax(0,1fr)_auto_auto]";
const FOUR_COL = "sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]";

describe("CvEditor section headers and the AI entry flag", () => {
  it("flag off: original column structure, no action slot, no entry button", () => {
    vi.stubEnv("NEXT_PUBLIC_AI_POLISH_ENABLED", "");
    const { container } = render(<Harness withPolishEntry={true} />);
    const grid = openProfileSectionHeader(container);

    expect(grid.className).toContain(THREE_COL);
    expect(grid.className).not.toContain(FOUR_COL);
    // Title field + the two checkboxes only — no (empty) action container.
    expect(grid.children).toHaveLength(3);
    expect(screen.queryByRole("button", { name: messages.PolishEntry.entry })).toBeNull();
  });

  it("flag on: action slot renders the entry button (contrast baseline)", () => {
    vi.stubEnv("NEXT_PUBLIC_AI_POLISH_ENABLED", "true");
    const { container } = render(<Harness withPolishEntry={true} />);
    const grid = openProfileSectionHeader(container);

    expect(grid.className).toContain(FOUR_COL);
    expect(screen.getByRole("button", { name: messages.PolishEntry.entry })).not.toBeNull();
  });

  it("flag on: company action dispatches the explicit group scope", () => {
    vi.stubEnv("NEXT_PUBLIC_AI_POLISH_ENABLED", "true");
    const requestPolish = vi.fn();
    render(<Harness withPolishEntry={true} requestPolish={requestPolish} />);
    openExperienceSection();

    fireEvent.click(screen.getByRole("button", { name: messages.PolishEntry.group }));
    expect(requestPolish).toHaveBeenCalledWith({
      sectionId: "experience",
      granularity: "group",
      groupId: "0",
    });
  });
});
