import { isDeepStrictEqual } from "node:util";
import { cvSchema } from "../web/src/lib/cv/schema.ts";
import { jsonQuery, migrationManifest } from "./db-common.ts";
export function checkContract(local?: boolean, query: typeof jsonQuery = jsonQuery) {
  const result = query(`select jsonb_build_object(
    'tables',(select coalesce(jsonb_agg(n.nspname||'.'||c.relname order by n.nspname,c.relname),'[]') from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname in ('cv','ai','legal','admin','audit') and c.relkind='r'),
    'unstructured_columns',(select coalesce(jsonb_agg(table_schema||'.'||table_name||'.'||column_name),'[]') from information_schema.columns where table_schema in ('ai','legal','audit') and data_type in ('json','jsonb')),
    'unprotected',(select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname in ('cv','ai','legal','admin','audit') and c.relkind='r' and not c.relrowsecurity),
    'public_tables',(select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'),
    'unsafe_functions',(select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname in ('common','cv','ai','legal','admin','audit','public') and p.prokind='f' and p.proconfig is distinct from array['search_path=""'] and not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')),
    'bad_owner',(select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and p.proowner <> 'app_api_owner'::regrole),
    'privileged_owner',(select rolsuper or rolbypassrls or rolcanlogin or rolinherit or rolcreaterole or rolcreatedb or rolreplication from pg_catalog.pg_roles where rolname='app_api_owner'),
    'api_owner_members',(select count(*) from pg_catalog.pg_roles r where r.rolname in ('anon','authenticated','service_role','authenticator') and pg_catalog.pg_has_role(r.oid,'app_api_owner'::regrole,'MEMBER')),
    'owner_outgoing_roles',(select count(*) from pg_catalog.pg_auth_members where member='app_api_owner'::regrole),
    'owner_platform_column_access',(select count(*) from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid=a.attrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname in ('auth','storage') and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped and pg_catalog.has_column_privilege('app_api_owner',c.oid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES')),
    'public_execute',(select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a where n.nspname in ('common','cv','ai','legal','admin','audit','public') and a.grantee=0 and a.privilege_type='EXECUTE' and not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')),
    'api_table_writes',(select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace cross join pg_catalog.pg_roles r where n.nspname in ('cv','ai','legal','admin','audit') and c.relkind in ('r','p') and r.rolname in ('anon','authenticated','service_role') and pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
    'cv_schema',common.cv_schema(),
    'context',public.app_context(),
    'history',(select coalesce(jsonb_agg(version order by version),'[]') from supabase_migrations.schema_migrations)
  );`, local);
  const required = ["cv.documents", "ai.adapters", "ai.configurations", "ai.prices", "ai.routing_rules", "ai.routing_rule_configurations", "ai.runtime_control", "ai.allowed_users", "ai.requests", "ai.request_snapshots", "ai.attempts", "ai.user_quota_daily", "ai.global_quota_daily", "ai.rate_minutes", "ai.configuration_usage_daily", "legal.documents", "legal.acceptances", "admin.environment", "admin.members", "admin.operations", ...["configurations", "prices", "rules", "rule_members", "runtime_control", "allowed_users", "documents", "acceptances", "members", "environment"].map(name => `audit.${name}`)];
  const retired = ["ai.capabilities", "ai.providers", "ai.profiles", "ai.profile_versions", "ai.price_versions", "ai.price_components", "ai.policies", "ai.policy_versions", "ai.policy_options", "legal.bundles", "legal.disclosures", "legal.document_versions", "legal.current_state", "admin.validations", "admin.readbacks", "audit.events"];
  if (!Array.isArray(result.tables) || required.some(name => !result.tables.includes(name)) || retired.some(name => result.tables.includes(name)) || result.unstructured_columns.length || result.unprotected || result.public_tables || result.unsafe_functions || result.bad_owner || result.api_owner_members || result.owner_outgoing_roles || result.owner_platform_column_access || result.public_execute || result.api_table_writes || result.privileged_owner !== false) throw new Error("Database catalog violates current contract");
  if (result.context.contract_code !== "cv_app_db_2") throw new Error("Unexpected database contract");
  if (!isDeepStrictEqual(result.cv_schema, cvSchema.toJSONSchema())) throw new Error("Database and client CV schemas differ");
  delete result.cv_schema;
  const manifest = migrationManifest();
  if (JSON.stringify(result.history) !== JSON.stringify(manifest.files.map(entry => entry.name.split("_")[0]))) throw new Error("Migration history differs from checkout");
  return {
    ...result,
    ...manifest
  };
}
if (import.meta.main) console.log(JSON.stringify(checkContract(process.argv.includes("--local"))));
