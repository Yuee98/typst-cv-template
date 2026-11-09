import { expect, test } from "@playwright/test";
import { polishAvailabilityResponseSchema, polishPostRequestSchema, polishSuccessResponseSchema } from "../src/lib/polish/contract";
const appOrigin = "http://127.0.0.1:4173";
const databaseOrigin = "http://127.0.0.1:54329";
const userId = "10000000-0000-4000-8000-000000000002";
const databaseInstance = "10000000-0000-4000-8000-000000000001";
const digest = "1".repeat(64);
const termsId = "ldoc_000000000100";
const selectedConfigId = "2";
const selectedDocumentAuditId = "12";

// Auth/Data API are browser-bound fixtures. The Next polish API is real HTTP
// running the existing paired fake backend, not a mocked successful POST.
test("selects a nondefault provider and accepts only its disclosure before sending", async ({
  page,
  context
}) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.clock.setFixedTime(new Date("2026-11-07T01:00:00.000Z"));
  const sequence: string[] = [];
  const unexpectedRequests: string[] = [];
  const acceptedInputs: Record<string, unknown>[] = [];
  let expireDefault = false;
  const user = {
    id: userId,
    aud: "authenticated",
    role: "authenticated",
    email: "provider-choice@fixture.invalid",
    email_confirmed_at: "2026-11-07T00:00:00.000Z",
    app_metadata: {
      provider: "email",
      providers: ["email"]
    },
    user_metadata: {},
    identities: [],
    created_at: "2026-11-07T00:00:00.000Z",
    updated_at: "2026-11-07T00:00:00.000Z"
  };
  const token = [{
    alg: "HS256",
    typ: "JWT"
  }, {
    sub: userId,
    aud: "authenticated",
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 86_400
  }].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".") + ".local-fixture-signature";
  const session = {
    access_token: token,
    token_type: "bearer",
    expires_in: 86_400,
    expires_at: Math.floor(Date.now() / 1000) + 86_400,
    refresh_token: "provider-choice-local-fixture-refresh",
    user
  };
  const secondUser = { ...user, id: "10000000-0000-4000-8000-000000000003", email: "other-account@fixture.invalid" };
  const secondToken = token.split(".").map((part, index) => index === 1 ? Buffer.from(JSON.stringify({ sub: secondUser.id, aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 86400 })).toString("base64url") : part).join(".");
  const secondSession = { ...session, user: secondUser, access_token: secondToken, refresh_token: "second-local-fixture-refresh" };
  const availabilityResponse = await page.request.get(`${appOrigin}/api/polish/availability`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  expect(availabilityResponse.ok()).toBe(true);
  const available = polishAvailabilityResponseSchema.parse(await availabilityResponse.json()).availability;
  expect(available.configurations.map(option => option.configId)).toEqual(["1", selectedConfigId]);
  const disclosures = available.configurations.map(option => option.legalDisplay);
  const commonIntro = "Only explicitly selected content is transmitted.";
  const terms = { ...disclosures[0].common, document_id: "100", external_id: termsId, document_audit_id: "100", kind: "TERMS" as const, zh_title: "测试服务条款", en_title: "Fixture current Terms", zh_body: "测试服务条款。", en_body: "Synthetic browser fixture terms." };
  const currentLegal = { documents: [terms, disclosures[0].common, ...disclosures.map(display => display.provider)] };
  const cors = {
    "access-control-allow-origin": appOrigin,
    "access-control-allow-headers": "authorization,apikey,content-type,x-client-info",
    "access-control-allow-methods": "GET,POST,OPTIONS"
  };
  // Context routing also protects the first navigation and reads in new tabs.
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === appOrigin) {
      if (url.pathname === "/api/polish/availability") {
        // Exercise the real Next fake availability response. Its fixture treats
        // consent as already accepted; this browser scenario starts unaccepted.
        const upstream = await route.fetch();
        expect(upstream.ok()).toBe(true);
        const body = polishAvailabilityResponseSchema.parse(await upstream.json());
        expect(body.availability.configurations.map(option => option.configId)).toEqual(["1", selectedConfigId]);
        expect(body.availability.configurations.map(option => option.legalDisplay)).toEqual(disclosures);
        return route.fulfill({
          response: upstream,
          json: {
            ...body,
            availability: {
              ...body.availability,
              defaultConfigId: expireDefault ? "2" : body.availability.defaultConfigId,
              configurations: body.availability.configurations.filter(option => !expireDefault || option.configId !== "1").map(option => ({
                ...option,
                status: acceptedInputs.some(input => JSON.stringify(input.provider) === JSON.stringify({ document_id: option.legalDisplay.provider.document_id, document_audit_id: option.legalDisplay.provider.document_audit_id })) ? "READY" : "CONSENT_REQUIRED"
              }))
            }
          }
        });
      }
      if (url.pathname === "/api/polish" && request.method() === "POST") sequence.push("polish");
      return route.continue();
    }
    if (url.origin !== databaseOrigin) {
      unexpectedRequests.push(url.origin + url.pathname);
      return route.abort("blockedbyclient");
    }
    if (request.method() === "OPTIONS") return route.fulfill({
      status: 204,
      headers: cors
    });
    const json = (value: unknown) => route.fulfill({
      status: 200,
      headers: cors,
      json: value
    });
    if (url.pathname === "/auth/v1/token") {
      const credentials = request.postDataJSON();
      expect([user.email, secondUser.email]).toContain(credentials.email);
      expect(credentials.password).toBe("local-browser-fixture");
      sequence.push(credentials.email === user.email ? "login" : "login-second");
      return json(credentials.email === user.email ? session : secondSession);
    }
    if (url.pathname === "/auth/v1/logout") {
      sequence.push("logout");
      return route.fulfill({ status: 204, headers: cors });
    }
    if (url.pathname === "/auth/v1/user") return json(request.headers().authorization === `Bearer ${secondToken}` ? secondUser : user);
    if (url.pathname === "/rest/v1/rpc/app_context") return json({
      ready: true,
      contract_code: "cv_app_db_2",
      database_instance_id: databaseInstance,
      environment: "LOCAL",
      capabilities: { cv_schema_version: 7, encrypted_envelope_version: 1 }
    });
    if (url.pathname === "/rest/v1/rpc/legal_current") return json(currentLegal);
    if (url.pathname === "/rest/v1/rpc/legal_document_read") {
      const { p_input: target } = request.postDataJSON();
      const document = currentLegal.documents.find(document => document.external_id === target.external_id && document.document_audit_id === target.document_audit_id && document.content_digest === target.content_digest);
      return document ? json(document) : route.fulfill({ status: 404, headers: cors, json: { message: "NOT_FOUND" } });
    }
    if (url.pathname === "/rest/v1/legal_my_acceptances") return json({
      document_id: "100", document_audit_id: "100", content_digest: digest
    });
    if (url.pathname === "/rest/v1/cv_document_summaries") return json([]);
    if (url.pathname === "/rest/v1/rpc/legal_accept_ai") {
      const body = request.postDataJSON() as {
        p_input: Record<string, unknown>;
      };
      acceptedInputs.push(body.p_input);
      sequence.push("consent");
      return json({ accepted: true, common_acceptance_audit_id: "1", provider_acceptance_audit_id: "12" });
    }
    unexpectedRequests.push(url.pathname);
    return route.abort("blockedbyclient");
  });
  await page.goto("/en");
  await expect(page.getByRole("heading", {
    name: "CV Library"
  })).toBeVisible();
  await page.getByRole("button", {
    name: "Account",
    exact: true
  }).click();
  await page.getByRole("menuitem", {
    name: "Log in",
    exact: true
  }).click();
  const login = page.getByRole("dialog", {
    name: "Log in",
    exact: true
  });
  await login.locator('input[name="email"]').fill(user.email);
  await login.locator('input[name="password"]').fill("local-browser-fixture");
  await login.getByRole("button", {
    name: "Log in",
    exact: true
  }).click();
  await expect(login).not.toBeVisible();
  await expect(page.getByRole("button", {
    name: "Signed in account"
  })).toBeVisible();
  await page.getByRole("tab", {
    name: "Profile. Drag to reorder section."
  }).click();
  await page.getByRole("button", {
    name: "Polish this entry with AI",
    exact: true
  }).click();
  const dialog = page.getByRole("dialog", {
    name: "AI Polish",
    exact: true
  });
  const provider = dialog.getByRole("combobox", {
    name: "Choose AI service"
  });
  await expect(provider).toHaveValue("1");
  await expect(provider.locator("option:checked")).toHaveText(available.configurations[0].displayName);
  const submit = dialog.getByRole("button", {
    name: "Polish with AI",
    exact: true
  });
  await expect(submit).toBeDisabled();
  const consent = dialog.getByRole("checkbox", {
    name: /I have read and agree/
  });
  const disclosureLink = consent.locator("..").locator('a[href*="provider="]');
  async function reviewDisclosure(index: number) {
    const display = disclosures[index];
    await expect(dialog.locator('a[href*="provider="]')).toHaveCount(1);
    await expect(disclosureLink).toHaveCount(1);
    const link = new URL(await disclosureLink.getAttribute("href") ?? "", appOrigin);
    expect(link.pathname).toBe("/en/ai-terms");
    expect(Object.fromEntries(link.searchParams)).toEqual({
      common: display.common.external_id, common_audit: display.common.document_audit_id, common_digest: display.common.content_digest,
      provider: display.provider.external_id, provider_audit: display.provider.document_audit_id, provider_digest: display.provider.content_digest
    });
    expect([...link.searchParams]).toHaveLength(6);
    await expect(disclosureLink).toHaveAttribute("target", "_blank");
    expect((await disclosureLink.getAttribute("rel"))?.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
    const checked = await consent.isChecked();
    const newPage = context.waitForEvent("page");
    await disclosureLink.click();
    const document = await newPage;
    await expect(document.getByRole("heading", { name: display.provider.en_title, exact: true })).toBeVisible();
    for (const text of [`${display.provider.recipient_name} processes the selected content.`, "Local fixture recipient disclosure."]) {
      await expect(document.getByText(text, { exact: true })).toHaveCount(1);
      await expect(dialog.getByText(text, { exact: true })).toHaveCount(0);
    }
    const other = disclosures[index === 0 ? 1 : 0];
    await expect(document.getByText(`${other.provider.recipient_name} processes the selected content.`, { exact: true })).toHaveCount(0);
    await document.close();
    expect(await consent.isChecked()).toBe(checked);
    expect(acceptedInputs).toEqual([]);
    expect(sequence).toEqual(["login"]);
    return link.href;
  }
  const defaultLink = await reviewDisclosure(0);
  // The authority can expire the selected default while another option remains.
  // A refresh must clear the choice and require an explicit new selection.
  expireDefault = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(provider).toHaveValue("");
  await expect(submit).toBeDisabled();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  expect(acceptedInputs).toEqual([]);
  expireDefault = false;
  const restored = page.waitForResponse(response => new URL(response.url()).pathname === "/api/polish/availability");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await restored;
  await expect(provider).toHaveValue("");
  await provider.selectOption("1");
  await expect(consent).not.toBeChecked();
  await consent.check();
  await expect(submit).toBeEnabled();

  // Selecting another provider resets consent. No write occurs merely by
  // checking the default provider, changing the selection or viewing a disclosure.
  await provider.selectOption(selectedConfigId);
  await expect(provider).toHaveValue(selectedConfigId);
  await expect(provider.locator("option:checked")).toHaveText(available.configurations[1].displayName);
  await expect(consent).not.toBeChecked();
  await expect(submit).toBeDisabled();
  expect(acceptedInputs).toEqual([]);
  expect(await reviewDisclosure(1)).not.toBe(defaultLink);

  const generic = await context.newPage();
  await generic.goto(`${appOrigin}/en/ai-terms`);
  await expect(generic.getByText(commonIntro, { exact: true })).toHaveCount(1);
  await expect(generic.locator('a[href*="provider="]')).toHaveCount(2);
  await expect(generic.getByText("Local fixture recipient disclosure.", { exact: true })).toHaveCount(0);
  const wrongDigest = new URL(defaultLink);
  wrongDigest.searchParams.set("provider_digest", "9".repeat(64));
  const missingCommonAudit = new URL(defaultLink);
  missingCommonAudit.searchParams.delete("common_audit");
  const duplicateProvider = new URL(defaultLink);
  duplicateProvider.searchParams.append("provider", selectedDocumentAuditId);
  for (const invalid of [wrongDigest, missingCommonAudit, duplicateProvider]) {
    await generic.goto(invalid.href);
    await expect(generic.getByRole("alert").filter({
      hasText: "This terms link cannot be verified. Return to the editor and open the terms link again."
    })).toBeVisible();
    await expect(generic.getByRole("heading", { name: /processing disclosure/ })).toHaveCount(0);
    await expect(generic.locator('a[href*="provider="]')).toHaveCount(0);
  }
  await generic.close();
  await expect(consent).not.toBeChecked();
  expect(acceptedInputs).toEqual([]);
  await consent.check();
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === "/api/polish" && response.request().method() === "POST");
  await submit.click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const submitted = polishPostRequestSchema.parse(response.request().postDataJSON());
  expect(submitted.expectedRoute.configId).toBe(selectedConfigId);
  expect(submitted.expectedRoute.configRevision).toBe("1");
  const result = polishSuccessResponseSchema.parse(await response.json());
  expect(result.items.length).toBeGreaterThan(0);
  await expect(dialog.getByText("Review each polished item and accept or reject it.", {
    exact: true
  })).toBeVisible();
  await expect(dialog.getByRole("button", {
    name: "Done",
    exact: true
  })).toBeVisible();
  expect(acceptedInputs).toEqual([{
    expected_auth_user_id: userId,
    contract_code: "cv_app_db_2",
    database_instance_id: databaseInstance,
    common: { document_id: disclosures[1].common.document_id, document_audit_id: disclosures[1].common.document_audit_id },
    provider: { document_id: disclosures[1].provider.document_id, document_audit_id: disclosures[1].provider.document_audit_id }
  }]);
  expect(sequence).toEqual(["login", "consent", "polish"]);

  // A remote/form update after generation must not be overwritten by an old
  // preview. Use the native DOM event path into the real React Hook Form.
  const edited = "New externally edited draft must survive the old AI preview.";
  const target = page.locator('textarea[name="profile.0.body"]');
  await expect(target).toHaveCount(1);
  await target.evaluate((element, value) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, edited);
  await dialog.getByRole("button", { name: "Accept all", exact: true }).click();
  await expect(dialog.getByText("This field was changed elsewhere and cannot be written back.", { exact: true })).toBeVisible();
  await expect(target).toHaveValue(edited);

  // The same dialog fits a narrow viewport without changing its application DOM.
  await page.setViewportSize({ width: 375, height: 812 });
  const geometry = await dialog.evaluate(element => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, viewport: innerWidth, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  await expect(dialog.getByRole("button", { name: "Done", exact: true })).toBeVisible();

  // Real Supabase cross-tab auth events must revoke the open A-owned dialog.
  // No consent or generation is performed under the replacement account.
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Polish this entry with AI", exact: true }).click();
  await expect(dialog).toBeVisible();
  const peer = await context.newPage();
  await peer.goto(`${appOrigin}/en`);
  await peer.getByRole("button", { name: "Signed in account", exact: true }).click();
  await peer.getByRole("menuitem", { name: "Log out", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await peer.getByRole("button", { name: "Account", exact: true }).click();
  await peer.getByRole("menuitem", { name: "Log in", exact: true }).click();
  const secondLogin = peer.getByRole("dialog", { name: "Log in", exact: true });
  await secondLogin.locator('input[name="email"]').fill(secondUser.email);
  await secondLogin.locator('input[name="password"]').fill("local-browser-fixture");
  await secondLogin.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(secondLogin).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Signed in account", exact: true })).toBeVisible();
  await expect(dialog).not.toBeVisible();
  expect(acceptedInputs).toHaveLength(1);
  expect(sequence.filter(item => item === "polish")).toHaveLength(1);
  await peer.close();
  expect(unexpectedRequests).toEqual([]);
});
