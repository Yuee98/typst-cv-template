import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.describe("local server-mode CV workflow", () => {
  test("edits, recovers, reorders, switches locale, and exports without AI calls", async ({ page }) => {
    const polishRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/polish")) {
        polishRequests.push(request.url());
      }
    });

    await page.goto("/en");
    await expect(page.getByRole("heading", { name: "CV Library" })).toBeVisible();
    await expect(page.locator("[data-cv-card-select]").first()).toBeVisible();

    const nameInput = page.locator('input[name="header.name"]');
    await page.getByRole("tab", { name: "Header", exact: true }).click();
    await expect(nameInput).toBeVisible();
    await nameInput.fill("E2E Candidate");
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();
    await expect.poll(
      () =>
        page.evaluate(() => {
          const activeId = window.localStorage.getItem("typst-cv-builder:documents:active");
          if (!activeId) return null;
          const raw = window.localStorage.getItem(`typst-cv-builder:documents:${activeId}`);
          if (!raw) return null;
          try {
            return JSON.parse(raw)?.data?.header?.name ?? null;
          } catch {
            return null;
          }
        }),
      { timeout: 60_000 },
    ).toBe("E2E Candidate");

    // Local storage is the recovery boundary: a full page reload must restore
    // the edited form without a cloud session or API dependency.
    await page.reload();
    await expect(nameInput).toHaveValue("E2E Candidate");
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();

    // DnD-Kit's KeyboardSensor uses Space to start/end and ArrowRight to move
    // horizontally. Select Profile before focusing its drag activator so the
    // keyboard drag itself is the only interaction under test; a regression in
    // the sortable tab wiring would make the drag change the selected editor tab.
    const profileTab = page.getByRole("tab", { name: "Profile. Drag to reorder section." });
    await profileTab.click();
    await expect(profileTab).toHaveAttribute("data-state", "active");
    const profileIndexBefore = await profileTab.evaluate((element) =>
      Array.prototype.indexOf.call(element.parentElement?.children ?? [], element),
    );
    await profileTab.focus();
    await profileTab.press("Space");
    await profileTab.press("ArrowRight");
    await profileTab.press("Space");
    await expect.poll(() =>
      profileTab.evaluate((element) =>
        Array.prototype.indexOf.call(element.parentElement?.children ?? [], element),
      ),
    ).toBe(profileIndexBefore + 1);
    await expect(profileTab).toHaveAttribute("data-state", "active");
    await expect.poll(
      () =>
        page.evaluate(() => {
          const activeId = window.localStorage.getItem("typst-cv-builder:documents:active");
          if (!activeId) return null;
          const raw = window.localStorage.getItem(`typst-cv-builder:documents:${activeId}`);
          if (!raw) return null;
          try {
            return JSON.parse(raw)?.data?.sectionOrder?.slice(0, 2) ?? null;
          } catch {
            return null;
          }
        }),
      { timeout: 60_000 },
    ).toEqual(["skills", "profile"]);

    // The locale route may remount the page, but the same local document must
    // remain active and retain its edited content.
    await page.getByRole("button", { name: "Interface language" }).click();
    await page.getByRole("menuitem", { name: "中文", exact: true }).click();
    await expect(page).toHaveURL(/\/zh$/);
    await expect(page.locator('input[name="header.name"]')).toHaveValue("E2E Candidate");

    await page.getByRole("button", { name: "界面语言" }).click();
    await page.getByRole("menuitem", { name: "English", exact: true }).click();
    await expect(page).toHaveURL(/\/en$/);
    await expect(page.locator('input[name="header.name"]')).toHaveValue("E2E Candidate");

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("menuitem", { name: "Data JSON", exact: true }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    const exported = JSON.parse(await readFile(downloadPath!, "utf8")) as {
      schemaVersion?: number;
      sectionOrder?: string[];
      header?: { name?: string };
    };
    expect(exported.schemaVersion).toBe(7);
    expect(exported.sectionOrder?.slice(0, 2)).toEqual(["skills", "profile"]);
    expect(exported.header?.name).toBe("E2E Candidate");

    expect(polishRequests).toEqual([]);
  });
});
