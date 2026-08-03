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
    experience: [],
    education: [],
    research: [],
    publications: [],
    additional: [],
  };
}

function Wrapper({
  form,
  withPolishEntry,
}: {
  form: UseFormReturn<CvData>;
  withPolishEntry: boolean;
}) {
  const content = <CvEditor />;
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <FormProvider {...form}>
        {withPolishEntry ? (
          <PolishEntryProvider value={{ requestPolish: vi.fn() }}>{content}</PolishEntryProvider>
        ) : (
          content
        )}
      </FormProvider>
    </NextIntlClientProvider>
  );
}

function Harness({ withPolishEntry }: { withPolishEntry: boolean }) {
  const form = useForm<CvData>({ defaultValues: makeCvData() });
  return <Wrapper form={form} withPolishEntry={withPolishEntry} />;
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
});
