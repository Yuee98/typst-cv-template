import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAnonClient,
  createServiceClient,
  createTestUser,
  deleteTestUser,
  RUN_DB_TESTS,
  signInAsUser,
  type TestUser,
} from "./helpers";

const LEGAL_BUNDLE_VERSION = "2026-08-23-multi-provider-v1";
const PERMISSION_DENIED = "42501";

describe.skipIf(!RUN_DB_TESTS)("exact AI legal bundle gate (real DB)", () => {
  let service: SupabaseClient;
  let user: TestUser;
  let authed: SupabaseClient;

  beforeAll(async () => {
    service = createServiceClient();
    user = await createTestUser(service, "legal-bundle");
    authed = await signInAsUser(user);
  });

  afterAll(async () => {
    await deleteTestUser(service, user.id);
  });

  it("publishes the coordinated multi-provider bundle literal", async () => {
    const { data, error } = await authed.rpc("current_ai_terms_version");
    expect(error).toBeNull();
    expect(data).toBe(LEGAL_BUNDLE_VERSION);
  });

  it("requires an exact current-version acceptance", async () => {
    const before = await service.rpc("has_accepted_ai_legal_bundle", {
      p_user_id: user.id,
      p_legal_bundle_version: LEGAL_BUNDLE_VERSION,
    });
    expect(before.error).toBeNull();
    expect(before.data).toBe(false);

    const { error: oldAcceptanceError } = await service
      .from("user_terms_acceptances")
      .insert({
        user_id: user.id,
        document_key: "ai_terms",
        version: "2026-08-04",
      });
    expect(oldAcceptanceError).toBeNull();

    const oldDoesNotAuthorize = await service.rpc(
      "has_accepted_ai_legal_bundle",
      {
        p_user_id: user.id,
        p_legal_bundle_version: LEGAL_BUNDLE_VERSION,
      },
    );
    expect(oldDoesNotAuthorize.error).toBeNull();
    expect(oldDoesNotAuthorize.data).toBe(false);

    const { error: currentAcceptanceError } = await service
      .from("user_terms_acceptances")
      .insert({
        user_id: user.id,
        document_key: "ai_terms",
        version: LEGAL_BUNDLE_VERSION,
      });
    expect(currentAcceptanceError).toBeNull();

    const currentAuthorizes = await service.rpc(
      "has_accepted_ai_legal_bundle",
      {
        p_user_id: user.id,
        p_legal_bundle_version: LEGAL_BUNDLE_VERSION,
      },
    );
    expect(currentAuthorizes.error).toBeNull();
    expect(currentAuthorizes.data).toBe(true);

    const staleRoute = await service.rpc("has_accepted_ai_legal_bundle", {
      p_user_id: user.id,
      p_legal_bundle_version: "2026-08-04",
    });
    expect(staleRoute.error).toBeNull();
    expect(staleRoute.data).toBe(false);
  });

  it("keeps the explicit-user predicate service-role only", async () => {
    const args = {
      p_user_id: user.id,
      p_legal_bundle_version: LEGAL_BUNDLE_VERSION,
    };
    const anon = await createAnonClient().rpc("has_accepted_ai_legal_bundle", args);
    expect(anon.error?.code).toBe(PERMISSION_DENIED);

    const authenticated = await authed.rpc("has_accepted_ai_legal_bundle", args);
    expect(authenticated.error?.code).toBe(PERMISSION_DENIED);
  });
});
