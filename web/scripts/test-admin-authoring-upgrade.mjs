// Run on the disposable PR41 predecessor before applying the next migration.
// All scenarios, including candidate DDL, roll back.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const container = process.env.ADMIN_AUTHORING_UPGRADE_CONTAINER ?? "supabase_db_typst-cv-template";
if (!["supabase_db_typst-cv-template", "supabase_db_typst-cv-authoring-review"].includes(container)) {
  throw new Error("Requires the owned local predecessor fixture");
}
const migration = readFileSync(new URL("../../supabase/migrations/20260910120000_admin_authoring_ui.sql", import.meta.url), "utf8");
if ((migration.match(/^begin;$/gm) ?? []).length !== 1 || (migration.match(/^commit;$/gm) ?? []).length !== 1) {
  throw new Error("Upgrade harness requires one outer transaction");
}
const body = migration.replace(/^begin;$/m, "").replace(/^commit;$/m, "");
function owner(sql) {
  const result = spawnSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "--set", "ON_ERROR_STOP=1", "--no-psqlrc"], {
    input: sql, encoding: "utf8", timeout: 60_000, maxBuffer: 4_000_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || "Local owner SQL failed");
  return result.stdout;
}
const changed = "'__none__'";
const added = "'admin_create_provider_v1','admin_authoring_options_v1'";
const state = `select jsonb_build_object(
  'definitions',(select jsonb_agg(pg_catalog.pg_get_functiondef(proc.oid) order by proc.oid)
    from pg_catalog.pg_proc proc join pg_catalog.pg_namespace ns on ns.oid=proc.pronamespace
    where ns.nspname='public' and proc.prokind='f' and proc.proname not in (${changed},${added})),
  'functionAcls',(select jsonb_agg(jsonb_build_object('oid',proc.oid,'owner',proc.proowner,'acl',proc.proacl::text) order by proc.oid)
    from pg_catalog.pg_proc proc join pg_catalog.pg_namespace ns on ns.oid=proc.pronamespace
    where ns.nspname='public' and proc.proname not in (${added})),
  'tableAcls',(select jsonb_agg(jsonb_build_object('oid',rel.oid,'acl',rel.relacl::text) order by rel.oid)
    from pg_catalog.pg_class rel join pg_catalog.pg_namespace ns on ns.oid=rel.relnamespace where ns.nspname='public'),
  'columnAcls',(select jsonb_agg(jsonb_build_object('rel',att.attrelid,'number',att.attnum,'acl',att.attacl::text) order by att.attrelid,att.attnum)
    from pg_catalog.pg_attribute att join pg_catalog.pg_class rel on rel.oid=att.attrelid
    join pg_catalog.pg_namespace ns on ns.oid=rel.relnamespace where ns.nspname='public'),
  'expected',(select jsonb_agg(to_jsonb(t) order by signature) from public.admin_runtime_authority_expected_v3 t),
  'receipts',(select jsonb_agg(to_jsonb(t) order by receipt_id) from public.admin_runtime_authority_receipts_v3 t),
  'environment',(select jsonb_agg(to_jsonb(t)) from public.admin_environment t),
  'members',(select jsonb_agg(to_jsonb(t) order by user_id) from public.admin_principals t),
  'features',(select jsonb_agg(to_jsonb(t)) from public.ai_feature_config t),
  'control',(select jsonb_agg(to_jsonb(t)) from public.admin_ai_control_state_v1 t),
  'audit',(select jsonb_agg(to_jsonb(t) order by id) from public.admin_audit_events t),
  'profiles',(select jsonb_agg(to_jsonb(t) order by id) from public.ai_provider_profile_versions t),
  'prices',(select jsonb_agg(to_jsonb(t) order by id) from public.ai_price_versions t),
  'policies',(select jsonb_agg(to_jsonb(t) order by id) from public.ai_routing_policy_versions t)
) as value`;
owner(`do $$ begin
  if to_regprocedure('public.admin_bootstrap_v2(uuid,text,text)') is null
    or to_regprocedure('public.admin_create_routing_policy_draft_v1(text,text,text,integer,jsonb,uuid,text,text,text,uuid)') is null
    or to_regprocedure('public.admin_create_provider_v1(text,text,text,text,text,text,text,text,text,text,text,uuid)') is not null
    or exists(select 1 from public.admin_environment) or exists(select 1 from public.admin_principals) then
    raise exception 'Requires an uninitialized local PR41 predecessor; never overwrite operator state';
  end if;
end; $$;`);
const baseline = owner(`set search_path=''; ${state};`);
for (const mode of ["uninitialized", "legacy-ai-on", "jwt"]) {
  const user = randomUUID();
  owner(`begin;
    set local search_path='';
    insert into auth.users(id,aud,role,email,email_confirmed_at,is_anonymous)
      values('${user}','authenticated','authenticated','draft-upgrade-${user}@example.test',clock_timestamp(),false);
    ${mode === "uninitialized" ? "" : `select public.admin_bootstrap_v2('${user}','local','draft upgrade predecessor');`}
    ${mode === "legacy-ai-on" ? "update public.ai_feature_config set ai_polish_enabled=true where id=true;" : ""}
    ${mode === "jwt" ? `select public.admin_cutover_authority_v3('{}'::uuid[],0,0,'draft upgrade predecessor cutover');
      select public.admin_assert_runtime_authority_receipt_v3('local',null);` : ""}
    create temporary table before_migration as ${state};
    ${body}
    do $verify$ begin
      if (select value from before_migration) is distinct from (${state}) then
        raise exception 'Draft migration changed runtime authority or business state';
      end if;
      if not pg_catalog.has_function_privilege('authenticated','public.admin_create_provider_v1(text,text,text,text,text,text,text,text,text,text,text,uuid)','EXECUTE')
        or pg_catalog.has_function_privilege('anon','public.admin_create_provider_v1(text,text,text,text,text,text,text,text,text,text,text,uuid)','EXECUTE')
        or pg_catalog.has_function_privilege('service_role','public.admin_create_provider_v1(text,text,text,text,text,text,text,text,text,text,text,uuid)','EXECUTE') then
        raise exception 'Unexpected draft RPC grants';
      end if;
    end; $verify$;
    ${mode === "jwt" ? "select public.admin_assert_runtime_authority_receipt_v3('local',null);" : ""}
    rollback;
  `);
  if (owner(`set search_path=''; ${state};`) !== baseline) throw new Error("Rollback did not restore predecessor");
  console.log(`Admin authoring upgrade: ${mode} passed (authority unchanged, rolled back)`);
}
