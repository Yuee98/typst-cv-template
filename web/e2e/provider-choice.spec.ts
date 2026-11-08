import { expect, test } from "@playwright/test";
import { polishAvailabilityResponseSchema, polishPostRequestSchema, polishSuccessResponseSchema } from "../src/lib/polish/contract";
const appOrigin = "http://127.0.0.1:4173";
const databaseOrigin = "http://127.0.0.1:54329";
const userId = "10000000-0000-4000-8000-000000000002";
const databaseInstance = "10000000-0000-4000-8000-000000000001";
const digest = "1".repeat(64);
const termsId = "ldv_000000000001";
const selectedOptionId = "opt_000000000002";
const selectedDisclosureId = "lds_000000000002";

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
  const termsContent = {
    title: "Fixture current Terms",
    effectiveDate: "2026-11-07",
    intro: ["Synthetic browser fixture terms."],
    sections: []
  };
  const availabilityResponse = await page.request.get(`${appOrigin}/api/polish/availability`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  expect(availabilityResponse.ok()).toBe(true);
  const available = polishAvailabilityResponseSchema.parse(await availabilityResponse.json()).availability;
  expect(available.options.map(option => option.optionId)).toEqual(["opt_000000000001", selectedOptionId]);
  const disclosures = available.options.map(option => option.legalDisplay);
  const commonIntro = "Synthetic common AI terms, shown once on the generic page.";
  const currentLegal = {
    terms: {
      external_id: termsId,
      content_digest: digest,
      renderer_contract: "legal_document_1",
      content: { en: termsContent, zh: termsContent }
    },
    ai_bundle: {
      external_id: disclosures[0].bundleId,
      manifest_digest: disclosures[0].manifestDigest,
      ai_terms: {
        external_id: "ldv_000000000002",
        content_digest: digest,
        renderer_contract: "legal_document_1",
        content: {
          en: { ...termsContent, title: "Fixture common AI Terms", intro: [commonIntro] },
          zh: { ...termsContent, title: "Fixture common AI Terms", intro: [commonIntro] }
        }
      },
      disclosures: disclosures.map((display, index) => ({
        external_id: display.disclosureId,
        provider_code: index === 0 ? "DEEPSEEK" : "MIMO",
        content_digest: display.contentDigest,
        renderer_contract: "legal_display_1",
        content: { en: display.en, zh: display.zh }
      }))
    }
  };
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
        expect(body.availability.options.map(option => option.optionId)).toEqual(["opt_000000000001", selectedOptionId]);
        expect(body.availability.options.map(option => option.legalDisplay)).toEqual(disclosures);
        return route.fulfill({
          response: upstream,
          json: {
            ...body,
            availability: {
              ...body.availability,
              options: body.availability.options.map(option => ({
                ...option,
                status: acceptedInputs.some(input => input.disclosure_id === option.legalDisplay.disclosureId && input.content_digest === option.legalDisplay.contentDigest) ? "READY" : "CONSENT_REQUIRED"
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
      expect(request.postDataJSON()).toMatchObject({
        email: user.email,
        password: "local-browser-fixture"
      });
      sequence.push("login");
      return json(session);
    }
    if (url.pathname === "/auth/v1/user") return json(user);
    if (url.pathname === "/rest/v1/rpc/app_context") return json({
      ready: true,
      contract_code: "cv_app_db_1",
      database_instance_id: databaseInstance,
      environment: "LOCAL"
    });
    if (url.pathname === "/rest/v1/rpc/legal_current") return json(currentLegal);
    if (url.pathname === "/rest/v1/legal_my_acceptances") return json({
      document_version_id: termsId,
      accepted_content_digest: digest
    });
    if (url.pathname === "/rest/v1/cv_document_summaries") return json([]);
    if (url.pathname === "/rest/v1/rpc/legal_accept_disclosure") {
      const body = request.postDataJSON() as {
        p_input: Record<string, unknown>;
      };
      acceptedInputs.push(body.p_input);
      sequence.push("consent");
      return json({
        accepted: true,
        target_id: body.p_input.disclosure_id,
        content_digest: body.p_input.content_digest
      });
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
    name: "Choose AI provider and model"
  });
  await expect(provider).toHaveValue("opt_000000000001");
  await expect(provider.locator("option:checked")).toHaveText(`${available.options[0].providerName} · ${available.options[0].modelName}`);
  const submit = dialog.getByRole("button", {
    name: "Polish with AI",
    exact: true
  });
  await expect(submit).toBeDisabled();
  const consent = dialog.getByRole("checkbox", {
    name: /I have read and agree/
  });
  const disclosureLink = consent.locator("..").locator('a[href*="disclosure="]');
  async function reviewDisclosure(index: number) {
    const display = disclosures[index];
    await expect(dialog.locator('a[href*="disclosure="]')).toHaveCount(1);
    await expect(disclosureLink).toHaveCount(1);
    const link = new URL(await disclosureLink.getAttribute("href") ?? "", appOrigin);
    expect(link.pathname).toBe("/en/ai-terms");
    expect(Object.fromEntries(link.searchParams)).toEqual({
      bundle: display.bundleId,
      manifest: display.manifestDigest,
      disclosure: display.disclosureId,
      digest: display.contentDigest
    });
    expect([...link.searchParams]).toHaveLength(4);
    await expect(disclosureLink).toHaveAttribute("target", "_blank");
    expect((await disclosureLink.getAttribute("rel"))?.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
    const checked = await consent.isChecked();
    const newPage = context.waitForEvent("page");
    await disclosureLink.click();
    const document = await newPage;
    await expect(document.getByRole("heading", {
      name: new RegExp(`${display.en.providerLabel}.*${display.en.modelLabel}`)
    })).toBeVisible();
    for (const block of display.en.blocks) {
      for (const text of block.kind === "paragraph" ? [block.text] : block.items) {
        await expect(document.getByText(text, { exact: true })).toHaveCount(1);
        await expect(dialog.getByText(text, { exact: true })).toHaveCount(0);
      }
    }
    const other = disclosures[index === 0 ? 1 : 0];
    await expect(document.getByText(other.en.modelLabel, { exact: false })).toHaveCount(0);
    await document.close();
    expect(await consent.isChecked()).toBe(checked);
    expect(acceptedInputs).toEqual([]);
    expect(sequence).toEqual(["login"]);
    return link.href;
  }
  const defaultLink = await reviewDisclosure(0);
  await consent.check();
  await expect(submit).toBeEnabled();

  // Selecting another provider resets consent. No write occurs merely by
  // checking the default provider, changing the selection or viewing a disclosure.
  await provider.selectOption(selectedOptionId);
  await expect(provider).toHaveValue(selectedOptionId);
  await expect(provider.locator("option:checked")).toHaveText(`${available.options[1].providerName} · ${available.options[1].modelName}`);
  await expect(consent).not.toBeChecked();
  await expect(submit).toBeDisabled();
  expect(acceptedInputs).toEqual([]);
  expect(await reviewDisclosure(1)).not.toBe(defaultLink);

  const generic = await context.newPage();
  await generic.goto(`${appOrigin}/en/ai-terms`);
  await expect(generic.getByText(commonIntro, { exact: true })).toHaveCount(1);
  await expect(generic.locator('a[href*="disclosure="]')).toHaveCount(2);
  for (const block of disclosures[0].en.blocks) {
    for (const text of block.kind === "paragraph" ? [block.text] : block.items) {
      await expect(generic.getByText(text, { exact: true })).toHaveCount(0);
    }
  }
  const wrongDigest = new URL(defaultLink);
  wrongDigest.searchParams.set("digest", "2".repeat(64));
  const missingManifest = new URL(defaultLink);
  missingManifest.searchParams.delete("manifest");
  const duplicateDisclosure = new URL(defaultLink);
  duplicateDisclosure.searchParams.append("disclosure", selectedDisclosureId);
  for (const invalid of [wrongDigest, missingManifest, duplicateDisclosure]) {
    await generic.goto(invalid.href);
    await expect(generic.getByRole("alert").filter({
      hasText: "These terms have changed or the link cannot be verified."
    })).toBeVisible();
    await expect(generic.getByRole("heading", { name: /Fixture model/ })).toHaveCount(0);
    await expect(generic.locator('a[href*="disclosure="]')).toHaveCount(0);
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
  expect(submitted.expectedRoute.selectedOptionId).toBe(selectedOptionId);
  expect(submitted.expectedRoute.profileVersionId).toBe("pfv_000000000002");
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
    contract_code: "cv_app_db_1",
    database_instance_id: databaseInstance,
    disclosure_id: selectedDisclosureId,
    content_digest: digest,
    bundle_id: "lgb_000000000001",
    manifest_digest: digest
  }]);
  expect(sequence).toEqual(["login", "consent", "polish"]);
  expect(unexpectedRequests).toEqual([]);
});
