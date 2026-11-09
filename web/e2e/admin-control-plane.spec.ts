import { expect, test, type Page, type Request } from "@playwright/test";
const users = {
  admin: {
    email: "admin-e2e-admin@example.test",
    password: "AdminE2E!local-2026"
  },
  ordinary: {
    email: "admin-e2e-ordinary@example.test",
    password: "OrdinaryE2E!local-2026"
  }
};
test.beforeEach(({ page }) => {
  page.on("pageerror", error => {
    // React's error number is sufficient to diagnose render failures without
    // persisting component props or authentication state.
    console.info("Browser runtime error", /^Minified React error #\d+/.exec(error.message)?.[0] ?? error.name);
  });
});
async function login(page: Page, user: typeof users.admin) {
  await page.goto("/en/admin");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", {
    name: "Sign in",
    exact: true
  }).click();
  await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible();
}
function isAdminRead(request: Request, section?: string) {
  const url = new URL(request.url());
  return request.method() === "GET" && url.pathname === "/api/admin" &&
    (!section || url.searchParams.get("section") === section);
}
function recordReads(page: Page) {
  const requests: Request[] = [];
  page.on("request", request => {
    if (isAdminRead(request)) requests.push(request);
  });
  return requests;
}
async function openSection(page: Page, section: string) {
  const response = page.waitForResponse(response => isAdminRead(response.request(), section), { timeout: 30_000 });
  await page.locator(`nav a[href="/en/admin/${section}"]`).click();
  expect((await response).ok()).toBe(true);
  await expect(page.locator(`nav a[href="/en/admin/${section}"]`)).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
}
test("ordinary Auth users cannot open Admin data", async ({
  page
}) => {
  await login(page, users.ordinary);
  await expect(page.getByRole("alert").filter({
    hasText: "FORBIDDEN"
  })).toHaveText("FORBIDDEN");
  await expect(page.getByText("LOCAL", {
    exact: false
  })).toHaveCount(0);
});
test("soft navigation caches fresh lists and atomic configuration save refreshes its summary", async ({ page }) => {
  await login(page, users.admin);
  const reads = recordReads(page);
  const cold = page.waitForResponse(response => isAdminRead(response.request(), "configurations"));
  await page.goto("/en/admin/configurations");
  const envelope = await (await cold).json();
  expect(envelope.context.contract_code).toBe("cv_app_db_2");
  await page.waitForLoadState("networkidle");
  expect(reads).toHaveLength(1);
  expect(new URL(reads[0].url()).searchParams.has("database_instance_id")).toBe(false);
  await page.evaluate(() => Object.assign(window, { __adminNavigationSentinel: "same-document" }));
  const documents: string[] = [];
  page.on("request", request => { if (request.resourceType() === "document") documents.push(request.url()); });
  await openSection(page, "rules");
  expect(reads).toHaveLength(2);
  await page.locator('nav a[href="/en/admin/configurations"]').click();
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeEnabled();
  await page.waitForLoadState("networkidle");
  expect(reads).toHaveLength(2);
  expect(await page.evaluate(() => Reflect.get(window, "__adminNavigationSentinel"))).toBe("same-document");
  expect(documents).toEqual([]);
  await page.getByRole("button", { name: "New", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Configuration name", { exact: true })).toBeEnabled();
  const name = `ADMIN_E2E_BROWSER_${Date.now()}`;
  await dialog.getByLabel("Configuration name", { exact: true }).fill(name);
  await dialog.getByLabel("Display name", { exact: true }).fill("Public synthetic AI service");
  await dialog.getByLabel("Endpoint URL", { exact: true }).fill("https://api.deepseek.com/responses");
  await dialog.getByLabel("Model", { exact: true }).fill("deepseek-flash");
  await dialog.getByLabel("Credential reference", { exact: true }).fill("AI_PROVIDER_KEY_ADMIN_E2E");
  const disclosure = dialog.getByRole("combobox", { name: "Data-processing disclosure", exact: true });
  const target = await disclosure.locator("option").filter({ hasText: /DeepSeek/ }).getAttribute("value");
  expect(target).not.toBeNull(); await disclosure.selectOption(target!);
  await dialog.getByLabel("Input", { exact: true }).fill("1.25");
  for (const label of ["Cache read", "Cache write", "Output"]) await dialog.getByLabel(label, { exact: true }).fill("0");
  const committed = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/admin");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect((await committed).ok()).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  const row = page.getByRole("heading", { name, exact: true }).locator("../..");
  await row.getByRole("button", { name: "View", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(name);
  await expect(page.getByRole("dialog")).toContainText("1.25 USD");
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await openSection(page, "rules");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const rule = page.getByRole("dialog");
  await expect(rule.getByLabel("Fallback for other periods")).toBeEnabled();
  await rule.getByLabel("Fallback for other periods").uncheck();
  await rule.getByLabel("Start time", { exact: true }).fill("09:00");
  await rule.getByLabel("End time", { exact: true }).fill("18:00");
  await rule.getByRole("checkbox", { name: new RegExp(name) }).check();
  const ruleSaved = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/admin");
  await rule.getByRole("button", { name: "Save", exact: true }).click();
  expect((await ruleSaved).ok()).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Monday 09:00–18:00 · Asia\/Shanghai/ })).toBeVisible();
  await openSection(page, "controls");
});
for (const code of ["UNAUTHORIZED", "FORBIDDEN"] as const) {
  test(`${code} clears cached records before returning to a list`, async ({ page }) => {
    await login(page, users.admin); await expect(page.getByTitle("Environment: LOCAL", { exact: true })).toBeVisible();
    await openSection(page, "configurations");
    await page.route("**/api/admin?**", async route => { if (isAdminRead(route.request(), "rules")) await route.fulfill({ status: code === "UNAUTHORIZED" ? 401 : 403, json: { error: { code } } }); else await route.continue(); });
    const denied = page.waitForResponse(response => isAdminRead(response.request(), "rules"));
    await page.locator('nav a[href="/en/admin/rules"]').click();
    expect((await denied).status()).toBe(code === "UNAUTHORIZED" ? 401 : 403);
    await expect(page.getByRole("alert").filter({ hasText: code })).toHaveText(code);
    await expect(page.getByTitle("Environment: LOCAL", { exact: true })).toHaveCount(0);
    await page.unroute("**/api/admin?**");
    await openSection(page, "configurations");
    await expect(page.getByRole("button", { name: "New", exact: true })).toBeEnabled();
  });
}
test("signing out isolates cached administrator data from the next account", async ({ page }) => {
  await login(page, users.admin); await expect(page.getByTitle("Environment: LOCAL", { exact: true })).toBeVisible();
  await openSection(page, "configurations");
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.getByLabel("Email").fill(users.ordinary.email); await page.getByLabel("Password").fill(users.ordinary.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "FORBIDDEN" })).toHaveText("FORBIDDEN");
  await expect(page.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
});
test("an instance mismatch performs exactly one unbound bootstrap", async ({ page }) => {
  await login(page, users.admin); await expect(page.getByTitle("Environment: LOCAL", { exact: true })).toBeVisible();
  const staleInstance = "10000000-0000-4000-8000-000000000099";
  let originalInstance: string | undefined;
  await page.route("**/api/admin?**", async route => { if (isAdminRead(route.request(), "configurations") && !originalInstance) { const response = await route.fetch(); const envelope = await response.json(); originalInstance = envelope.context.database_instance_id; envelope.context.database_instance_id = staleInstance; await route.fulfill({ response, json: envelope }); } else await route.continue(); });
  await page.goto("/en/admin/configurations");
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeEnabled();
  const reads = recordReads(page);
  const recovered = page.waitForResponse(response => isAdminRead(response.request(), "rules") && response.ok());
  await page.locator('nav a[href="/en/admin/rules"]').click(); await recovered;
  await page.waitForLoadState("networkidle");
  expect(reads.map(request => new URL(request.url()).searchParams.get("database_instance_id"))).toEqual([staleInstance, null]);
  await openSection(page, "configurations");
  expect(new URL(reads[2].url()).searchParams.get("database_instance_id")).toBe(originalInstance);
});
test("ordinary administrator login can grant and revoke membership through details", async ({ page }) => {
  await login(page, users.admin);
  await openSection(page, "users");
  const row = page.getByRole("heading", { name: users.ordinary.email, exact: true }).locator("../..");
  await row.getByRole("button", { name: "View", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const id = await dialog.locator("dt").filter({ hasText: /^Account UUID$/ }).locator("..").locator("dd").innerText();
  await dialog.getByRole("button", { name: "Grant administrator", exact: true }).click();
  await expect(dialog.getByLabel("Account UUID", { exact: true })).toHaveValue(id);
  const granted = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/admin");
  await dialog.getByRole("button", { name: "Save", exact: true }).click(); expect((await granted).ok()).toBe(true);
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Administrators", exact: true }).click();
  const member = page.getByRole("heading", { name: id, exact: true }).locator("../..");
  await member.getByRole("button", { name: "View", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Active");
  page.once("dialog", confirmation => confirmation.accept());
  const revoked = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/admin");
  await page.getByRole("dialog").getByRole("button", { name: "Revoke administrator", exact: true }).click();
  expect((await revoked).ok()).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await member.getByRole("button", { name: "View", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Revoked");
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await openSection(page, "controls"); await openSection(page, "configurations"); await openSection(page, "controls");
});
test("independent disclosures can be edited, audited and selected for a configuration", async ({ page }) => {
  await login(page, users.admin);
  await openSection(page, "disclosures");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const title = `ADMIN_E2E_DISCLOSURE_${Date.now()}`;
  await dialog.getByLabel("Recipient", { exact: true }).fill("Synthetic independent recipient");
  await dialog.getByLabel("Chinese title", { exact: true }).fill("本地合成接收方数据处理说明");
  await dialog.getByLabel("English title", { exact: true }).fill(title);
  await dialog.getByRole("textbox", { name: "Chinese content", exact: true }).fill("## 数据处理\n\n此处仅为本地合成文案，不发送任何数据。");
  await dialog.getByRole("textbox", { name: "English content", exact: true }).fill("## Data handling\n\nSynthetic local content. No data is transmitted.");
  await dialog.getByLabel("Enabled", { exact: true }).check();
  const created = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/admin");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect((await created).ok()).toBe(true);
  await expect(dialog).toHaveCount(0);
  let row = page.getByRole("heading", { name: title, exact: true }).locator("../..");
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await dialog.getByRole("textbox", { name: "English content", exact: true }).fill("## Data handling\n\nUpdated synthetic local handling statement.");
  const updated = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/admin");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect((await updated).ok()).toBe(true);
  await expect(dialog).toHaveCount(0);
  await row.getByRole("button", { name: "View", exact: true }).click();
  await dialog.getByRole("button", { name: "History", exact: true }).click();
  await expect(dialog.getByText("Updated synthetic local handling statement.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await openSection(page, "configurations");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await dialog.getByLabel("Configuration name", { exact: true }).fill(`ADMIN_E2E_BROWSER_INDEPENDENT_${Date.now()}`);
  await dialog.getByLabel("Display name", { exact: true }).fill("User-facing service name");
  await dialog.getByLabel("Endpoint URL", { exact: true }).fill("https://api.deepseek.com/responses");
  await dialog.getByLabel("Model", { exact: true }).fill("deepseek-flash");
  await dialog.getByLabel("Credential reference", { exact: true }).fill("AI_PROVIDER_KEY_ADMIN_E2E");
  await dialog.getByLabel("Data-processing disclosure", { exact: true }).selectOption({ label: `${title} · Synthetic independent recipient` });
  for (const name of ["Input", "Cache read", "Cache write", "Output"]) await dialog.getByLabel(name, { exact: true }).fill("0");
  const bound = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/admin");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect((await bound).ok()).toBe(true);
  await expect(dialog).toHaveCount(0);
  // Leave the synthetic disclosure disabled so the public-document scenario
  // below continues to describe only the reviewed seed recipients.
  await page.locator('nav a[href="/en/admin/disclosures"]').click();
  await expect(page.locator('nav a[href="/en/admin/disclosures"]')).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "New", exact: true })).toBeEnabled();
  row = page.getByRole("heading", { name: title, exact: true }).locator("../..");
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await dialog.getByLabel("Enabled", { exact: true }).uncheck();
  const disabled = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/admin");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect((await disabled).ok()).toBe(true);
  await expect(dialog).toHaveCount(0);
});
test("current database terms and provider disclosures render in both languages", async ({
  page
}) => {
  for (const locale of ["en", "zh"] as const) {
    await page.goto(`/${locale}/terms`);
    await expect(page.getByRole("heading", {
      name: locale === "en" ? "Terms of Use" : "使用条款",
      exact: true
    })).toBeVisible();
    await page.goto(`/${locale}/ai-terms`);
    await expect(page.getByRole("heading", {
      name: locale === "en" ? "AI Service Terms" : "AI 服务条款",
      exact: true
    })).toBeVisible();
    const providerLinks = page.locator('a[href*="provider_audit="]');
    await expect(providerLinks).toHaveCount(3);
    const targets: { provider: RegExp; href: string }[] = [];
    for (const provider of [/DeepSeek/, /MiMo/, /Google|Gemini/]) {
      const link = providerLinks.filter({ hasText: provider });
      await expect(link).toHaveCount(1);
      const href = await link.getAttribute("href");
      expect(href).not.toBeNull();
      const url = new URL(href!, page.url());
      expect(url.pathname).toBe(`/${locale}/ai-terms`);
      expect([...url.searchParams.keys()].sort()).toEqual(["common", "common_audit", "common_digest", "provider", "provider_audit", "provider_digest"]);
      targets.push({ provider, href: url.href });
    }
    for (const { provider, href } of targets) {
      await page.goto(href);
      await expect(page.getByRole("heading", { name: provider })).toBeVisible();
      // An exact disclosure is the document, rather than the generic selector
      // or all other providers' complete disclosures appended to the page.
      await expect(page.locator('a[href*="provider_audit="]')).toHaveCount(0);
      await expect(page.locator("article p").first()).toBeVisible();
    }
  }
});

test("configuration and disclosure dialogs fit desktop and mobile viewports", async ({ page }) => {
  await login(page, users.admin);
  await expect(page.getByTitle("Environment: LOCAL", { exact: true })).toBeVisible();
  for (const viewport of [{ width: 1536, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/en/admin/configurations");
    await expect(page.getByRole("button", { name: "New", exact: true })).toBeEnabled();
    const dark = viewport.width < 600;
    await page.evaluate(dark => { document.documentElement.classList.toggle("dark", dark); document.documentElement.style.colorScheme = dark ? "dark" : "light"; }, dark);
    if (process.env.ADMIN_VISUAL_PROOF_DIR) {
      const { mkdir } = await import("node:fs/promises"); const { resolve } = await import("node:path");
      await mkdir(resolve(process.env.ADMIN_VISUAL_PROOF_DIR), { recursive: true });
      await page.screenshot({ path: resolve(process.env.ADMIN_VISUAL_PROOF_DIR, `configurations-${viewport.width}-${dark ? "dark" : "light"}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "New", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Configuration name", { exact: true })).toBeEnabled();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
    // Explicit local opt-in only. This dialog contains credential names, never
    // key values or session tokens.
    if (process.env.ADMIN_VISUAL_PROOF_DIR) {
      const { mkdir } = await import("node:fs/promises");
      const { resolve } = await import("node:path");
      const directory = resolve(process.env.ADMIN_VISUAL_PROOF_DIR);
      await mkdir(directory, { recursive: true });
      await dialog.screenshot({ path: resolve(directory, `configuration-${viewport.width}.png`) });
    }
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.goto("/en/admin/controls");
    await expect(page.getByRole("button", { name: "View", exact: true })).toBeEnabled();
    await page.evaluate(dark => { document.documentElement.classList.toggle("dark", dark); document.documentElement.style.colorScheme = dark ? "dark" : "light"; }, dark);
    if (process.env.ADMIN_VISUAL_PROOF_DIR) {
      const { resolve } = await import("node:path");
      await page.screenshot({ path: resolve(process.env.ADMIN_VISUAL_PROOF_DIR, `controls-${viewport.width}-${dark ? "dark" : "light"}.png`), fullPage: true });
    }
    await page.goto("/en/admin/disclosures");
    await expect(page.getByRole("button", { name: "New", exact: true })).toBeEnabled();
    await page.evaluate(dark => { document.documentElement.classList.toggle("dark", dark); document.documentElement.style.colorScheme = dark ? "dark" : "light"; }, dark);
    if (process.env.ADMIN_VISUAL_PROOF_DIR) {
      const { resolve } = await import("node:path");
      await page.screenshot({ path: resolve(process.env.ADMIN_VISUAL_PROOF_DIR, `disclosures-${viewport.width}-${dark ? "dark" : "light"}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "New", exact: true }).click();
    const disclosureDialog = page.getByRole("dialog");
    await expect(disclosureDialog.getByLabel("Recipient", { exact: true })).toBeEnabled();
    const disclosureBox = await disclosureDialog.boundingBox();
    expect(disclosureBox).not.toBeNull();
    expect(disclosureBox!.x).toBeGreaterThanOrEqual(0);
    expect(disclosureBox!.y).toBeGreaterThanOrEqual(0);
    expect(disclosureBox!.x + disclosureBox!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(disclosureBox!.y + disclosureBox!.height).toBeLessThanOrEqual(viewport.height + 1);
    await expect(disclosureDialog.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
    if (process.env.ADMIN_VISUAL_PROOF_DIR) {
      const { resolve } = await import("node:path");
      await disclosureDialog.screenshot({ path: resolve(process.env.ADMIN_VISUAL_PROOF_DIR, `disclosure-${viewport.width}-${dark ? "dark" : "light"}.png`) });
    }
    await disclosureDialog.getByRole("button", { name: "Close", exact: true }).click();
  }
});
