import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
export const E2E_USERS = { admin: { email: "admin-e2e-admin@example.test", password: "AdminE2E!local-2026" }, ordinary: { email: "admin-e2e-ordinary@example.test", password: "OrdinaryE2E!local-2026" } };
const bootstrap = { email: "admin-e2e-bootstrap@example.test", password: "BootstrapE2E!local-2026" };
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
function requireLocal(url) { if (url !== "http://127.0.0.1:54321") throw new Error("Admin E2E refuses non-local Supabase"); }
function ownerSql(statement) {
  const result = spawnSync("docker", ["exec", "-i", "supabase_db_typst-cv-template", "psql", "-U", "postgres", "-d", "postgres", "--set", "ON_ERROR_STOP=1", "--no-psqlrc", "-Atq"], { input: statement, encoding: "utf8", timeout: 60000 });
  if (result.status !== 0) throw new Error(result.stderr || "Local fixture SQL failed");
  return result.stdout.trim();
}
function serviceClient(url, secretKey) { requireLocal(url); if (!secretKey) throw new Error("Missing local service credential"); return createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } }); }
async function removeFixtureUsers(service) {
  const { data, error } = await service.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  const users = data.users.filter(user => Object.values(E2E_USERS).some(spec => spec.email === user.email));
  if (!users.length) return;
  const ids = `array[${users.map(user => `${literal(user.id)}::uuid`).join(",")}]`;
  ownerSql(`begin;
    create temporary table fixture_configuration_ids on commit drop as select entity_id id from admin.operations where actor_auth_user_id=any(${ids}) and entity_kind='configurations';
    create temporary table fixture_rule_ids on commit drop as select entity_id id from admin.operations where actor_auth_user_id=any(${ids}) and entity_kind='rules';
    create temporary table fixture_document_ids on commit drop as select entity_id id from admin.operations where actor_auth_user_id=any(${ids}) and entity_kind='documents';
    delete from ai.routing_rule_configurations where rule_id in(select id from fixture_rule_ids);
    delete from ai.routing_rules where id in(select id from fixture_rule_ids);
    delete from ai.prices where config_id in(select id from fixture_configuration_ids);
    delete from ai.configurations where id in(select id from fixture_configuration_ids);
    delete from legal.documents where id in(select id from fixture_document_ids);
    delete from admin.members where auth_user_id=any(${ids});
    set constraints all immediate;
    alter table audit.configurations disable trigger immutable_history;
    alter table audit.prices disable trigger immutable_history;
    alter table audit.rules disable trigger immutable_history;
    alter table audit.rule_members disable trigger immutable_history;
    alter table audit.runtime_control disable trigger immutable_history;
    alter table audit.members disable trigger immutable_history;
    alter table audit.documents disable trigger immutable_history;
    delete from audit.configurations where actor_auth_user_id=any(${ids}) or id in(select id from fixture_configuration_ids);
    delete from audit.prices where actor_auth_user_id=any(${ids}) or config_id in(select id from fixture_configuration_ids);
    delete from audit.rules where actor_auth_user_id=any(${ids}) or id in(select id from fixture_rule_ids);
    delete from audit.rule_members where actor_auth_user_id=any(${ids}) or rule_id in(select id from fixture_rule_ids);
    delete from audit.runtime_control where actor_auth_user_id=any(${ids});
    delete from audit.members where actor_auth_user_id=any(${ids}) or auth_user_id=any(${ids});
    delete from audit.documents where id in(select id from fixture_document_ids);
    delete from admin.operations where actor_auth_user_id=any(${ids});
    alter table audit.configurations enable trigger immutable_history;
    alter table audit.prices enable trigger immutable_history;
    alter table audit.rules enable trigger immutable_history;
    alter table audit.rule_members enable trigger immutable_history;
    alter table audit.runtime_control enable trigger immutable_history;
    alter table audit.members enable trigger immutable_history;
    alter table audit.documents enable trigger immutable_history;
    commit;`);
  for (const user of users) { const { error } = await service.auth.admin.deleteUser(user.id); if (error) throw error; }
}
export async function setupAdminE2e({ url, secretKey }) {
  const service = serviceClient(url, secretKey);
  await removeFixtureUsers(service);
  const users = {};
  for (const [name, spec] of Object.entries(E2E_USERS)) { const { data, error } = await service.auth.admin.createUser({ ...spec, email_confirm: true }); if (error || !data.user) throw error ?? new Error("Fixture account unavailable"); users[name] = data.user; }
  // A separate bootstrap survives teardown. The users under test are always
  // temporary members, including on a freshly rebuilt local database.
  const existing = ownerSql("select coalesce((select contract_code from admin.environment where id=1),'UNINITIALIZED');");
  let bootstrapId = users.admin.id;
  if (existing === "UNINITIALIZED") {
    const { data: listed, error: listError } = await service.auth.admin.listUsers({ perPage: 1000 });
    if (listError) throw listError;
    let first = listed.users.find(user => user.email === bootstrap.email);
    if (!first) { const { data, error } = await service.auth.admin.createUser({ ...bootstrap, email_confirm: true }); if (error || !data.user) throw error ?? new Error("Local bootstrap unavailable"); first = data.user; }
    bootstrapId = first.id;
  } else if (existing !== "cv_app_db_2") throw new Error("Local fixture contract mismatch");
  ownerSql(`do $fixture$ begin
    if not exists(select 1 from admin.environment) then perform admin.initialize('LOCAL',${literal(bootstrapId)}::uuid);
    elsif exists(select 1 from admin.environment where name<>'LOCAL' or contract_code<>'cv_app_db_2') then raise exception 'Local fixture environment mismatch'; end if;
    perform common.audit_context(null,null,'Local Admin browser fixture','SYSTEM');
    insert into admin.members(auth_user_id) values(${literal(users.admin.id)}::uuid);
    if (select enabled from ai.runtime_control where id=1) then raise exception 'Admin E2E requires AI disabled'; end if;
    end $fixture$;`);
}
export async function cleanupAdminE2e({ url, secretKey }) { await removeFixtureUsers(serviceClient(url, secretKey)); }
