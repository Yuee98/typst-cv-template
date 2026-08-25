/**
 * Real-DB RLS tests for legal terms acceptance (unit 1.4, plan card 1.4):
 *   - ai_terms rows are readable/writable only by their owner;
 *   - the ai_terms and terms insert policies do not cross: each document_key
 *     accepts only its own current version;
 *   - the pre-existing terms flow (accept -> query -> cv_documents gate) is
 *     not regressed by the generic legal-acceptance refactor;
 *   - anon has no access at all.
 *
 * Exercises the production helpers (src/lib/legal/terms-acceptance.ts) with
 * real signed-in user clients, plus raw table probes for the attack cases.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AI_TERMS_VERSION, TERMS_VERSION } from "@/content/legal";
import {
  acceptCurrentAiTerms,
  acceptCurrentTerms,
  hasAcceptedCurrentAiTerms,
  hasAcceptedCurrentTerms,
} from "@/lib/legal/terms-acceptance";

import {
  createAnonClient,
  createServiceClient,
  createTestUser,
  deleteTestUser,
  RUN_DB_TESTS,
  signInAsUser,
  type TestUser,
} from "./helpers";

const PERMISSION_DENIED = "42501";

describe.skipIf(!RUN_DB_TESTS)("terms & ai_terms RLS (real DB)", () => {
  let service: SupabaseClient;
  let userA: TestUser;
  let userB: TestUser;
  let clientA: SupabaseClient;
  let clientB: SupabaseClient;

  beforeAll(async () => {
    service = createServiceClient();
    userA = await createTestUser(service, "terms-a");
    userB = await createTestUser(service, "terms-b");
    clientA = await signInAsUser(userA);
    clientB = await signInAsUser(userB);
  });

  afterAll(async () => {
    await deleteTestUser(service, userA.id);
    await deleteTestUser(service, userB.id);
  });

  it("runs the original terms flow end-to-end (accept + query + version RPC)", async () => {
    expect(await hasAcceptedCurrentTerms(clientA)).toBe(false);

    const { data: version, error: versionError } = await clientA.rpc(
      "current_terms_version",
    );
    expect(versionError).toBeNull();
    expect(version).toBe(TERMS_VERSION);

    await acceptCurrentTerms(clientA);
    expect(await hasAcceptedCurrentTerms(clientA)).toBe(true);

    const { data, error } = await clientA.rpc("has_accepted_current_terms");
    expect(error).toBeNull();
    expect(data).toBe(true);

    // Accepting again is a harmless no-op (ignoreDuplicates upsert).
    await acceptCurrentTerms(clientA);
  });

  it("accepts and queries ai_terms independently of terms", async () => {
    expect(await hasAcceptedCurrentAiTerms(clientA)).toBe(false);

    const { data: version, error: versionError } = await clientA.rpc(
      "current_ai_terms_version",
    );
    expect(versionError).toBeNull();
    expect(version).toBe(AI_TERMS_VERSION);

    await acceptCurrentAiTerms(clientA, userA.id);
    expect(await hasAcceptedCurrentAiTerms(clientA)).toBe(true);

    const { data, error } = await clientA.rpc("has_accepted_current_ai_terms");
    expect(error).toBeNull();
    expect(data).toBe(true);

    // terms acceptance is untouched by the ai_terms flow.
    expect(await hasAcceptedCurrentTerms(clientA)).toBe(true);
  });

  it("refuses an AI acceptance whose expected owner differs from the session", async () => {
    await expect(
      acceptCurrentAiTerms(clientB, userA.id),
    ).rejects.toThrow("Authenticated user changed");
    expect(await hasAcceptedCurrentAiTerms(clientB)).toBe(false);
  });

  it("lets users read only their own acceptance rows", async () => {
    const { data: ownRows, error: ownError } = await clientA
      .from("user_terms_acceptances")
      .select("document_key,version,user_id");
    expect(ownError).toBeNull();
    expect(ownRows).toHaveLength(2);
    for (const row of ownRows ?? []) {
      expect(row.user_id).toBe(userA.id);
    }
    expect(ownRows?.map((r) => r.document_key).sort()).toEqual([
      "ai_terms",
      "terms",
    ]);

    // B accepted nothing: sees zero rows even though A's rows exist.
    const { data: otherRows, error: otherError } = await clientB
      .from("user_terms_acceptances")
      .select("*");
    expect(otherError).toBeNull();
    expect(otherRows).toEqual([]);
    expect(await hasAcceptedCurrentAiTerms(clientB)).toBe(false);

    // service_role (server-side reporting path) sees everything.
    const { data: allRows } = await service
      .from("user_terms_acceptances")
      .select("user_id")
      .eq("user_id", userA.id);
    expect(allRows?.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects inserting an acceptance for another user", async () => {
    const { error } = await clientA.from("user_terms_acceptances").insert({
      user_id: userB.id,
      document_key: "ai_terms",
      version: AI_TERMS_VERSION,
    });
    expect(error?.code).toBe(PERMISSION_DENIED);

    // And B must not be able to write A's row either.
    const { error: reverse } = await clientB
      .from("user_terms_acceptances")
      .insert({
        user_id: userA.id,
        document_key: "terms",
        version: TERMS_VERSION,
      });
    expect(reverse?.code).toBe(PERMISSION_DENIED);
  });

  it("rejects cross-document version writes (key and version cannot be mixed)", async () => {
    // ai_terms with the terms version matches neither insert policy.
    const { error: crossedAi } = await clientA
      .from("user_terms_acceptances")
      .insert({ document_key: "ai_terms", version: TERMS_VERSION });
    expect(crossedAi?.code).toBe(PERMISSION_DENIED);

    // terms with the ai_terms version: same.
    const { error: crossedTerms } = await clientA
      .from("user_terms_acceptances")
      .insert({ document_key: "terms", version: AI_TERMS_VERSION });
    expect(crossedTerms?.code).toBe(PERMISSION_DENIED);

    // A made-up future version is rejected for both documents.
    const { error: future } = await clientA
      .from("user_terms_acceptances")
      .insert({ document_key: "ai_terms", version: "2099-01-01" });
    expect(future?.code).toBe(PERMISSION_DENIED);
  });

  it("keeps cv_documents gated behind terms acceptance", async () => {
    const userC = await createTestUser(service, "terms-c");
    const clientC = await signInAsUser(userC);
    try {
      // No terms accepted yet -> the insert policy denies the write.
      const { error: denied } = await clientC.from("cv_documents").insert({
        title: "My CV",
        storage_mode: "plain",
        data: {},
      });
      expect(denied?.code).toBe(PERMISSION_DENIED);

      await acceptCurrentTerms(clientC);

      const { error: allowed } = await clientC.from("cv_documents").insert({
        title: "My CV",
        storage_mode: "plain",
        data: {},
      });
      expect(allowed).toBeNull();

      const { data: docs, error: readError } = await clientC
        .from("cv_documents")
        .select("title");
      expect(readError).toBeNull();
      expect(docs).toHaveLength(1);
    } finally {
      await deleteTestUser(service, userC.id);
    }
  });

  it("denies the anon role everywhere", async () => {
    const anon = createAnonClient();

    const { error: selectError } = await anon
      .from("user_terms_acceptances")
      .select("*");
    expect(selectError?.code).toBe(PERMISSION_DENIED);

    const { error: insertError } = await anon
      .from("user_terms_acceptances")
      .insert({ document_key: "terms", version: TERMS_VERSION });
    expect(insertError?.code).toBe(PERMISSION_DENIED);

    const { error: rpcError } = await anon.rpc("has_accepted_current_terms");
    expect(rpcError?.code).toBe(PERMISSION_DENIED);

    const { error: aiRpcError } = await anon.rpc(
      "has_accepted_current_ai_terms",
    );
    expect(aiRpcError?.code).toBe(PERMISSION_DENIED);

    const { error: versionError } = await anon.rpc("current_ai_terms_version");
    expect(versionError?.code).toBe(PERMISSION_DENIED);
  });
});
