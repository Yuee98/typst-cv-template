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
  page
}) => {
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
    refresh_token: "provider-choice-local-fixture-refresh",
    user
  };
  const termsContent = {
    title: "Fixture current Terms",
    effectiveDate: "2026-11-07",
    intro: ["Synthetic browser fixture terms."],
    sections: []
  };
  const cors = {
    "access-control-allow-origin": appOrigin,
    "access-control-allow-headers": "authorization,apikey,content-type,x-client-info",
    "access-control-allow-methods": "GET,POST,OPTIONS"
  };
  await page.route("**/*", async route => {
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
    if (url.pathname === "/rest/v1/rpc/legal_current") return json({
      terms: {
        external_id: termsId,
        content_digest: digest,
        renderer_contract: "legal_document_1",
        content: {
          en: termsContent,
          zh: termsContent
        }
      },
      ai_bundle: null
    });
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
  await expect(dialog.getByText("DeepSeek · Fixture model 1", {
    exact: true
  })).toBeVisible();
  const submit = dialog.getByRole("button", {
    name: "Polish with AI",
    exact: true
  });
  await expect(submit).toBeDisabled();
  await dialog.getByRole("checkbox", {
    name: /I have read and agree/
  }).check();
  await expect(submit).toBeEnabled();

  // Selecting another provider resets consent. No write occurs merely by
  // checking the default provider, changing the selection or viewing a disclosure.
  await provider.selectOption(selectedOptionId);
  await expect(dialog.getByText("MiMo · Fixture model 2", {
    exact: true
  })).toBeVisible();
  await expect(dialog.getByText("DeepSeek · Fixture model 1", {
    exact: true
  })).not.toBeVisible();
  const consent = dialog.getByRole("checkbox", {
    name: /I have read and agree/
  });
  await expect(consent).not.toBeChecked();
  await expect(submit).toBeDisabled();
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
