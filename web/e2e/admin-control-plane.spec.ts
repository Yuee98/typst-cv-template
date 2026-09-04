import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";

const E2E_USERS = {
  admin: {
    email: "admin-e2e-admin@example.test",
    password: "AdminE2E!local-2026",
  },
  ordinary: {
    email: "admin-e2e-ordinary@example.test",
    password: "OrdinaryE2E!local-2026",
  },
};

function totp(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < key.length; i++) key[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function login(page: import("@playwright/test").Page, user: { email: string; password: string }) {
  await page.goto("/en/admin");
  await page.getByPlaceholder("Email").fill(user.email);
  await page.getByPlaceholder("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
}

test("local Supabase Auth, MFA step-up, membership operation and revocation", async ({ page, browser }) => {
  const ordinary = await browser.newContext();
  const ordinaryPage = await ordinary.newPage();
  await ordinaryPage.goto("/en/admin");
  await ordinaryPage.getByPlaceholder("Email").fill(E2E_USERS.ordinary.email);
  await ordinaryPage.getByPlaceholder("Password").fill(E2E_USERS.ordinary.password);
  await ordinaryPage.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(ordinaryPage.getByText("Your account does not have administrator access.")).toBeVisible();
  await login(page, E2E_USERS.admin);
  await expect(
    page.getByRole("banner").getByText("local", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Enroll TOTP", exact: true }).click();
  await expect(page.getByText("Enrollment is ready to verify.")).toBeVisible();
  const secretText = await page.getByText(/Secret:/).textContent();
  const secret = secretText?.replace(/^Secret:\s*/, "").trim();
  expect(secret).toBeTruthy();
  await page.getByLabel("TOTP code").fill(totp(secret!));
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByText(/Session assurance:\s*aal2/u)).toBeVisible();
  await page.goto("/en/admin/users");
  await page.getByLabel("Search").fill(E2E_USERS.ordinary.email);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  const ordinaryRow = page.getByRole("row").filter({
    hasText: E2E_USERS.ordinary.email,
  });
  await expect(ordinaryRow).toHaveCount(1);
  await ordinaryRow.getByRole("link", { name: "View", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Details", exact: true })).toBeVisible();
  await page.getByPlaceholder("Reason", { exact: true }).fill("admin UI E2E grant");
  await page.getByRole("button", { name: "Grant administrator", exact: true }).click();
  await expect(page.getByText("Operation committed")).toBeVisible();
  await expect(page.getByText(/Operation ID:/)).toBeVisible();
  await expect(page.getByText(/Audit ID:/)).toBeVisible();
  await ordinaryPage.reload();
  await expect(
    ordinaryPage.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByPlaceholder("Reason", { exact: true }).fill("admin UI E2E revoke");
  await page.getByRole("button", { name: "Revoke administrator", exact: true }).click();
  await expect(page.getByText("Operation committed")).toBeVisible();
  await ordinaryPage.reload();
  await expect(
    ordinaryPage.getByText(
      "Your account does not have administrator access.",
    ),
  ).toBeVisible();
  await ordinary.close();
});
