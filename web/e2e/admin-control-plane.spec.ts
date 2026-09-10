import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";

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

function sql(value: string) { return "'" + value.replaceAll("'", "''") + "'"; }
function ownerSql(input: string) {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL !== 'http://127.0.0.1:54321') throw new Error('Local fixture only');
  const result = spawnSync('docker', ['exec','-i','supabase_db_typst-cv-template','psql','-U','postgres','-d','postgres','--set','ON_ERROR_STOP=1','--no-psqlrc'], {input,encoding:'utf8',timeout:60000});
  if (result.status !== 0) throw new Error(result.stderr || 'Local fixture SQL failed');
  return result.stdout;
}

// Exercise the browser in the synthetic bootstrap's legacy mode. Preserve the
// entire feature row and fixture mode; real cutover is covered by the DB suite.
async function withLegacyDraftPreparation(run: () => Promise<void>) {
  const snapshot = JSON.parse(ownerSql(`\n\\pset format unaligned\n\\pset tuples_only on
    select json_build_object('features',to_jsonb(f),'mode',e.control_plane_mode)
    from public.ai_feature_config f cross join public.admin_environment e
    where f.id=true and e.id=true and e.environment='local' and exists(
      select 1 from public.admin_principals p join auth.users u on u.id=p.user_id
      where u.email='admin-e2e-admin@example.test' and p.revoked_at is null
    );`).split(/\r?\n/u).find(line => line.startsWith('{'))!);
  try {
    ownerSql(`begin;
      update public.admin_environment set control_plane_mode='legacy' where id=true;
      update public.ai_feature_config set ai_polish_enabled=true where id=true;
      commit;`);
    const live = JSON.parse(ownerSql(`\n\\pset format unaligned\n\\pset tuples_only on
      select to_jsonb(f) from public.ai_feature_config f where id=true;`).split(/\r?\n/u).find(line => line.startsWith('{'))!);
    await run();
    ownerSql(`do $verify$ begin
      if (select to_jsonb(f) from public.ai_feature_config f where id=true) is distinct from ${sql(JSON.stringify(live))}::jsonb
        then raise exception 'E2E draft changed live feature configuration'; end if;
    end $verify$;`);
  } finally {
    ownerSql(`begin;
      update public.ai_feature_config set ai_polish_enabled=${snapshot.features.ai_polish_enabled} where id=true;
      update public.admin_environment set control_plane_mode=${sql(snapshot.mode)} where id=true;
      commit;`);
  }
}


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

