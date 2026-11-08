import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureLocalBootstrap } from "./fixtures";
const url = process.env.SUPABASE_TEST_URL!;
if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname) || new URL(url).protocol !== "http:") throw new Error("Admin session tests require explicit HTTP loopback");
const publishable = process.env.SUPABASE_TEST_PUBLISHABLE_KEY!;
const owner = createClient(url, process.env.SUPABASE_TEST_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const ids: string[] = [];
let administrator: SupabaseClient;
let ordinary: SupabaseClient;
let ordinaryId: string;
let administratorToken: string;
let guard: { contract_code: string; database_instance_id: string };
let grantedMember: { entity_id: string; revision: string };
function localSql(statement: string) { execFileSync("docker", ["exec", "-i", "supabase_db_typst-cv-template", "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { input: statement, stdio: ["pipe", "pipe", "pipe"] }); }
async function passwordAccount() {
  const email = `session-admin-${crypto.randomUUID()}@example.test`;
  const password = `Local-${crypto.randomUUID()}!`;
  const created = await owner.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  ids.push(created.data.user.id);
  const client = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error) throw signed.error;
  return { client, id: created.data.user.id, token: signed.data.session!.access_token };
}
const operation = (extra: Record<string, unknown>) => ({ ...guard, operation_key: crypto.randomUUID(), reason: "Real password-session authorization regression", ...extra });
beforeAll(async () => {
  ensureLocalBootstrap();
  const a = await passwordAccount();
  const b = await passwordAccount();
  administrator = a.client; administratorToken = a.token; ordinary = b.client; ordinaryId = b.id;
  if (!/^[0-9a-f-]{36}$/i.test(a.id)) throw new Error("Invalid local fixture identity");
  // Owner grants only the newly-created test account; no existing membership is changed.
  localSql(`select common.audit_context(null,null,'Local password-session API fixture','SYSTEM');insert into admin.members(auth_user_id) values('${a.id}');`);
  const context = await administrator.rpc("app_context");
  if (context.error) throw context.error;
  guard = { contract_code: context.data.contract_code, database_instance_id: context.data.database_instance_id };
});
afterAll(async () => {
  if (ids.length) {
    if (ids.some(id => !/^[0-9a-f-]{36}$/i.test(id))) throw new Error("Invalid local fixture identity");
    localSql(`select common.audit_context(null,null,'Remove only this test membership','SYSTEM');delete from admin.members where auth_user_id in (${ids.map(id => `'${id}'::uuid`).join(",")});`);
  }
  for (const id of ids) {
    const removed = await owner.auth.admin.deleteUser(id);
    if (removed.error) throw removed.error;
  }
});
describe("Admin authorization without an extra authentication tier", () => {
  it("allows a genuine password AAL1 session to commit an audited Admin write while ordinary and anonymous accounts are refused", async () => {
    // This token was returned by real local GoTrue password sign-in, never synthesized.
    const claims = JSON.parse(Buffer.from(administratorToken.split(".")[1], "base64url").toString("utf8")) as { aal: string };
    expect(claims.aal).toBe("aal1");
    const payload = operation({ auth_user_id: ordinaryId, expected_revision: null });
    expect((await ordinary.rpc("admin_member_grant", { p_input: payload })).error).toMatchObject({ message: "FORBIDDEN", details: "ADMIN_REQUIRED" });
    const anonymous = createClient(url, publishable, { auth: { persistSession: false } });
    expect((await anonymous.rpc("admin_member_grant", { p_input: payload })).error).not.toBeNull();
    const granted = await administrator.rpc("admin_member_grant", { p_input: payload });
    expect(granted.error).toBeNull();
    expect(granted.data).toMatchObject({ operation: "member_grant", entity_kind: "members", revision: "1" });
    grantedMember = granted.data;
    expect((await ordinary.rpc("admin_context")).error).toBeNull();
  });
  it("refuses a revoked administrator even though the original account and signed-in session remain valid", async () => {
    const revoked = await administrator.rpc("admin_member_revoke", { p_input: operation({ id: grantedMember.entity_id, expected_revision: grantedMember.revision }) });
    expect(revoked.error).toBeNull();
    expect((await ordinary.auth.getUser()).error).toBeNull();
    expect((await ordinary.rpc("admin_context")).error).toMatchObject({ message: "FORBIDDEN", details: "ADMIN_REQUIRED" });
    expect((await ordinary.rpc("admin_member_grant", { p_input: operation({ auth_user_id: ordinaryId, expected_revision: "2" }) })).error).toMatchObject({ message: "FORBIDDEN", details: "ADMIN_REQUIRED" });
  });
  it("rejects a signed JWT after its live Auth session is revoked", async () => {
    expect((await administrator.auth.signOut({ scope: "local" })).error).toBeNull();
    const response = await fetch(`${url}/rest/v1/rpc/admin_context`, { method: "POST", headers: { apikey: publishable, Authorization: `Bearer ${administratorToken}`, "Content-Type": "application/json" }, body: "{}" });
    expect(await response.json()).toMatchObject({ message: "UNAUTHORIZED", details: "SESSION_EXPIRED" });
  });
});
