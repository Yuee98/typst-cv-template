begin;
set local search_path = '';
create function public.app_context ()
  returns jsonb
  language sql
  stable
  security definer
  set search_path = ''
  as $$
  select
    jsonb_build_object('ready', e.id is not null, 'contract_code', 'cv_app_db_2', 'database_instance_id', e.database_instance_id, 'environment', e.name, 'capabilities', jsonb_build_object('cv_schema_version', 7, 'encrypted_envelope_version', 1))
  from (
    select
      1) x
  left join admin.environment e on e.id = 1
$$;
create function public.keep_project_active ()
  returns boolean
  language sql
  volatile
  security invoker
  set search_path = ''
  as $$
  select
    true
$$;
-- No direct private RPC surface. These fixed private projections are the only intentional Auth readers.
comment on function common.auth_user_active (uuid) is 'Private postgres-owned Auth boolean projection. app_api_owner gets no Auth table or column privilege.';
comment on function common.auth_session_valid (uuid, uuid) is 'Private postgres-owned live/expiry session projection; never returns session secrets.';
comment on function common.auth_user_page (integer, text) is 'Private postgres-owned bounded Admin account projection; no credentials or Auth tokens.';
do $$
declare
  r record;
begin
  for r in
  select
    p.oid::regprocedure sig
  from
    pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where
    n.nspname in ('common', 'admin', 'ai', 'legal', 'cv')
    and p.proowner = (
      select
        oid
      from
        pg_catalog.pg_roles
      where
        rolname = current_user)
      loop
        execute format('revoke all on function %s from public,anon,authenticated,service_role', r.sig);
        execute format('grant execute on function %s to app_api_owner', r.sig);
      end loop;
end
$$;
revoke all on function common.assert_api_owner_safe (), admin.initialize (text, uuid) from app_api_owner;
grant create on schema public to app_api_owner;
do $$
declare
  r record;
begin
  for r in
  select
    p.oid::regprocedure sig,
    p.proname name
  from
    pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where
    n.nspname = 'public'
    and p.proname in ('app_context', 'keep_project_active', 'legal_current', 'legal_document_read', 'legal_accept_document', 'legal_accept_ai', 'admin_context', 'admin_read', 'admin_configuration_save', 'admin_rule_save', 'admin_ai_update', 'admin_ai_disable', 'admin_allowed_user_set', 'admin_member_grant', 'admin_member_revoke', 'admin_legal_document_save', 'ai_quota', 'ai_availability', 'ai_reserve', 'ai_execution_snapshot', 'ai_attempt_start', 'ai_attempt_complete', 'ai_finalize', 'ai_cancel')
    loop
      execute format('revoke all on function %s from public,anon,authenticated,service_role', r.sig);
      if r.name in ('app_context', 'keep_project_active', 'legal_current', 'legal_document_read') then
        execute format('grant execute on function %s to anon,authenticated,service_role', r.sig);
      elsif r.name like 'ai\_%' escape '\' then execute format(' grant execute on function %s to service_role ', r.sig);
      else
        execute format('grant execute on function %s to authenticated', r.sig);
      end if;
      execute format('alter function %s owner to app_api_owner', r.sig);
    end loop;
end
$$;
revoke create on schema public from app_api_owner;
notify pgrst,
'reload schema';
comment on table ai.configurations is 'Editable current connections. Config+price save atomically under one revision. Protocol adapters are code-owned.';
comment on table ai.prices is 'One current four-rate native-currency estimate per configuration; no currency conversion or provider invoice claim.';
comment on table ai.routing_rules is 'Asia/Shanghai, Monday=1. Half-open same-day periods. All NULL time columns derive the fallback.';
comment on table ai.request_snapshots is 'Immutable typed execution, price and exact-consent facts captured at reserve; never read mutable configuration for historical execution.';
comment on table ai.attempts is 'PK(request_id,attempt_no). Terminal producer facts are idempotent; unknown transmission remains HELD.';
comment on table ai.configuration_usage_daily is 'Central UTC reserve-day metrics by frozen config audit and native currency; token/cost values are lower bounds when incompleteness counters are nonzero.';
comment on table ai.global_quota_daily is 'Only actual first-attempt admissions on current locked UTC admission day; not reserve-day analytics.';
comment on table legal.documents is 'Current bilingual Markdown document and exact recipient/adapter/endpoint/model scope; no bundle or published-version state machine.';
comment on table audit.acceptances is 'Immutable accepted document-audit link. Auth deletion only clears account UUIDs irreversibly through FK SET NULL; snapshot references survive.';
comment on table admin.operations is 'Typed idempotency receipt; no generic JSON result. Deleted actors are irreversibly unlinked.';
commit;
