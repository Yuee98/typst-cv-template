import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminContextSchema, adminPageSchema } from "@/lib/admin/contract";
import { createAdminRequestClient } from "@/server/admin/request-client";
import { handleAdminGet } from "@/server/admin/handler";
import { createAnonClient, createServiceClient, createTestUser, DB_TEST_ENV, deleteTestUser, RUN_DB_TESTS, signInAsUser, type TestUser } from "./helpers";
import { runOwnerSql } from "./runtime-contract-fixtures";

const base = { p_environment: "local", p_project_ref: "local" };
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

describe.skipIf(!RUN_DB_TESTS)("Admin read foundation with real Auth sessions", () => {
  let service: SupabaseClient;
  let admin: SupabaseClient;
  let ordinary: SupabaseClient;
  let adminUser: TestUser;
  let ordinaryUser: TestUser;
  let token: string;
  let sessionId: string;
  let ownsEnvironment = false;

  beforeAll(async () => {
    service = createServiceClient();
    adminUser = await createTestUser(service, "admin-read");
    ordinaryUser = await createTestUser(service, "admin-ordinary");
    admin = await signInAsUser(adminUser);
    ordinary = await signInAsUser(ordinaryUser);
    token = (await admin.auth.getSession()).data.session!.access_token;
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    sessionId = claims.session_id;
    const issuer = new URL(claims.iss);
    if (!["localhost", "127.0.0.1"].includes(issuer.hostname) || issuer.protocol !== "http:") throw new Error("Local Auth issuer required");
    const exists = runOwnerSql("select count(*) from public.admin_environment;").stdout.match(/\n\s*(\d+)\s*\n/)?.[1];
    if (exists !== "0") throw new Error("Admin tests require an uninitialized local Admin environment; never overwrite operator state");
    runOwnerSql(`select public.admin_bootstrap_v1(${literal(adminUser.id)},'local','local',${literal(claims.iss)},'local DB test bootstrap');`);
    ownsEnvironment = true;
  });

  afterAll(async () => {
    if (ownsEnvironment) {
      // Remove only our current membership/identity. Append-only bootstrap
      // audit remains historical and has no cascading Auth FK.
      runOwnerSql(`delete from public.admin_principals where user_id=${literal(adminUser.id)};
        delete from public.admin_environment where environment='local';`);
    }
    if (adminUser) await deleteTestUser(service, adminUser.id);
    if (ordinaryUser) await deleteTestUser(service, ordinaryUser.id);
  });

  it("denies anon, service role and forged metadata; only an existing member reads", async () => {
    for (const client of [createAnonClient(), service, ordinary]) {
      const { error } = await client.rpc("admin_get_context_v1", base);
      expect(error?.code).toBe("42501");
    }
    await ordinary.auth.updateUser({ data: { role: "admin", is_admin: true } });
    expect((await ordinary.rpc("admin_get_context_v1", base)).error?.code).toBe("42501");
    const { data, error } = await admin.rpc("admin_get_context_v1", base);
    expect(error).toBeNull();
    expect(adminContextSchema.parse(data).actor.userId).toBe(adminUser.id);
  });

  it("has no browser or service-role bootstrap, helpers or table privileges", async () => {
    for (const client of [admin, ordinary, service]) {
      expect((await client.rpc("admin_bootstrap_v1", { p_user_id: ordinaryUser.id, ...base, p_auth_issuer: "http://127.0.0.1:54321/auth/v1", p_reason: "forged" })).error?.code).toBe("42501");
      expect((await client.rpc("admin_assert_actor_v1", base)).error?.code).toBe("42501");
      expect((await client.from("admin_principals").select("user_id")).error?.code).toBe("42501");
      expect((await client.from("admin_principals").insert({ user_id: ordinaryUser.id })).error?.code).toBe("42501");
    }
    const duplicate = runOwnerSql(`select public.admin_bootstrap_v1(${literal(ordinaryUser.id)},'local','local','http://127.0.0.1:54321/auth/v1','duplicate');`, { expectFailure: true });
    expect(duplicate.stderr).toContain("already been used");
  });

  it("validates every explicit projection and bounded cursor search", async () => {
    for (const section of ["users", "profiles", "prices", "policies", "audit"]) {
      const { data, error } = await admin.rpc("admin_list_records_v1", { ...base, p_section: section, p_limit: 1 });
      expect(error, section).toBeNull();
      const page = adminPageSchema.parse(data);
      expect(page.items.length).toBeLessThanOrEqual(1);
      if (page.items.length) {
        const detail = await admin.rpc("admin_get_record_v1", { ...base, p_section: section, p_id: page.items[0].id });
        expect(detail.error).toBeNull();
        expect(adminPageSchema.parse(detail.data).items).toEqual(page.items);
      }
      if (page.nextCursor) {
        const next = await admin.rpc("admin_list_records_v1", { ...base, p_section: section, p_limit: 1, p_after: page.nextCursor });
        expect(next.error).toBeNull();
        expect(adminPageSchema.parse(next.data).items[0]?.id).not.toBe(page.items[0]?.id);
      }
    }
    const invalid = await admin.rpc("admin_list_records_v1", { ...base, p_section: "users", p_limit: 101 });
    expect(invalid.error?.code).toBe("22023");
    const searched = await admin.rpc("admin_list_records_v1", { ...base, p_section: "users", p_search: ordinaryUser.email });
    expect(adminPageSchema.parse(searched.data).items.map(row => row.id)).toEqual([ordinaryUser.id]);
  });

  it("verifies actual bearer forwarding through the HTTP handler with AI gate off", async () => {
    const environment = { name: "local" as const, projectRef: "local", supabaseUrl: DB_TEST_ENV!.url, publishableKey: DB_TEST_ENV!.publishableKey };
    const response = await handleAdminGet(new Request("https://web.test/api/admin", { headers: { Authorization: `Bearer ${token}` } }), {
      environment: () => environment, client: createAdminRequestClient,
    });
    expect(response.status).toBe(200);
    expect(adminContextSchema.parse(await response.json()).actor.userId).toBe(adminUser.id);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("rejects environment drift, revoked membership and banned accounts with the old token", async () => {
    expect((await admin.rpc("admin_get_context_v1", { ...base, p_environment: "preview" })).error?.message).toBe("ENVIRONMENT_MISMATCH");
    runOwnerSql(`update public.admin_principals set revoked_at=clock_timestamp(),revision=revision+1 where user_id=${literal(adminUser.id)};`);
    expect((await admin.rpc("admin_get_context_v1", base)).error?.code).toBe("42501");
    runOwnerSql(`update public.admin_principals set revoked_at=null,revision=revision+1 where user_id=${literal(adminUser.id)};
      update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=${literal(adminUser.id)};`);
    expect((await admin.rpc("admin_get_context_v1", base)).error?.code).toBe("42501");
    runOwnerSql(`update auth.users set banned_until=null where id=${literal(adminUser.id)};`);
    expect((await admin.rpc("admin_get_context_v1", base)).error).toBeNull();
  });

  it("prevents Auth deletion cascading away membership and preserves append-only audit", () => {
    expect(runOwnerSql(`delete from auth.users where id=${literal(adminUser.id)};`, { expectFailure: true }).stderr).toContain("foreign key");
    expect(runOwnerSql("delete from public.admin_audit_events;", { expectFailure: true }).stderr).toContain("append-only");
  });

  it("rejects a no-longer-live session even if its signed JWT has not expired", async () => {
    runOwnerSql(`delete from auth.sessions where id=${literal(sessionId)} and user_id=${literal(adminUser.id)};`);
    expect((await admin.rpc("admin_get_context_v1", base)).error?.code).toBe("42501");
  });
});
