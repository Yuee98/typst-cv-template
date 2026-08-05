/** Real-DB proof that the ledger constraint matches the shared wire enum. */

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createServiceClient,
  createTestUser,
  deleteTestUser,
  RUN_DB_TESTS,
  type TestUser,
} from "./helpers";

describe.skipIf(!RUN_DB_TESTS)("AI ledger granularity constraint (real DB)", () => {
  let service: SupabaseClient;
  let user: TestUser;

  beforeAll(async () => {
    service = createServiceClient();
    user = await createTestUser(service, "group-granularity");
  });

  afterAll(async () => {
    await deleteTestUser(service, user.id);
  });

  it("accepts company-level group metadata", async () => {
    const { error } = await service.from("ai_request_ledger").insert({
      request_id: crypto.randomUUID(),
      client_request_id: crypto.randomUUID(),
      user_id: user.id,
      granularity: "group",
    });

    expect(error).toBeNull();
  });

  it("continues to reject values outside the shared enum", async () => {
    const { error } = await service.from("ai_request_ledger").insert({
      request_id: crypto.randomUUID(),
      client_request_id: crypto.randomUUID(),
      user_id: user.id,
      granularity: "company",
    });

    expect(error?.code).toBe("23514");
  });
});
