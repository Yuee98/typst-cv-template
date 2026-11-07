-- Incremental owner-operation audit and administrator lifecycle hardening.
-- The original four-file baseline stays immutable; all changes are atomic.
begin;
-- A reset can retain cluster roles. Never reuse an elevated application owner.
-- Private migration-owner-only assertion also supports explicit deployment preflight.
create function common.assert_api_owner_safe ()
  returns void
  language plpgsql
  stable
  security invoker
  set search_path = ''
  as $$
declare
  v_owner oid;
  v_migration_owner oid;
begin
  select
    oid
  into
    v_owner
  from
    pg_catalog.pg_roles
  where
    rolname = 'app_api_owner';
  select
    oid
  into
    v_migration_owner
  from
    pg_catalog.pg_roles
  where
    rolname = current_user;
  if v_owner is null or exists (
    select
      1
    from
      pg_catalog.pg_roles
    where
      oid = v_owner and (rolcanlogin or rolinherit or rolbypassrls or rolsuper or rolcreaterole or rolcreatedb or rolreplication)) or exists (
select
  1
from
  pg_catalog.pg_auth_members
where
  member = v_owner) or exists (
select
  1
from
  pg_catalog.pg_auth_members
where
  roleid = v_owner and member <> v_migration_owner) or exists (
select
  1
from
  pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where
  n.nspname in ('auth', 'storage') and c.relkind in ('r', 'p', 'v', 'm', 'f') and (pg_catalog.has_table_privilege(v_owner, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') or pg_catalog.has_any_column_privilege(v_owner, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))) then
    raise exception 'Unsafe existing app_api_owner role'
      using errcode = '42501';
  end if;
end;
$$;
revoke all on function common.assert_api_owner_safe () from public, anon, authenticated, service_role, app_api_owner;
comment on function common.assert_api_owner_safe () is 'Migration-owner-only invoker assertion: application owner must be NOLOGIN/NOINHERIT/NOBYPASSRLS and have no superuser/create/replication attributes, outgoing memberships, non-migration-owner members, or effective Auth/Storage table/column privileges. Unknown inherited privileges fail closed.';
select
  common.assert_api_owner_safe ();
-- The derived key exists only while membership is active. RESTRICT serializes
-- activation against Auth deletion; revoked membership retains historical UUIDs.
alter table admin.members
  add column active_auth_user_id uuid generated always as ( case when time_revoked is null then
    auth_user_id
  else
    null
  end) stored,
  add constraint fk_admin_members_active_auth_user foreign key (active_auth_user_id) references auth.users (id) on delete restrict;
create index ix_admin_members_active_auth_user_id on admin.members (active_auth_user_id)
where
  active_auth_user_id is not null;
comment on column admin.members.active_auth_user_id is 'Private generated FK key: active administrator prevents Auth deletion; revocation clears this key without erasing auth_user_id history. Never exposed by Admin projections.';
create or replace function admin.initialize (p_name text, p_admin_user uuid)
  returns jsonb
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
declare
  v_environment admin.environment;
  v_terms_id bigint;
  v_bundle_id bigint;
  v_member jsonb;
begin
  perform
    common.assert_api_owner_safe ();
  -- Lock the target key until bootstrap commits so concurrent Auth deletion
  -- cannot race an apparently valid first-administrator assignment.
  perform
    1
  from
    auth.users
  where
    id = p_admin_user
    and deleted_at is null
    and (banned_until is null
      or banned_until < clock_timestamp())
  for key share;
  if not found then
    perform
      common.fail ('INVALID_REQUEST', 'ADMIN_USER_MISSING');
  end if;
  select
    *
  into
    v_environment
  from
    admin.environment
  where
    id = 1
  for update;
  if found then
    if v_environment.name <> p_name or not exists (
      select
        1
      from
        admin.members
      where
        auth_user_id = p_admin_user and time_revoked is null) then
      perform
        common.fail ('CONFLICT', 'INITIALIZATION_CHANGED');
    end if;
    return public.app_context ();
  end if;
  select
    id
  into
    v_terms_id
  from
    legal.document_versions
  where
    document_code = 'TERMS'
  order by
    version desc
  limit 1;
  select
    id
  into
    v_bundle_id
  from
    legal.bundles
  where
    time_sealed is not null
  order by
    id desc
  limit 1;
  if v_terms_id is null or v_bundle_id is null then
    perform
      common.fail ('NOT_READY', 'LEGAL_CATALOG_MISSING');
  end if;
  insert into admin.environment (id, name, database_instance_id, contract_code)
    values (1, p_name, gen_random_uuid (), 'cv_app_db_1')
  returning
    *
  into
    v_environment;
  v_member = common.insert_entity ('admin.members', jsonb_build_object('auth_user_id', p_admin_user, 'user_created', null, 'user_updated', null));
  insert into legal.current_state (id, terms_document_version_id, ai_bundle_id)
    values (1, v_terms_id, v_bundle_id);
  update
    ai.runtime_control
  set
    enabled = false,
    active_policy_version_id = null,
    audience = 'ALLOWLIST',
    user_updated = null
  where
    id = 1;
  perform
    common.insert_entity ('audit.events', jsonb_build_object('actor_kind', 'SYSTEM', 'actor_auth_user_id', null, 'entity_kind', 'ENVIRONMENT', 'entity_external_id', v_environment.database_instance_id::text, 'action', 'ENVIRONMENT_INITIALIZED', 'reason', 'Migration owner initialized the business environment and first administrator', 'summary', jsonb_build_object('environment', p_name, 'database_instance_id', v_environment.database_instance_id, 'target_administrator_member_id', v_member ->> 'external_id', 'target_administrator_auth_user_id', p_admin_user, 'terms_document_version_id', (
            select
              external_id
            from legal.document_versions
            where
              id = v_terms_id), 'ai_bundle_id', (
            select
              external_id
            from legal.bundles
            where
              id = v_bundle_id), 'runtime_enabled', false)));
  return public.app_context ();
end;
$$;
create or replace function admin.publish_legal_current (p_terms text, p_bundle text)
  returns void
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
declare
  v_terms_id bigint;
  v_bundle_id bigint;
  v_previous legal.current_state;
  v_instance uuid;
begin
  perform
    common.assert_api_owner_safe ();
  select
    database_instance_id
  into
    v_instance
  from
    admin.environment
  where
    id = 1
  for update;
  if not found then
    perform
      common.fail ('NOT_READY', 'ENVIRONMENT_NOT_INITIALIZED');
  end if;
  perform
    1
  from
    ai.runtime_control
  where
    id = 1
  for update;
  select
    *
  into
    v_previous
  from
    legal.current_state
  where
    id = 1
  for update;
  if not found then
    perform
      common.fail ('NOT_READY', 'ENVIRONMENT_NOT_INITIALIZED');
  end if;
  select
    id
  into
    v_terms_id
  from
    legal.document_versions
  where
    external_id = p_terms
    and document_code = 'TERMS';
  select
    id
  into
    v_bundle_id
  from
    legal.bundles
  where
    external_id = p_bundle
    and time_sealed is not null;
  if v_terms_id is null or v_bundle_id is null then
    perform
      common.fail ('INVALID_REQUEST', 'LEGAL_TARGET');
  end if;
  if v_previous.terms_document_version_id = v_terms_id and v_previous.ai_bundle_id = v_bundle_id then
    return;
  end if;
  update
    ai.runtime_control
  set
    enabled = false,
    active_policy_version_id = null,
    generation = generation + 1,
    close_cycle = close_cycle + 1,
    user_updated = null
  where
    id = 1;
  update
    legal.current_state
  set
    terms_document_version_id = v_terms_id,
    ai_bundle_id = v_bundle_id
  where
    id = 1;
  perform
    common.insert_entity ('audit.events', jsonb_build_object('actor_kind', 'SYSTEM', 'actor_auth_user_id', null, 'entity_kind', 'LEGAL_CURRENT', 'entity_external_id', v_instance::text, 'action', 'LEGAL_CURRENT_PUBLISHED', 'reason', 'Migration owner published the current immutable legal targets', 'summary', jsonb_build_object('previous_terms_document_version_id', (
            select
              external_id
            from legal.document_versions
            where
              id = v_previous.terms_document_version_id), 'previous_ai_bundle_id', (
            select
              external_id
            from legal.bundles
            where
              id = v_previous.ai_bundle_id), 'terms_document_version_id', p_terms, 'ai_bundle_id', p_bundle, 'runtime_enabled', false, 'active_policy_version_id', null)));
end;
$$;
revoke all on function admin.initialize (text, uuid), admin.publish_legal_current (text, text) from public, anon, authenticated, service_role, app_api_owner;
comment on function admin.initialize (text, uuid) is 'Migration-owner only, invoker with empty search_path. Atomically initializes environment/admin/legal pointers/disabled runtime and SYSTEM audit; exact idempotent replay creates no duplicate audit. Target administrator is not impersonated as actor.';
comment on function admin.publish_legal_current (text, text) is 'Migration-owner only, invoker with empty search_path. Publishes sealed immutable legal targets, closes AI/clears policy, advances generation and SYSTEM audit atomically; same targets are a no-op.';
create or replace function admin.project (p_kind text, p_row jsonb)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  j jsonb := p_row - array['id', 'creation_txid', 'active_auth_user_id'];
  k text;
  v text;
begin
  foreach k in array array['revision', 'generation', 'config_generation', 'control_revision', 'environment_revision', 'close_cycle', 'user_daily_limit', 'global_daily_limit', 'user_minute_limit', 'cancel_sequence', 'estimated_cost_nanos', 'known_estimated_cost_nanos', 'provider_reported_cost_nanos'] loop
    if j ? k and j -> k <> 'null'::jsonb then
      j = jsonb_set(j, array[k], to_jsonb (j ->> k));
    end if;
  end loop;
  if j ? 'selected_option_id' then
    j = jsonb_set(j, '{selected_option_id}', coalesce((
        select
          to_jsonb (external_id)
        from ai.policy_options
        where
          id = (p_row ->> 'selected_option_id')::bigint), 'null'));
  end if;
  if j ? 'operation_id' then
    j = jsonb_set(j, '{operation_id}', coalesce((
        select
          to_jsonb (external_id)
        from admin.operations
        where
          id = (p_row ->> 'operation_id')::bigint), 'null'));
  end if;
  if j ? 'provider_id' then
    j = jsonb_set(j, '{provider_id}', coalesce((
        select
          to_jsonb (external_id)
        from ai.providers
        where
          id = (p_row ->> 'provider_id')::bigint), 'null'));
  end if;
  if j ? 'profile_id' then
    j = jsonb_set(j, '{profile_id}', coalesce((
        select
          to_jsonb (external_id)
        from ai.profiles
        where
          id = (p_row ->> 'profile_id')::bigint), 'null'));
  end if;
  if j ? 'profile_version_id' then
    j = jsonb_set(j, '{profile_version_id}', coalesce((
        select
          to_jsonb (external_id)
        from ai.profile_versions
        where
          id = (p_row ->> 'profile_version_id')::bigint), 'null'));
  end if;
  if j ? 'price_version_id' then
    j = jsonb_set(j, '{price_version_id}', coalesce((
        select
          to_jsonb (external_id)
        from ai.price_versions
        where
          id = (p_row ->> 'price_version_id')::bigint), 'null'));
  end if;
  if j ? 'policy_id' then
    j = jsonb_set(j, '{policy_id}', coalesce((
        select
          to_jsonb (external_id)
        from ai.policies
        where
          id = (p_row ->> 'policy_id')::bigint), 'null'));
  end if;
  if j ? 'policy_version_id' then
    j = jsonb_set(j, '{policy_version_id}', coalesce((
        select
          to_jsonb (external_id)
        from ai.policy_versions
        where
          id = (p_row ->> 'policy_version_id')::bigint), 'null'));
  end if;
  if j ? 'legal_bundle_id' then
    j = jsonb_set(j, '{legal_bundle_id}', coalesce((
        select
          to_jsonb (external_id)
        from legal.bundles
        where
          id = (p_row ->> 'legal_bundle_id')::bigint), 'null'));
  end if;
  if j ? 'legal_disclosure_id' then
    j = jsonb_set(j, '{legal_disclosure_id}', coalesce((
        select
          to_jsonb (external_id)
        from legal.disclosures
        where
          id = (p_row ->> 'legal_disclosure_id')::bigint), 'null'));
  end if;
  if j ? 'active_policy_version_id' then
    j = jsonb_set(j, '{active_policy_version_id}', coalesce((
        select
          to_jsonb (external_id)
        from ai.policy_versions
        where
          id = (p_row ->> 'active_policy_version_id')::bigint), 'null'));
  end if;
  if j ? 'capability_id' then
    j = (j - 'capability_id') || jsonb_build_object('capability_code', (
        select
          code
        from ai.capabilities
        where
          id = (p_row ->> 'capability_id')::smallint));
  end if;
  if p_kind = 'providers' then
    j = (j - array['default_capability_id', 'default_endpoint_url', 'default_credential_ref', 'default_model_id']) || jsonb_build_object('defaults', jsonb_build_object('capability_code', (
          select
            code
          from ai.capabilities
          where
            id = (p_row ->> 'default_capability_id')::smallint), 'endpoint_url', p_row -> 'default_endpoint_url', 'credential_ref', p_row -> 'default_credential_ref', 'model_id', p_row -> 'default_model_id'));
  end if;
  if p_kind = 'profile_versions' then
    j = j || jsonb_build_object('disclosure_id', j -> 'legal_disclosure_id', 'parent_revision', (
        select
          revision::text
        from ai.profiles
        where
          id = (p_row ->> 'profile_id')::bigint));
  elsif p_kind = 'price_versions' then
    j = j || jsonb_build_object('parent_revision', (
        select
          p.revision::text
        from ai.profiles p
        join ai.profile_versions v on v.profile_id = p.id
        where
          v.id = (p_row ->> 'profile_version_id')::bigint));
  elsif p_kind = 'policy_versions' then
    j = j || jsonb_build_object('parent_revision', (
        select
          revision::text
        from ai.policies
        where
          id = (p_row ->> 'policy_id')::bigint));
  end if;
  if p_kind = 'price_versions' then
    j = j || jsonb_build_object('valid_from', p_row -> 'time_valid_from', 'valid_until', p_row -> 'time_valid_until', 'components', (
        select
          jsonb_object_agg(component, nanos_per_million::text)
        from ai.price_components
        where
          price_version_id = (p_row ->> 'id')::bigint));
  end if;
  if p_kind = 'policy_versions' then
    j = j || jsonb_build_object('options', (
        select
          coalesce(jsonb_agg(jsonb_build_object('external_id', o.external_id, 'profile_version_id', v.external_id, 'price_lane_code', o.price_lane_code, 'display_order', o.display_order)
          order by o.display_order, o.id), '[]')
        from ai.policy_options o
        join ai.profile_versions v on v.id = o.profile_version_id
        where
          o.policy_version_id = (p_row ->> 'id')::bigint), 'rules', (
          select
            coalesce(jsonb_agg(jsonb_build_object('ordinal', r.ordinal, 'is_fallback', r.is_fallback, 'weekday', r.weekday, 'start_minute', r.start_minute, 'end_minute', r.end_minute, 'default_option_id', (
                    select
                      external_id
                    from ai.policy_options
                  where
                    id = r.default_option_id), 'option_ids', (
                    select
                      jsonb_agg(o.external_id order by o.display_order)
                  from ai.routing_rule_options m
                  join ai.policy_options o on o.id = m.option_id
                where
                  m.policy_version_id = r.policy_version_id
                  and m.rule_ordinal = r.ordinal))
            order by r.ordinal), '[]')
      from ai.routing_rules r
    where
      r.policy_version_id = (p_row ->> 'id')::bigint));
  end if;
  if p_kind = 'validations' then
    return jsonb_build_object('external_id', j -> 'external_id', 'target_kind', j -> 'target_kind', 'target_id', coalesce(nullif (j -> 'profile_version_id', 'null'), nullif (j -> 'price_version_id', 'null'), nullif (j -> 'policy_version_id', 'null')), 'dependency_digest', j -> 'dependency_digest', 'passed', j -> 'passed', 'reasons', j -> 'reasons', 'time_checked', j -> 'time_checked', 'time_expires', j -> 'time_expires');
  elsif p_kind = 'readbacks' then
    return jsonb_build_object('external_id', j -> 'external_id', 'policy_version_id', j -> 'policy_version_id', 'dependency_digest', j -> 'dependency_digest', 'passed', j -> 'passed', 'reasons', j -> 'reasons', 'time_checked', j -> 'time_checked', 'time_expires', j -> 'time_expires');
  end if;
  if p_kind = 'requests' then
    j = j - array['request_fingerprint', 'client_request_key'];
  end if;
  return j;
end
$$;
comment on function admin.project (text, jsonb) is 'Current Admin external-ID projection. Internal keys, transaction metadata and the active-administrator Auth FK key are never exposed; revisions are decimal strings.';
commit;

