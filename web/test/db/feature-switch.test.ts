/**
 * Real-DB tests for the runtime feature switch and allowlist
 * (unit 1.4, plan card 1.4): ai_feature_config is read atomically by every
 * reserve call, so changes must take effect on the NEXT request — no
 * redeploy, no reconnect, no new client.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getPolishQuota } from "@/server/polish/quota";

import {
  configureFeature,
  createServiceClient,
  createTestUser,
  deleteTestUser,
  FEATURE_CONFIG_DEFAULTS,
  RUN_DB_TESTS,
  tryReserve,
  type TestUser,
} from "./helpers";

describe.skipIf(!RUN_DB_TESTS)("runtime feature switch & allowlist (real DB)", () => {
  let service: SupabaseClient;
  const users: TestUser[] = [];

  beforeAll(async () => {
    service = createServiceClient();
  });

  async function makeUser(label: string): Promise<TestUser> {
    const user = await createTestUser(service, label);
    users.push(user);
    return user;
  }

  afterAll(async () => {
    await configureFeature(service, { ...FEATURE_CONFIG_DEFAULTS });
    for (const user of users) {
      await deleteTestUser(service, user.id);
    }
  });

  it("denies reserves with AI_DISABLED while the kill switch is off", async () => {
    const user = await makeUser("switch-off");
    await configureFeature(service, {
      enabled: false,
      globalDailyLimit: 2000,
      allowlist: [],
    });

    const outcome = await tryReserve(service, user.id);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe("AI_DISABLED");
    expect(!outcome.ok && outcome.error.httpStatus).toBe(503);
  });

  it("applies kill-switch flips immediately, on the same client", async () => {
    const user = await makeUser("switch-flip");
    await configureFeature(service, { enabled: false, allowlist: [] });

    // Same client, no reconnect: every reserve re-reads the config row.
    expect((await tryReserve(service, user.id)).ok).toBe(false);

    await configureFeature(service, { enabled: true });
    const enabled = await tryReserve(service, user.id);
    expect(enabled.ok).toBe(true);

    await configureFeature(service, { enabled: false });
    const disabled = await tryReserve(service, user.id);
    expect(disabled.ok).toBe(false);
    expect(!disabled.ok && disabled.error.code).toBe("AI_DISABLED");

    await configureFeature(service, { enabled: true });
    expect((await tryReserve(service, user.id)).ok).toBe(true);
  });

  it("enforces the gradual-rollout allowlist", async () => {
    const allowed = await makeUser("allowlisted");
    const outsider = await makeUser("not-allowlisted");
    await configureFeature(service, {
      enabled: true,
      allowlist: [allowed.id],
    });

    const inList = await tryReserve(service, allowed.id);
    expect(inList.ok).toBe(true);

    const outList = await tryReserve(service, outsider.id);
    expect(outList.ok).toBe(false);
    expect(!outList.ok && outList.error.code).toBe("AI_DISABLED");
    expect(!outList.ok && outList.error.message).toContain("not enabled for this account");

    // Empty allowlist = no restriction.
    await configureFeature(service, { allowlist: [] });
    expect((await tryReserve(service, outsider.id)).ok).toBe(true);
  });

  it("reports remaining quota through get_ai_polish_quota", async () => {
    const user = await makeUser("quota-read");
    await configureFeature(service, {
      enabled: true,
      globalDailyLimit: 2000,
      allowlist: [],
    });

    const before = await getPolishQuota(service, user.id);
    expect(before).toMatchObject({ limit: 20, remaining: 20 });
    expect(before.resetAt).toBeTruthy();

    const outcome = await tryReserve(service, user.id);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.remaining).toBe(19);

    const after = await getPolishQuota(service, user.id);
    expect(after.remaining).toBe(19);
  });
});
