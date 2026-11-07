import { expect, test } from "@playwright/test";
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
async function login(page: import("@playwright/test").Page, user: typeof users.admin) {
  await page.goto("/en/admin");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", {
    name: "Sign in",
    exact: true
  }).click();
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
test("admin creates a current-format profile without a provider request", async ({
  page
}) => {
  await login(page, users.admin);
  await expect(page.getByText(/Environment: LOCAL/)).toBeVisible();
  await page.goto("/en/admin/providers");
  const provider = await page.locator("dd").filter({
    hasText: /^prv_[0-9A-HJKMNP-TV-Z]{12}$/
  }).first().innerText();
  await page.goto("/en/admin/profiles");
  await page.getByLabel("provider id", {
    exact: true
  }).fill(provider);
  await page.getByLabel("code", {
    exact: true
  }).fill(`ADMIN_E2E_${Date.now()}`);
  await page.getByLabel("name", {
    exact: true
  }).fill("Local browser draft");
  await page.getByLabel("description", {
    exact: true
  }).fill("Real Auth browser test");
  await page.getByLabel("Reason", {
    exact: true
  }).fill("Verify draft from the new baseline");
  await page.getByRole("button", {
    name: "Submit",
    exact: true
  }).click();
  await expect(page.getByRole("status")).toContainText("Committed: op_");
});
test("real TOTP enrollment verifies the current administrator session", async ({
  page
}) => {
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
  await expect(page.getByText("TOTP verified and session refreshed.", {
    exact: true
  })).toBeVisible();
  await expect(page.getByText(/Session assurance: aal2/)).toBeVisible();
  await page.goto("/en/admin/users");
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
    await expect(page.getByRole("heading", {
      name: /DeepSeek/
    })).toBeVisible();
    await expect(page.getByRole("heading", {
      name: /MiMo/
    })).toBeVisible();
  }
});
