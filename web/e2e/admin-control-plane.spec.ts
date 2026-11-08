import { expect, test, type Page, type Request } from "@playwright/test";
import { createHmac } from "node:crypto";
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
    // persisting component props, authentication state or enrollment content.
    console.info("Browser runtime error", /^Minified React error #\d+/.exec(error.message)?.[0] ?? error.name);
  });
});
function totp(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < key.length; i++) key[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hash = createHmac("sha1", key).update(counter).digest();
  return String((hash.readUInt32BE(hash[hash.length - 1] & 15) & 0x7fffffff) % 1000000).padStart(6, "0");
}
async function login(page: Page, user: typeof users.admin) {
  await page.goto("/en/admin");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", {
    name: "Sign in",
    exact: true
  }).click();
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
test("soft navigation caches fresh pages and a committed profile invalidates its records", async ({
  page
}) => {
  await login(page, users.admin);
  await expect(page.getByText(/Environment: LOCAL/)).toBeVisible();
  await page.waitForLoadState("networkidle");
  const reads = recordReads(page);
  const cold = page.waitForResponse(response => isAdminRead(response.request(), "providers"));
  await page.goto("/en/admin/providers");
  const envelope = await (await cold).json();
  expect(envelope.context.environment).toBe("LOCAL");
  expect(envelope.data.records.length).toBeGreaterThan(0);
  await page.waitForLoadState("networkidle");
  expect(reads.map(request => new URL(request.url()).searchParams.get("section"))).toEqual(["providers"]);
  expect(new URL(reads[0].url()).searchParams.has("database_instance_id")).toBe(false);
  await page.evaluate(() => Object.assign(window, { __adminNavigationSentinel: "same-document" }));
  const documents: string[] = [];
  page.on("request", request => {
    if (request.resourceType() === "document") documents.push(request.url());
  });
  const provider = await page.locator("dd").filter({
    hasText: /^prv_[0-9A-HJKMNP-TV-Z]{12}$/
  }).first().innerText();
  await openSection(page, "profiles");
  expect(reads).toHaveLength(2);
  expect(new URL(reads[1].url()).searchParams.get("database_instance_id")).toBe(envelope.context.database_instance_id);
  await page.locator('nav a[href="/en/admin/providers"]').click();
  await expect(page.locator('nav a[href="/en/admin/providers"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator("dd").filter({ hasText: provider }).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(reads).toHaveLength(2);
  expect(await page.evaluate(() => Reflect.get(window, "__adminNavigationSentinel"))).toBe("same-document");
  expect(documents).toEqual([]);
  await page.locator('nav a[href="/en/admin/profiles"]').click();
  await expect(page.getByLabel("provider id", { exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(reads).toHaveLength(2);
  const profileName = `Local browser draft ${Date.now()}`;
  await page.getByLabel("provider id", {
    exact: true
  }).fill(provider);
  await page.getByLabel("code", {
    exact: true
  }).fill(`ADMIN_E2E_${Date.now()}`);
  await page.getByLabel("name", {
    exact: true
  }).fill(profileName);
  await page.getByLabel("description", {
    exact: true
  }).fill("Real Auth browser test");
  await page.getByLabel("Reason", {
    exact: true
  }).fill("Verify draft from the new baseline");
  const refreshed = page.waitForResponse(response => isAdminRead(response.request(), "profiles"));
  await page.getByRole("button", {
    name: "Submit",
    exact: true
  }).click();
  await expect(page.getByRole("status")).toContainText("Committed: op_");
  expect((await refreshed).ok()).toBe(true);
  expect(reads).toHaveLength(3);
  const identities = page.waitForResponse(response => isAdminRead(response.request(), "profiles"));
  await page.getByLabel("Record kind").selectOption("identities");
  expect((await identities).ok()).toBe(true);
  await expect(page.locator("article").filter({ hasText: profileName })).toBeVisible();
});
for (const code of ["UNAUTHORIZED", "FORBIDDEN"] as const) {
  test(`${code} clears cached administrator records before a page is revisited`, async ({ page }) => {
    await login(page, users.admin);
    await expect(page.getByText(/Environment: LOCAL/)).toBeVisible();
    await openSection(page, "providers");
    await expect(page.locator("article").first()).toBeVisible();
    await page.route("**/api/admin?**", async route => {
      if (isAdminRead(route.request(), "profiles")) {
        await route.fulfill({ status: code === "UNAUTHORIZED" ? 401 : 403, json: { error: { code } } });
      } else await route.continue();
    });
    const failed = page.waitForResponse(response => isAdminRead(response.request(), "profiles"));
    await page.locator('nav a[href="/en/admin/profiles"]').click();
    expect((await failed).status()).toBe(code === "UNAUTHORIZED" ? 401 : 403);
    await expect(page.getByRole("alert").filter({ hasText: code })).toHaveText(code);
    await expect(page.locator("article")).toHaveCount(0);
    await expect(page.getByText(/Environment: LOCAL/)).toHaveCount(0);
    await page.unroute("**/api/admin?**");
    // A fresh read, rather than reuse of the earlier cached provider page, is required.
    await openSection(page, "providers");
    await expect(page.locator("article").first()).toBeVisible();
  });
}
test("signing out clears cached administrator data before another account signs in", async ({ page }) => {
  await login(page, users.admin);
  await expect(page.getByText(/Environment: LOCAL/)).toBeVisible();
  await openSection(page, "providers");
  await expect(page.locator("article").first()).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.locator("article")).toHaveCount(0);
  await page.getByLabel("Email").fill(users.ordinary.email);
  await page.getByLabel("Password").fill(users.ordinary.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "FORBIDDEN" })).toHaveText("FORBIDDEN");
  await expect(page.locator("article")).toHaveCount(0);
  await expect(page.getByText(/Environment: LOCAL/)).toHaveCount(0);
});
test("a stale instance clears the prior cache and bootstraps the new instance once", async ({ page }) => {
  await login(page, users.admin);
  await expect(page.getByText(/Environment: LOCAL/)).toBeVisible();
  const staleInstance = "10000000-0000-4000-8000-000000000099";
  let originalInstance: string | undefined;
  await page.route("**/api/admin?**", async route => {
    if (isAdminRead(route.request(), "providers") && !originalInstance) {
      const response = await route.fetch();
      const envelope = await response.json();
      originalInstance = envelope.context.database_instance_id;
      envelope.context.database_instance_id = staleInstance;
      await route.fulfill({ response, json: envelope });
    } else await route.continue();
  });
  await page.goto("/en/admin/providers");
  await expect(page.getByText(new RegExp(`Environment: LOCAL.*${staleInstance}`))).toBeVisible();
  const reads = recordReads(page);
  const recovered = page.waitForResponse(response => isAdminRead(response.request(), "profiles") && response.ok());
  await page.locator('nav a[href="/en/admin/profiles"]').click();
  await recovered;
  await expect(page.getByText(new RegExp(`Environment: LOCAL.*${originalInstance}`))).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(reads.map(request => new URL(request.url()).searchParams.get("database_instance_id"))).toEqual([staleInstance, null]);
  await openSection(page, "providers");
  expect(new URL(reads[2].url()).searchParams.get("database_instance_id")).toBe(originalInstance);
  await expect(page.getByText(staleInstance, { exact: false })).toHaveCount(0);
});
test("real TOTP enrollment verifies the current administrator session", async ({
  page
}) => {
  const authStatuses: { path: string; status: number }[] = [];
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/auth/v1/")) authStatuses.push({ path, status: response.status() });
  });
  await login(page, users.admin);
  await page.getByRole("button", {
    name: "Enroll TOTP"
  }).click();
  const secretLine = await page.getByText(/^Secret:/).innerText();
  const secret = secretLine.slice(secretLine.indexOf(":") + 1).trim();
  await page.getByLabel("TOTP code").fill(totp(secret));
  await page.getByRole("button", {
    name: "Verify"
  }).click();
  try {
    await expect(page.getByText("TOTP verified and session refreshed.", {
      exact: true
    })).toBeVisible();
  } catch (error) {
    // Never capture the page body, enrollment seed, token, or QR image.
    console.info("Local TOTP diagnostic", {
      authStatuses,
      assurance: await page.getByText(/Session assurance:/).allTextContents(),
      securityUnavailable: await page.getByText("Security settings are temporarily unavailable.", { exact: true }).count()
    });
    throw error;
  }
  await expect(page.getByText(/Session assurance: aal2/)).toBeVisible();
  await openSection(page, "users");
  const ordinary = page.locator("article").filter({
    hasText: users.ordinary.email
  });
  const id = await ordinary.locator("dt").filter({
    hasText: "auth user id"
  }).locator("..").locator("dd").innerText();
  await page.getByLabel("auth user id", {
    exact: true
  }).fill(id);
  await page.getByLabel("Reason", {
    exact: true
  }).fill("Verify authenticated TOTP membership grant");
  await page.getByRole("button", {
    name: "Submit",
    exact: true
  }).click();
  await expect(page.getByRole("status")).toContainText("Committed: op_");
  await page.getByLabel("Record kind").selectOption("members");
  const member = page.locator("article").filter({
    has: page.locator("dd").filter({
      hasText: id
    })
  });
  await expect(member.locator("dt").filter({
    hasText: "revision"
  })).toBeVisible();
  await member.getByRole("link", {
    name: "Details",
    exact: true
  }).click();
  await expect(page.getByLabel("expected revision", {
    exact: true
  })).toHaveValue("1");
  await openSection(page, "controls");
  await openSection(page, "providers");
  // Sensitive controls are always read again, even within the list cache window.
  await openSection(page, "controls");
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
    const providerLinks = page.locator('a[href*="disclosure="]');
    await expect(providerLinks).toHaveCount(3);
    const targets: { provider: RegExp; href: string }[] = [];
    for (const provider of [/DeepSeek/, /MiMo/, /Google|Gemini/]) {
      const link = providerLinks.filter({ hasText: provider });
      await expect(link).toHaveCount(1);
      const href = await link.getAttribute("href");
      expect(href).not.toBeNull();
      const url = new URL(href!, page.url());
      expect(url.pathname).toBe(`/${locale}/ai-terms`);
      expect([...url.searchParams.keys()].sort()).toEqual(["bundle", "digest", "disclosure", "manifest"]);
      targets.push({ provider, href: url.href });
    }
    for (const { provider, href } of targets) {
      await page.goto(href);
      await expect(page.getByRole("heading", { name: provider })).toBeVisible();
      // An exact disclosure is the document, rather than the generic selector
      // or all other providers' complete disclosures appended to the page.
      await expect(page.locator('a[href*="disclosure="]')).toHaveCount(0);
      await expect(page.locator("article p").first()).toBeVisible();
    }
  }
});
