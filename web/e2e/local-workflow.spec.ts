import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.describe("local server-mode CV workflow", () => {
  test("leaves no Admin referrer or query in a public pageview", async ({ page }) => {
    const sensitive = "private-admin@example.test";
    let publicDocumentReferer: string | undefined;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.resourceType() === "document" && url.pathname === "/en") {
        publicDocumentReferer = request.headers().referer ?? "";
      }
    });

    const adminResponse = await page.goto(
      `/en/admin/users?search=${encodeURIComponent(sensitive)}&after=private-cursor#private-fragment`,
    );
    expect(adminResponse?.headers()["referrer-policy"]).toBe("no-referrer");
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute(
      "content",
      "no-referrer",
    );
    await page.getByRole("link", { name: "Back to editor" }).click();
    await expect(page).toHaveURL(/\/en$/);
    await expect(page.getByRole("heading", { name: "CV Library" })).toBeVisible();

    expect(publicDocumentReferer).toBe("");
    expect(await page.evaluate(() => document.referrer)).toBe("");
    const analyticsQueue = await page.evaluate(() =>
      JSON.stringify(
        (window as Window & { vaq?: unknown[] }).vaq ?? [],
        (_key, value) => (typeof value === "function" ? "[function]" : value),
      ),
    );
    expect(analyticsQueue).toContain("pageview");
    expect(analyticsQueue).not.toContain("/admin");
    expect(analyticsQueue).not.toContain(sensitive);
    expect(analyticsQueue).not.toContain("private-cursor");
  });

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

    await expect(page.getByText("Ready", { exact: true })).toBeVisible();
    const previewPage = page.locator(".preview-pane .typst-page-shell").first();
    await expect(previewPage).toBeVisible();
    const initialPreviewMarkup = await previewPage.innerHTML();

    const nameInput = page.locator('input[name="header.name"]');
    await page.getByRole("tab", { name: "Header", exact: true }).click();
    await expect(nameInput).toBeVisible();
    await nameInput.fill("E2E Candidate");
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
    await expect.poll(() => previewPage.innerHTML(), { timeout: 60_000 }).not.toBe(initialPreviewMarkup);
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();

    // Local storage is the recovery boundary: a full page reload must restore
    // the edited form without a cloud session or API dependency.
    await page.reload();
    await expect(nameInput).toHaveValue("E2E Candidate");
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();

    const readStoredSectionOrder = () =>
      page.evaluate(() => {
        const activeId = window.localStorage.getItem("typst-cv-builder:documents:active");
        if (!activeId) return null;
        const raw = window.localStorage.getItem(`typst-cv-builder:documents:${activeId}`);
        if (!raw) return null;
        try {
          const storedDocument = JSON.parse(raw) as { data?: { sectionOrder?: string[] } };
          return storedDocument.data?.sectionOrder ?? null;
        } catch {
          return null;
        }
      });
    await expect.poll(readStoredSectionOrder, { timeout: 60_000 }).not.toBeNull();
    const initialSectionOrder = await readStoredSectionOrder();
    if (!initialSectionOrder) {
      throw new Error("The local document section order did not initialize.");
    }

    // With no drag active, Radix tab navigation should move focus/selection
    // without changing the persisted section order.
    const profileTab = page.getByRole("tab", { name: "Profile. Drag to reorder section." });
    const skillsTab = page.getByRole("tab", { name: "Skills. Drag to reorder section." });
    const sortableTabOrder = page.locator('button[role="tab"][aria-label]');
    const sortableTabLabelsBeforeNavigation = await sortableTabOrder.evaluateAll((tabs) =>
      tabs.map((tab) => tab.getAttribute("aria-label")),
    );
    expect(sortableTabLabelsBeforeNavigation.length).toBeGreaterThan(1);
    await page.getByRole("tab", { name: "Header", exact: true }).click();
    await profileTab.focus();
    await expect(profileTab).toBeFocused();
    await profileTab.press("ArrowRight");
    await expect(skillsTab).toHaveAttribute("data-state", "active");
    expect(await sortableTabOrder.evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("aria-label")))).toEqual(
      sortableTabLabelsBeforeNavigation,
    );
    await expect.poll(readStoredSectionOrder, { timeout: 60_000 }).toEqual(initialSectionOrder);

    // DnD-Kit's KeyboardSensor uses Space to start/end and ArrowRight to move
    // horizontally. Select Profile before focusing its drag activator so the
    // keyboard drag itself is the only interaction under test; a regression in
    // the sortable tab wiring would make the drag change the selected editor tab.
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

    const packageDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("menuitem", { name: "Typst package", exact: true }).click();
    const packageDownload = await packageDownloadPromise;
    const packagePath = await packageDownload.path();
    expect(packagePath).not.toBeNull();
    const packageBytes = await readFile(packagePath!);
    expect(packageBytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(packageBytes.includes(Buffer.from("resume.typ"))).toBe(true);
    expect(packageBytes.includes(Buffer.from("style.typ"))).toBe(true);
    expect(packageBytes.includes(Buffer.from("data.json"))).toBe(true);

    const pdfDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("menuitem", { name: "PDF", exact: true }).click();
    const pdfDownload = await pdfDownloadPromise;
    const pdfPath = await pdfDownload.path();
    expect(pdfPath).not.toBeNull();
    const pdfBytes = await readFile(pdfPath!);
    expect(pdfBytes.byteLength).toBeGreaterThan(1_000);
    const pdfText = pdfBytes.toString("latin1");
    expect(pdfText.startsWith("%PDF-")).toBe(true);
    expect(pdfText).toContain("startxref");
    expect(pdfBytes.subarray(-2_048).toString("latin1")).toContain("%%EOF");

    expect(polishRequests).toEqual([]);
  });
});
