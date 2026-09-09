// Run against the disposable local predecessor schema before migration up.
// Every scenario rolls back, including the candidate migration's DDL.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const migration = readFileSync(new URL("../../supabase/migrations/20260909110000_simplify_admin_bootstrap.sql", import.meta.url), "utf8");
if ((migration.match(/^begin;$/gm) ?? []).length !== 1 || (migration.match(/^commit;$/gm) ?? []).length !== 1) {
  throw new Error("Upgrade harness requires exactly one outer migration transaction");
}
const body = migration.replace(/^begin;$/m, "").replace(/^commit;$/m, "");
function owner(sql) {
  return spawnSync("docker", ["exec", "-i", "supabase_db_typst-cv-template", "psql", "-U", "postgres", "-d", "postgres", "--set", "ON_ERROR_STOP=1", "--no-psqlrc"], {
    input: sql, encoding: "utf8", timeout: 60_000, maxBuffer: 2_000_000,
  });
}
function succeeds(sql) {
  const result = owner(sql);
  if (result.status !== 0) throw new Error(result.stderr || "Local owner SQL failed");
}
const predecessor = `do $$ begin
  if to_regprocedure('public.admin_bootstrap_v1(uuid,text,text,text,text)') is null
    or to_regprocedure('public.admin_bootstrap_v2(uuid,text,text)') is not null
    or exists(select 1 from public.admin_environment)
    or exists(select 1 from public.admin_principals) then
    raise exception 'Requires an uninitialized local predecessor; never overwrite operator state';
  end if;
end; $$;`;
function snapshot() {
  const result = owner(`select jsonb_build_object(
    'expected',(select jsonb_agg(to_jsonb(t) order by signature) from public.admin_runtime_authority_expected_v3 t),
    'receipts',(select jsonb_agg(to_jsonb(t) order by receipt_id) from public.admin_runtime_authority_receipts_v3 t),
    'environment',(select jsonb_agg(to_jsonb(t)) from public.admin_environment t),
    'members',(select jsonb_agg(to_jsonb(t) order by user_id) from public.admin_principals t),
    'features',(select jsonb_agg(to_jsonb(t)) from public.ai_feature_config t),
    'control',(select jsonb_agg(to_jsonb(t)) from public.admin_ai_control_state_v1 t),
    'audit',(select jsonb_agg(to_jsonb(t) order by id) from public.admin_audit_events t),
    'verifiers',(select jsonb_agg(jsonb_build_object('definition',pg_get_functiondef(oid),'acl',proacl::text) order by proname)
      from pg_proc where oid=any(array[
        'public.admin_assert_runtime_authority_receipt_v3(text,text)'::regprocedure,
        'public.admin_current_runtime_authority_manifest_v3()'::regprocedure,
        'public.admin_assert_reason_v1(text)'::regprocedure]::oid[]))
  );`);
  if (result.status !== 0) throw new Error(result.stderr || "Snapshot failed");
  return result.stdout;
}
succeeds(predecessor);
const baseline = snapshot();
for (const mode of ["uninitialized", "legacy", "jwt", "tampered-jwt", "noop-verifier-jwt", "cached-manifest-jwt"]) {
  const user = randomUUID();
  const setup = `begin;
    insert into auth.users(id,aud,role,email,email_confirmed_at,is_anonymous)
      values('${user}','authenticated','authenticated','upgrade-${user}@example.test',clock_timestamp(),false);
    ${mode === "uninitialized" ? "" : `
      -- Deliberately exercise the real predecessor interface, only in this fixture.
      select public.admin_bootstrap_v1('${user}','local','local','http://127.0.0.1:54321/auth/v1','upgrade predecessor');
    `}
    ${mode.includes("jwt") ? `
      -- Construct the exact already-cut-over implementation/grant state. The
      -- business cutover algorithm itself is covered by the real DB flow tests.
      do $$ declare item record; begin
        for item in select * from public.admin_runtime_authority_expected_v3 loop
          execute 'revoke all on function '||item.signature||' from public,anon,authenticated,service_role';
          if item.authenticated_execute then execute 'grant execute on function '||item.signature||' to authenticated'; end if;
          if item.service_role_execute then execute 'grant execute on function '||item.signature||' to service_role'; end if;
        end loop;
      end; $$;
      revoke update on public.ai_feature_config from service_role;
      revoke update(ai_polish_enabled,global_daily_limit,enabled_user_allowlist) on public.ai_feature_config from service_role;
      update public.admin_environment set control_plane_mode='jwt_v1',revision=9;
      update public.admin_ai_control_state_v1 set revision=11;
      insert into public.admin_runtime_authority_receipts_v3(environment,project_ref,authority_scope,authority_epoch,authority_manifest,authority_manifest_sha256)
        select 'local','local','jwt_v1',1,manifest,encode(extensions.digest(convert_to(manifest::text,'UTF8'),'sha256'),'hex')
        from (select public.admin_current_runtime_authority_manifest_v3() manifest) value;
      select public.admin_assert_runtime_authority_receipt_v3('local','local');
    ` : ""}
    create temporary table before_business as select jsonb_build_object(
      'environment',(select jsonb_agg(to_jsonb(t)) from public.admin_environment t),
      'members',(select jsonb_agg(to_jsonb(t)) from public.admin_principals t),
      'features',(select jsonb_agg(to_jsonb(t)) from public.ai_feature_config t),
      'control',(select jsonb_agg(to_jsonb(t)) from public.admin_ai_control_state_v1 t),
      'audit',(select jsonb_agg(to_jsonb(t) order by id) from public.admin_audit_events t)
    ) snapshot;
    create temporary table before_receipts as select receipt_id,to_jsonb(t) snapshot from public.admin_runtime_authority_receipts_v3 t;
    ${mode === "noop-verifier-jwt" ? `create or replace function public.admin_assert_runtime_authority_receipt_v3(p_environment text,p_project_ref text) returns void language plpgsql security definer set search_path='' as $tampered$ begin null; end; $tampered$;` : ""}
    ${mode === "cached-manifest-jwt" ? `create or replace function public.admin_current_runtime_authority_manifest_v3() returns jsonb language sql security definer set search_path='' as $tampered$ select authority_manifest from public.admin_runtime_authority_receipts_v3 where environment='local' and authority_scope='jwt_v1' order by authority_epoch desc limit 1; $tampered$;` : ""}
    ${mode === "tampered-jwt" ? `create or replace function public.admin_assert_reason_v1(p_reason text) returns void language plpgsql set search_path='' as $$ begin null; end; $$;` : ""}
  `;
  const checks = `
    do $$ declare after_business jsonb; appended integer; begin
      select jsonb_build_object(
        'environment',(select jsonb_agg(to_jsonb(t)) from public.admin_environment t),
        'members',(select jsonb_agg(to_jsonb(t)) from public.admin_principals t),
        'features',(select jsonb_agg(to_jsonb(t)) from public.ai_feature_config t),
        'control',(select jsonb_agg(to_jsonb(t)) from public.admin_ai_control_state_v1 t),
        'audit',(select jsonb_agg(to_jsonb(t) order by id) from public.admin_audit_events t)
      ) into after_business;
      if after_business is distinct from (select snapshot from before_business) then raise exception 'Upgrade changed business state'; end if;
      if exists(select 1 from before_receipts old left join public.admin_runtime_authority_receipts_v3 current using(receipt_id) where old.snapshot is distinct from to_jsonb(current)) then raise exception 'Upgrade rewrote receipt history'; end if;
      select count(*) into appended from public.admin_runtime_authority_receipts_v3 current where not exists(select 1 from before_receipts old where old.receipt_id=current.receipt_id);
      if appended<>${mode === "jwt" ? 1 : 0} then raise exception 'Wrong successor receipt count'; end if;
      if '${mode}'='jwt' then
        perform public.admin_assert_runtime_authority_receipt_v3('local',null);
        if not exists(select 1 from public.admin_runtime_authority_receipts_v3 where environment='local' and project_ref is null and authority_epoch=2) then raise exception 'Missing DB-local successor epoch'; end if;
      end if;
    end; $$;
    ${mode === "uninitialized" ? `
      select public.admin_bootstrap_v2('${user}','local','three arguments only');
      do $$ begin
        if not exists(select 1 from public.admin_environment where environment='local' and project_ref is null and auth_issuer is null and control_plane_mode='legacy') then raise exception 'New bootstrap still requires identity'; end if;
      end; $$;
    ` : ""}
    rollback;
  `;
  const result = owner(setup + body + (mode.includes("jwt") && mode !== "jwt" ? "rollback;" : checks));
  if (mode.includes("jwt") && mode !== "jwt") {
    if (result.status === 0 || !result.stderr.includes("RUNTIME_AUTHORITY_MISMATCH")) {
      throw new Error(result.stderr || "Tampered predecessor was accepted");
    }
  } else if (result.status !== 0) throw new Error(result.stderr || `${mode} upgrade failed`);
  // A failed psql session also rolls back; no candidate or fixture can persist.
  succeeds(predecessor);
  if (snapshot() !== baseline) throw new Error("Upgrade fixture escaped rollback: " + mode);
  console.log(`Admin bootstrap upgrade: ${mode} passed (rolled back)`);
}