test("creates an immutable draft while legacy AI is enabled", async ({ page }) => {
  await withLegacyDraftPreparation(async () => {
    await login(page, E2E_USERS.admin);
    await expect(page.getByRole("banner").getByText("Draft preparation available")).toBeVisible();
    await page.goto("/en/admin/profiles/11111111-1111-4111-8111-111111111111");
    await expect(page.getByRole("heading", { name: "Details", exact: true })).toBeVisible();
    const create = page.locator("section").filter({ has: page.getByRole("heading", { name: "Create version", exact: true }) });
    const model = `draft-ui-${Date.now()}`;
    await create.getByPlaceholder("Model", { exact: true }).fill(model);
    await create.getByPlaceholder("Reason", { exact: true }).fill("prepare before runtime cutover");
    await expect(create.getByRole("button", { name: "Create version", exact: true })).toBeEnabled();
    await expect(page.getByLabel("Destination status")).toBeDisabled();
    const response = page.waitForResponse(res => res.url().endsWith("/api/admin") && res.request().method() === "POST");
    await create.getByRole("button", { name: "Create version", exact: true }).click();
    const committed = await (await response).json();
    expect(committed.result).toMatchObject({ schemaVersion: "admin_profile_version_result_v1", status: "draft" });
    await page.goto(`/en/admin/profiles/${committed.result.profileVersionId}`);
    await expect(page.getByRole("heading", { name: "Details", exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("Model", { exact: true })).toHaveValue(model);
    await expect(page.getByLabel("Destination status")).toBeDisabled();
    await page.goto(`/en/admin/audit/${committed.auditId}`);
    await expect(page.getByText("prepare before runtime cutover", { exact: true })).toBeVisible();
  });
});

test("prepares a new identity, its first version and its first price through the UI", async ({ page }) => {
  await withLegacyDraftPreparation(async () => {
    await login(page, E2E_USERS.admin);
    await page.goto("/en/admin/providers/706513a5-462b-4bba-93b0-53e50661416e");
    const panel = (name: string) => page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) });
    const submit = async (form: ReturnType<typeof panel>, name = "Create version") => {
      const response = page.waitForResponse(res => res.url().endsWith("/api/admin") && res.request().method() === "POST");
      await form.getByRole("button", { name, exact: true }).click();
      const result = await response;
      expect(result.status()).toBe(200);
      return result.json();
    };
    const identity = panel("Create profile identity");
    await identity.getByPlaceholder("Profile key", { exact: true }).fill(`test.ui.first.${Date.now()}`);
    await identity.getByPlaceholder("Display name", { exact: true }).fill("New draft identity");
    await identity.getByPlaceholder("Model", { exact: true }).fill("deepseek");
    await identity.getByPlaceholder("Reason", { exact: true }).fill("prepare new identity");
    const createdIdentity = await submit(identity, "Create profile identity");
    const profileId = createdIdentity.result.profileId;
    await expect(page.getByLabel("Profile ID", { exact: true })).toHaveValue(profileId);
    // The same first-version entry can be resumed after a reload using this ID.
    await page.reload();
    await page.getByLabel("Profile ID", { exact: true }).fill(profileId);
    await panel("Prepare a profile's first version").getByRole("button", { name: "Apply", exact: true }).click();
    const version = panel("Create first profile version");
    await version.getByPlaceholder("Model", { exact: true }).fill("prepared-new-model");
    await version.getByPlaceholder("Credential env", { exact: true }).fill("AI_PROVIDER_KEY_DRAFT_E2E_NOT_CONFIGURED");
    await version.getByPlaceholder("Capability contract", { exact: true }).fill("deepseek_chat_json_object_v1");
    await version.getByPlaceholder("Cache policy", { exact: true }).fill("deepseek_automatic_context_cache_v1");
    await version.getByPlaceholder("Legal manifest", { exact: true }).fill("deepseek-official-2026-08-23-v1");
    await version.getByPlaceholder("Disclosure", { exact: true }).fill("draft.ui.future");
    await version.getByLabel("Adapter configuration (JSON)").fill(JSON.stringify({ thinking: "disabled", structuredOutput: "json_object", providerSubjectField: "user_id" }));
    await version.getByPlaceholder("Reason", { exact: true }).fill("first version from new identity");
    const createdVersion = await submit(version);
    expect(createdVersion.result).toMatchObject({ profileId, version: 1, status: "draft" });
    const profileVersionId = createdVersion.result.profileVersionId;
    const price = panel("Create first price for this version");
    await expect(price.getByText(`Profile version ID: ${profileVersionId}`, { exact: true })).toBeVisible();
    await version.getByPlaceholder("Reason", { exact: true }).fill("prepare another version later");
    await expect(price.getByText(`Profile version ID: ${profileVersionId}`, { exact: true })).toBeVisible();
    await price.getByLabel("Pricing lane", { exact: true }).fill("default");
    await price.getByPlaceholder("sourceUrl", { exact: true }).fill("https://example.test/prepared-price");
    await price.getByPlaceholder("sourceSnapshotSha256", { exact: true }).fill("a".repeat(64));
    await price.getByLabel("Price components (JSON)").fill(JSON.stringify({ input_standard: "100", input_cache_read: "10", output: "200" }));
    await price.getByPlaceholder("Reason", { exact: true }).fill("first price for new version");
    const createdPrice = await submit(price);
    expect(createdPrice.result).toMatchObject({ profileVersionId, pricingLane: "default", version: 1, sealed: false });
    ownerSql(`do $ownership$ begin
      if not exists(select 1 from public.ai_price_versions price join public.ai_provider_profile_versions profile on profile.id=price.profile_version_id
        where price.id=${sql(createdPrice.result.priceVersionId)}::uuid and profile.id=${sql(profileVersionId)}::uuid
          and profile.profile_id=${sql(profileId)}::uuid and profile.status='draft' and price.components_sealed_at is null)
        then raise exception 'Wrong first-price ownership'; end if;
      end $ownership$;`);
    await page.goto(`/en/admin/prices/${createdPrice.result.priceVersionId}`);
    await expect(page.getByText(profileVersionId, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Seal price for activation", exact: true })).toBeDisabled();
    await page.goto(`/en/admin/audit/${createdPrice.auditId}`);
    await expect(page.getByText("first price for new version", { exact: true })).toBeVisible();
  });
});

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

test("Admin owns scrolling on short login and long mobile details", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 320 });
  await page.goto("/en/admin");
  const viewport = page.locator("[data-admin-viewport]");
  await page.mouse.move(200, 240);
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeInViewport();
  await page.setViewportSize({ width: 390, height: 720 });
  await login(page, E2E_USERS.admin);
  await page.goto("/en/admin/profiles/11111111-1111-4111-8111-111111111111");
  await expect(page.getByRole("heading", { name: "Details", exact: true })).toBeVisible();
  await page.mouse.move(200, 500);
  await page.mouse.wheel(0, 30000);
  await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
  await expect(page.getByRole("button", { name: "Create version", exact: true }).last()).toBeInViewport();
  expect(await page.getByRole("banner").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});
