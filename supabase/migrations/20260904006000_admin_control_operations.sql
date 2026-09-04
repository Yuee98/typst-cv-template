-- ADM-I07A: dark JWT control operations, trusted route readback and an
-- explicit DB-owner authority cutover. Applying this migration does not
-- change control_plane_mode or revoke the legacy DB-013 operator.
begin;

create table public.admin_ai_control_state_v1 (
  id boolean primary key default true check (id),
  revision bigint not null default 0 check (revision >= 0),
  closing_cycle_id uuid,
  closed_at timestamptz,
  closed_by uuid references public.admin_principals(user_id) on delete restrict,
  reopened_at timestamptz,
  constraint admin_ai_control_cycle_shape check (
    (closing_cycle_id is null and closed_at is null and closed_by is null and reopened_at is null)
    or (closing_cycle_id is not null and closed_at is not null
      and (reopened_at is null or reopened_at >= closed_at))
  )
);
insert into public.admin_ai_control_state_v1(id) values (true);

create table public.admin_runtime_readback_reports_v1 (
  id uuid primary key default extensions.gen_random_uuid(),
  closing_cycle_id uuid not null,
  control_revision bigint not null check (control_revision >= 0),
  config_generation bigint not null check (config_generation >= 0),
  policy_version_id uuid not null references public.ai_routing_policy_versions(id),
  legal_bundle_version text not null
    check (legal_bundle_version ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  reviewed_deployment_id uuid not null
    references public.admin_reviewed_deployments_v1(id) on delete restrict,
  runtime_build_id text not null
    check (runtime_build_id ~ '^[a-z0-9][a-z0-9._:-]{0,199}$'),
  binding_manifest_revision text not null
    check (binding_manifest_revision ~ '^[a-z0-9][a-z0-9._-]{0,199}$'),
  binding_manifest_sha256 text not null
    check (binding_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  validation_report_ids uuid[] not null,
  effective_routes jsonb not null,
  effective_routes_sha256 text not null
    check (effective_routes_sha256 ~ '^[0-9a-f]{64}$'),
  checked_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  report_sha256 text not null check (report_sha256 ~ '^[0-9a-f]{64}$'),
  constraint admin_runtime_readback_reports_window check (
    expires_at > checked_at and expires_at <= checked_at + interval '10 minutes'
  ),
  constraint admin_runtime_readback_reports_payload check (
    cardinality(validation_report_ids) between 1 and 32
    and jsonb_typeof(effective_routes) = 'array'
    and jsonb_array_length(effective_routes) between 1 and 32
  )
);

alter table public.admin_ai_control_state_v1 enable row level security;
alter table public.admin_runtime_readback_reports_v1 enable row level security;
revoke all on public.admin_ai_control_state_v1,
  public.admin_runtime_readback_reports_v1
  from public, anon, authenticated, service_role;

create function public.admin_guard_control_evidence_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Admin control evidence is immutable' using errcode = '23514';
end;
$$;
create trigger admin_runtime_readback_reports_immutable
before update or delete on public.admin_runtime_readback_reports_v1
for each row execute function public.admin_guard_control_evidence_v1();

create function public.admin_assert_jwt_control_mode_v1()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.admin_environment
    where id = true and control_plane_mode = 'jwt_v1'
  ) then
    raise exception 'WRITES_DISABLED' using errcode = '42501';
  end if;
end;
$$;

create function public.admin_replayed_operation_v1(
  p_replay jsonb,
  p_operation_kind text,
  p_idempotency_key uuid
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'schemaVersion', 'admin_committed_operation_v1',
    'operationId', p_replay ->> 'operationId',
    'operationKind', p_operation_kind,
    'idempotencyKey', p_idempotency_key,
    'result', p_replay -> 'result',
    'auditId', p_replay ->> 'auditId',
    'committedAt', p_replay ->> 'committedAt'
  );
$$;

create function public.admin_policy_effective_routes_v1(
  p_policy_version_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_policy public.ai_routing_policy_versions%rowtype;
  v_routes jsonb;
  v_route_count integer;
  v_binding_count integer;
begin
  select * into v_policy
  from public.ai_routing_policy_versions
  where id = p_policy_version_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  with route_pairs as (
    select distinct
      (v_policy.rules -> 'defaultRoute' ->> 'profileVersionId')::uuid as profile_version_id,
      (v_policy.rules -> 'defaultRoute' ->> 'priceVersionId')::uuid as price_version_id
    union
    select distinct
      (entry.value -> 'route' ->> 'profileVersionId')::uuid,
      (entry.value -> 'route' ->> 'priceVersionId')::uuid
    from jsonb_array_elements(v_policy.rules -> 'windows') as entry(value)
  ), bindings as (
    select pair.profile_version_id, pair.price_version_id,
      binding.runtime_target_id, binding.runtime_target_sha256,
      binding.provider_id, binding.code_capability_id,
      binding.code_capability_sha256, binding.legal_manifest_id,
      binding.display_disclosure_key
    from route_pairs as pair
    join public.ai_runtime_target_bindings_v2 as binding
      on binding.runtime_contract_id = v_policy.runtime_contract_id
     and binding.profile_version_id = pair.profile_version_id
     and binding.price_version_id = pair.price_version_id
     and binding.legal_bundle_version = v_policy.legal_bundle_version
  )
  select (select count(*) from route_pairs), count(*),
    jsonb_agg(jsonb_build_object(
      'profileVersionId', profile_version_id,
      'priceVersionId', price_version_id,
      'runtimeTargetId', runtime_target_id,
      'runtimeTargetSha256', runtime_target_sha256,
      'providerId', provider_id,
      'codeCapabilityId', code_capability_id,
      'codeCapabilitySha256', code_capability_sha256,
      'legalManifestId', legal_manifest_id,
      'displayDisclosureKey', display_disclosure_key
    ) order by profile_version_id, price_version_id)
  into v_route_count, v_binding_count, v_routes
  from bindings;
  if v_route_count is null or v_route_count < 1
     or v_route_count <> v_binding_count or v_routes is null then
    raise exception 'ROUTE_NOT_READY' using errcode = '23514';
  end if;
  return v_routes;
exception
  when invalid_text_representation or null_value_not_allowed then
    raise exception 'ROUTE_NOT_READY' using errcode = '23514';
end;
$$;

create function public.admin_assert_policy_validation_reports_v1(
  p_policy_version_id uuid,
  p_validation_report_ids uuid[],
  p_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_policy public.ai_routing_policy_versions%rowtype;
  v_report_ids uuid[];
  v_effective_routes jsonb;
  v_route_count integer;
  v_report_count integer;
  v_deployment_count integer;
  v_reviewed_deployment_id uuid;
  v_reviewed_source_commit_oid text;
  v_reviewed_source_sha256 text;
  v_rechecked_at timestamptz;
  v_rechecked_sha256 text;
  v_expires_at timestamptz;
begin
  if p_at is null or cardinality(p_validation_report_ids) not between 1 and 32
     or cardinality(p_validation_report_ids) is distinct from (
       select count(distinct id) from unnest(p_validation_report_ids) as item(id)
     ) then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  select array_agg(id order by id) into v_report_ids
  from unnest(p_validation_report_ids) as item(id);
  select * into v_policy
  from public.ai_routing_policy_versions
  where id = p_policy_version_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  v_effective_routes := public.admin_policy_effective_routes_v1(v_policy.id);
  v_route_count := jsonb_array_length(v_effective_routes);

  select count(*), count(distinct report.reviewed_deployment_id),
    (array_agg(report.reviewed_deployment_id order by report.reviewed_deployment_id))[1],
    min(deployment.reviewed_source_commit_oid),
    min(deployment.reviewed_source_sha256), max(report.checked_at),
    min(least(report.expires_at, deployment.valid_until)),
    encode(extensions.digest(convert_to(
      'admin_policy_validation_v1' || E'\n' || string_agg(
        report.id::text || ':' || report.report_sha256, E'\n' order by report.id
      ), 'UTF8'), 'sha256'), 'hex')
  into v_report_count, v_deployment_count, v_reviewed_deployment_id,
    v_reviewed_source_commit_oid, v_reviewed_source_sha256, v_rechecked_at,
    v_expires_at, v_rechecked_sha256
  from public.admin_validation_reports_v1 as report
  join public.admin_reviewed_deployments_v1 as deployment
    on deployment.id = report.reviewed_deployment_id
   and deployment.environment = report.environment
   and deployment.project_ref = report.project_ref
   and deployment.runtime_build_id = report.runtime_build_id
   and deployment.binding_manifest_revision = report.binding_manifest_revision
   and deployment.binding_manifest_sha256 = report.binding_manifest_sha256
  join public.admin_environment as environment
    on environment.id = true
   and environment.environment = report.environment
   and environment.project_ref = report.project_ref
  where report.id = any(v_report_ids)
    and report.passed
    and report.expires_at > p_at
    and deployment.valid_until > p_at
    and report.runtime_contract_id = v_policy.runtime_contract_id
    and report.legal_bundle_version = v_policy.legal_bundle_version
    and exists (
      select 1 from jsonb_array_elements(v_effective_routes) as route(value)
      where route.value ->> 'profileVersionId' = report.profile_version_id::text
        and route.value ->> 'priceVersionId' = report.price_version_id::text
        and route.value ->> 'runtimeTargetId' = report.runtime_target_id
        and route.value ->> 'runtimeTargetSha256' = report.runtime_target_sha256
        and route.value ->> 'providerId' = report.provider_id::text
        and route.value ->> 'codeCapabilityId' = report.code_capability_id
        and route.value ->> 'codeCapabilitySha256' = report.code_capability_sha256
        and route.value ->> 'legalManifestId' = report.legal_manifest_id
        and route.value ->> 'displayDisclosureKey' = report.display_disclosure_key
    );
  if v_report_count <> cardinality(v_report_ids)
     or v_report_count <> v_route_count
     or v_deployment_count <> 1
     or v_reviewed_source_commit_oid !~ '^sha1:[0-9a-f]{40}$'
     or v_rechecked_at > p_at
     or v_expires_at <= p_at then
    raise exception 'VALIDATION_REPORT_MISMATCH' using errcode = '23514';
  end if;
  return jsonb_build_object(
    'validationReportIds', to_jsonb(v_report_ids),
    'effectiveRoutes', v_effective_routes,
    'reviewedDeploymentId', v_reviewed_deployment_id,
    'reviewedSourceCommitOid', v_reviewed_source_commit_oid,
    'reviewedSourceSha256', v_reviewed_source_sha256,
    'recheckedAt', v_rechecked_at,
    'recheckedSha256', v_rechecked_sha256,
    'expiresAt', v_expires_at
  );
end;
$$;

create function public.admin_disable_ai_v1(
  p_environment text,
  p_project_ref text,
  p_expected_control_revision bigint,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_payload jsonb;
  v_replay jsonb;
  v_config public.ai_feature_config%rowtype;
  v_control public.admin_ai_control_state_v1%rowtype;
  v_cycle uuid := extensions.gen_random_uuid();
  v_audit uuid;
  v_result jsonb;
begin
  v_actor := public.admin_assert_write_actor_v1(p_environment, p_project_ref, false);
  perform public.admin_assert_jwt_control_mode_v1();
  v_payload := jsonb_build_object(
    'expectedControlRevision', p_expected_control_revision,
    'reason', p_reason
  );
  v_replay := public.admin_lock_committed_operation_v1(
    v_actor, 'ai_disable', p_idempotency_key, v_payload
  );
  if (v_replay ->> 'found')::boolean then
    return public.admin_replayed_operation_v1(v_replay, 'ai_disable', p_idempotency_key);
  end if;
  if p_reason is null or p_reason <> btrim(p_reason) or length(p_reason) not between 1 and 500 then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  select * into v_config from public.ai_feature_config where id = true for update;
  select * into v_control from public.admin_ai_control_state_v1 where id = true for update;
  if not found or v_config.id is null then raise exception 'UNAVAILABLE' using errcode = 'P0001'; end if;
  if v_control.revision is distinct from p_expected_control_revision
     or not v_config.ai_polish_enabled then
    raise exception 'CONFLICT' using errcode = '40001';
  end if;
  update public.ai_feature_config set ai_polish_enabled = false where id = true;
  update public.admin_ai_control_state_v1 set
    revision = revision + 1,
    closing_cycle_id = v_cycle,
    closed_at = clock_timestamp(),
    closed_by = v_actor,
    reopened_at = null
  where id = true returning * into v_control;
  insert into public.admin_audit_events(operation, actor, target_id, reason)
  values ('ai_disable', v_actor::text, null, p_reason) returning id into v_audit;
  v_result := jsonb_build_object(
    'schemaVersion', 'admin_ai_control_result_v1',
    'aiEnabled', false,
    'controlRevision', v_control.revision::text,
    'closingCycleId', v_control.closing_cycle_id,
    'configGeneration', v_config.config_generation::text,
    'activePolicyVersionId', v_config.active_routing_policy_version_id
  );
  return public.admin_commit_operation_v1(
    v_actor, 'ai_disable', p_idempotency_key, v_payload, v_result, v_audit
  );
end;
$$;

create function public.admin_set_ai_routing_pointer_v1(
  p_environment text,
  p_project_ref text,
  p_policy_version_id uuid,
  p_validation_report_ids uuid[],
  p_expected_control_revision bigint,
  p_expected_policy_version_id uuid,
  p_expected_config_generation bigint,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_report_ids uuid[];
  v_payload jsonb;
  v_replay jsonb;
  v_config public.ai_feature_config%rowtype;
  v_control public.admin_ai_control_state_v1%rowtype;
  v_policy public.ai_routing_policy_versions%rowtype;
  v_evidence jsonb;
  v_lifecycle_audit uuid;
  v_admin_audit uuid;
  v_result jsonb;
begin
  v_actor := public.admin_assert_write_actor_v1(p_environment, p_project_ref, false);
  perform public.admin_assert_jwt_control_mode_v1();
  select array_agg(id order by id) into v_report_ids
  from unnest(p_validation_report_ids) as item(id);
  v_payload := jsonb_build_object(
    'policyVersionId', p_policy_version_id,
    'validationReportIds', to_jsonb(v_report_ids),
    'expectedControlRevision', p_expected_control_revision,
    'expectedPolicyVersionId', p_expected_policy_version_id,
    'expectedConfigGeneration', p_expected_config_generation,
    'reason', p_reason
  );
  v_replay := public.admin_lock_committed_operation_v1(
    v_actor, 'ai_pointer_set', p_idempotency_key, v_payload
  );
  if (v_replay ->> 'found')::boolean then
    return public.admin_replayed_operation_v1(v_replay, 'ai_pointer_set', p_idempotency_key);
  end if;
  if not public.admin_has_recent_totp_v1(v_actor) then
    raise exception 'STEP_UP_REQUIRED' using errcode = '42501';
  end if;
  if p_reason is null or p_reason <> btrim(p_reason) or length(p_reason) not between 1 and 500 then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  select * into v_config from public.ai_feature_config where id = true for update;
  select * into v_control from public.admin_ai_control_state_v1 where id = true for update;
  select * into v_policy from public.ai_routing_policy_versions where id = p_policy_version_id for update;
  if v_config.id is null or v_control.id is null or v_policy.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_config.ai_polish_enabled
     or v_control.closing_cycle_id is null
     or v_control.reopened_at is not null
     or v_control.revision is distinct from p_expected_control_revision
     or v_config.active_routing_policy_version_id is distinct from p_expected_policy_version_id
     or v_config.config_generation is distinct from p_expected_config_generation then
    raise exception 'CONFLICT' using errcode = '40001';
  end if;
  v_evidence := public.admin_assert_policy_validation_reports_v1(
    v_policy.id, v_report_ids, clock_timestamp()
  );
  select public.set_ai_routing_policy_pointer_v1(
    v_policy.id, v_policy.runtime_contract_id, v_actor::text, p_reason,
    v_evidence ->> 'reviewedSourceCommitOid',
    v_evidence ->> 'reviewedSourceSha256',
    (v_evidence ->> 'recheckedAt')::timestamptz,
    v_evidence ->> 'recheckedSha256'
  ) into v_lifecycle_audit;
  select * into v_config from public.ai_feature_config where id = true;
  update public.admin_ai_control_state_v1 set revision = revision + 1
  where id = true returning * into v_control;
  insert into public.admin_audit_events(operation, actor, target_id, reason)
  values ('ai_pointer_set', v_actor::text, v_policy.id, p_reason)
  returning id into v_admin_audit;
  v_result := jsonb_build_object(
    'schemaVersion', 'admin_ai_control_result_v1',
    'aiEnabled', false,
    'controlRevision', v_control.revision::text,
    'closingCycleId', v_control.closing_cycle_id,
    'configGeneration', v_config.config_generation::text,
    'activePolicyVersionId', v_config.active_routing_policy_version_id,
    'lifecycleAuditId', v_lifecycle_audit,
    'validationReportIds', v_evidence -> 'validationReportIds'
  );
  return public.admin_commit_operation_v1(
    v_actor, 'ai_pointer_set', p_idempotency_key, v_payload, v_result, v_admin_audit
  );
end;
$$;

create function public.admin_clear_ai_routing_pointer_v1(
  p_environment text,
  p_project_ref text,
  p_validation_report_ids uuid[],
  p_expected_control_revision bigint,
  p_expected_policy_version_id uuid,
  p_expected_config_generation bigint,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_report_ids uuid[];
  v_payload jsonb;
  v_replay jsonb;
  v_config public.ai_feature_config%rowtype;
  v_control public.admin_ai_control_state_v1%rowtype;
  v_policy public.ai_routing_policy_versions%rowtype;
  v_evidence jsonb;
  v_lifecycle_audit uuid;
  v_admin_audit uuid;
  v_result jsonb;
begin
  v_actor := public.admin_assert_write_actor_v1(p_environment, p_project_ref, false);
  perform public.admin_assert_jwt_control_mode_v1();
  select array_agg(id order by id) into v_report_ids
  from unnest(p_validation_report_ids) as item(id);
  v_payload := jsonb_build_object(
    'validationReportIds', to_jsonb(v_report_ids),
    'expectedControlRevision', p_expected_control_revision,
    'expectedPolicyVersionId', p_expected_policy_version_id,
    'expectedConfigGeneration', p_expected_config_generation,
    'reason', p_reason
  );
  v_replay := public.admin_lock_committed_operation_v1(
    v_actor, 'ai_pointer_clear', p_idempotency_key, v_payload
  );
  if (v_replay ->> 'found')::boolean then
    return public.admin_replayed_operation_v1(v_replay, 'ai_pointer_clear', p_idempotency_key);
  end if;
  if not public.admin_has_recent_totp_v1(v_actor) then
    raise exception 'STEP_UP_REQUIRED' using errcode = '42501';
  end if;
  if p_reason is null or p_reason <> btrim(p_reason) or length(p_reason) not between 1 and 500
     or p_expected_policy_version_id is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  select * into v_config from public.ai_feature_config where id = true for update;
  select * into v_control from public.admin_ai_control_state_v1 where id = true for update;
  select * into v_policy from public.ai_routing_policy_versions
  where id = p_expected_policy_version_id for update;
  if v_config.id is null or v_control.id is null or v_policy.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_config.ai_polish_enabled
     or v_control.closing_cycle_id is null
     or v_control.reopened_at is not null
     or v_control.revision is distinct from p_expected_control_revision
     or v_config.active_routing_policy_version_id is distinct from p_expected_policy_version_id
     or v_config.config_generation is distinct from p_expected_config_generation then
    raise exception 'CONFLICT' using errcode = '40001';
  end if;
  v_evidence := public.admin_assert_policy_validation_reports_v1(
    v_policy.id, v_report_ids, clock_timestamp()
  );
  select public.clear_ai_routing_policy_pointer_v1(
    v_policy.id, v_policy.runtime_contract_id, v_actor::text, p_reason,
    v_evidence ->> 'reviewedSourceCommitOid',
    v_evidence ->> 'reviewedSourceSha256',
    (v_evidence ->> 'recheckedAt')::timestamptz,
    v_evidence ->> 'recheckedSha256'
  ) into v_lifecycle_audit;
  select * into v_config from public.ai_feature_config where id = true;
  update public.admin_ai_control_state_v1 set revision = revision + 1
  where id = true returning * into v_control;
  insert into public.admin_audit_events(operation, actor, target_id, reason)
  values ('ai_pointer_clear', v_actor::text, v_policy.id, p_reason)
  returning id into v_admin_audit;
  v_result := jsonb_build_object(
    'schemaVersion', 'admin_ai_control_result_v1',
    'aiEnabled', false,
    'controlRevision', v_control.revision::text,
    'closingCycleId', v_control.closing_cycle_id,
    'configGeneration', v_config.config_generation::text,
    'activePolicyVersionId', v_config.active_routing_policy_version_id,
    'lifecycleAuditId', v_lifecycle_audit,
    'validationReportIds', v_evidence -> 'validationReportIds'
  );
  return public.admin_commit_operation_v1(
    v_actor, 'ai_pointer_clear', p_idempotency_key, v_payload, v_result, v_admin_audit
  );
end;
$$;

create function public.record_admin_runtime_readback_v1(
  p_reviewed_deployment_id uuid,
  p_policy_version_id uuid,
  p_validation_report_ids uuid[],
  p_observed_runtime_build_id text,
  p_observed_binding_manifest_revision text,
  p_observed_binding_manifest_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_config public.ai_feature_config%rowtype;
  v_control public.admin_ai_control_state_v1%rowtype;
  v_policy public.ai_routing_policy_versions%rowtype;
  v_deployment public.admin_reviewed_deployments_v1%rowtype;
  v_evidence jsonb;
  v_routes jsonb;
  v_report_ids uuid[];
  v_routes_sha256 text;
  v_report_sha256 text;
  v_expires_at timestamptz;
  v_readback public.admin_runtime_readback_reports_v1%rowtype;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_config from public.ai_feature_config where id = true for share;
  select * into v_control from public.admin_ai_control_state_v1 where id = true for share;
  select * into v_policy from public.ai_routing_policy_versions
  where id = p_policy_version_id for share;
  select * into v_deployment from public.admin_reviewed_deployments_v1
  where id = p_reviewed_deployment_id
    and runtime_build_id = p_observed_runtime_build_id
    and binding_manifest_revision = p_observed_binding_manifest_revision
    and binding_manifest_sha256 = p_observed_binding_manifest_sha256
    and valid_until > v_now for share;
  if v_config.id is null or v_control.id is null or v_policy.id is null
     or v_deployment.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_config.ai_polish_enabled
     or v_config.active_routing_policy_version_id is distinct from v_policy.id
     or v_control.closing_cycle_id is null
     or v_control.reopened_at is not null
     or v_policy.legal_bundle_version is distinct from public.current_ai_terms_version()
     or v_deployment.environment is distinct from (
       select environment from public.admin_environment where id = true
     )
     or v_deployment.project_ref is distinct from (
       select project_ref from public.admin_environment where id = true
     ) then
    raise exception 'READBACK_NOT_READY' using errcode = '23514';
  end if;
  v_evidence := public.admin_assert_policy_validation_reports_v1(
    v_policy.id, p_validation_report_ids, v_now
  );
  if (v_evidence ->> 'reviewedDeploymentId')::uuid is distinct from v_deployment.id then
    raise exception 'READBACK_DEPLOYMENT_MISMATCH' using errcode = '23514';
  end if;
  v_report_ids := array(select jsonb_array_elements_text(
    v_evidence -> 'validationReportIds'
  )::uuid);
  v_routes := v_evidence -> 'effectiveRoutes';
  v_routes_sha256 := encode(extensions.digest(
    convert_to(v_routes::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_expires_at := least(
    v_now + interval '10 minutes',
    v_deployment.valid_until,
    (v_evidence ->> 'expiresAt')::timestamptz
  );
  if v_expires_at <= v_now then
    raise exception 'READBACK_NOT_READY' using errcode = '23514';
  end if;
  v_report_sha256 := encode(extensions.digest(convert_to(concat_ws(E'\n',
    'admin_runtime_readback_v1', v_control.closing_cycle_id::text,
    v_control.revision::text, v_config.config_generation::text,
    v_policy.id::text, v_policy.legal_bundle_version,
    v_deployment.id::text, v_deployment.runtime_build_id,
    v_deployment.binding_manifest_revision, v_deployment.binding_manifest_sha256,
    array_to_string(v_report_ids, ','), v_routes_sha256,
    to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    to_char(v_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ), 'UTF8'), 'sha256'), 'hex');
  insert into public.admin_runtime_readback_reports_v1(
    closing_cycle_id, control_revision, config_generation,
    policy_version_id, legal_bundle_version, reviewed_deployment_id,
    runtime_build_id, binding_manifest_revision, binding_manifest_sha256,
    validation_report_ids, effective_routes, effective_routes_sha256,
    checked_at, expires_at, report_sha256
  ) values (
    v_control.closing_cycle_id, v_control.revision, v_config.config_generation,
    v_policy.id, v_policy.legal_bundle_version, v_deployment.id,
    v_deployment.runtime_build_id, v_deployment.binding_manifest_revision,
    v_deployment.binding_manifest_sha256, v_report_ids, v_routes,
    v_routes_sha256, v_now, v_expires_at, v_report_sha256
  ) returning * into v_readback;
  return jsonb_build_object(
    'schemaVersion', 'admin_runtime_readback_v1',
    'reportId', v_readback.id,
    'closingCycleId', v_readback.closing_cycle_id,
    'controlRevision', v_readback.control_revision::text,
    'configGeneration', v_readback.config_generation::text,
    'policyVersionId', v_readback.policy_version_id,
    'legalBundleVersion', v_readback.legal_bundle_version,
    'reviewedDeploymentId', v_readback.reviewed_deployment_id,
    'runtimeBuildId', v_readback.runtime_build_id,
    'bindingManifestRevision', v_readback.binding_manifest_revision,
    'bindingManifestSha256', v_readback.binding_manifest_sha256,
    'validationReportIds', to_jsonb(v_readback.validation_report_ids),
    'effectiveRoutes', v_readback.effective_routes,
    'checkedAt', v_readback.checked_at,
    'expiresAt', v_readback.expires_at,
    'reportSha256', v_readback.report_sha256
  );
end;
$$;

create function public.admin_reopen_ai_v1(
  p_environment text,
  p_project_ref text,
  p_readback_report_id uuid,
  p_expected_closing_cycle_id uuid,
  p_expected_control_revision bigint,
  p_expected_policy_version_id uuid,
  p_expected_config_generation bigint,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_payload jsonb;
  v_replay jsonb;
  v_now timestamptz := clock_timestamp();
  v_config public.ai_feature_config%rowtype;
  v_control public.admin_ai_control_state_v1%rowtype;
  v_readback public.admin_runtime_readback_reports_v1%rowtype;
  v_audit uuid;
  v_result jsonb;
begin
  v_actor := public.admin_assert_write_actor_v1(p_environment, p_project_ref, false);
  perform public.admin_assert_jwt_control_mode_v1();
  v_payload := jsonb_build_object(
    'readbackReportId', p_readback_report_id,
    'expectedClosingCycleId', p_expected_closing_cycle_id,
    'expectedControlRevision', p_expected_control_revision,
    'expectedPolicyVersionId', p_expected_policy_version_id,
    'expectedConfigGeneration', p_expected_config_generation,
    'reason', p_reason
  );
  v_replay := public.admin_lock_committed_operation_v1(
    v_actor, 'ai_reopen', p_idempotency_key, v_payload
  );
  if (v_replay ->> 'found')::boolean then
    return public.admin_replayed_operation_v1(v_replay, 'ai_reopen', p_idempotency_key);
  end if;
  if not public.admin_has_recent_totp_v1(v_actor) then
    raise exception 'STEP_UP_REQUIRED' using errcode = '42501';
  end if;
  if p_reason is null or p_reason <> btrim(p_reason) or length(p_reason) not between 1 and 500 then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  select * into v_config from public.ai_feature_config where id = true for update;
  select * into v_control from public.admin_ai_control_state_v1 where id = true for update;
  select * into v_readback from public.admin_runtime_readback_reports_v1
  where id = p_readback_report_id for share;
  if v_config.id is null or v_control.id is null or v_readback.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_config.ai_polish_enabled
     or v_control.closing_cycle_id is distinct from p_expected_closing_cycle_id
     or v_control.reopened_at is not null
     or v_control.revision is distinct from p_expected_control_revision
     or v_config.active_routing_policy_version_id is distinct from p_expected_policy_version_id
     or v_config.config_generation is distinct from p_expected_config_generation
     or (v_readback.closing_cycle_id, v_readback.control_revision,
         v_readback.config_generation, v_readback.policy_version_id)
        is distinct from
        (v_control.closing_cycle_id, v_control.revision,
         v_config.config_generation, v_config.active_routing_policy_version_id)
     or v_readback.legal_bundle_version is distinct from public.current_ai_terms_version()
     or v_readback.expires_at <= v_now
     or not exists (
       select 1 from public.admin_reviewed_deployments_v1 as deployment
       where deployment.id = v_readback.reviewed_deployment_id
         and deployment.valid_until > v_now
         and deployment.runtime_build_id = v_readback.runtime_build_id
         and deployment.binding_manifest_revision = v_readback.binding_manifest_revision
         and deployment.binding_manifest_sha256 = v_readback.binding_manifest_sha256
     )
     or exists (
       select 1 from unnest(v_readback.validation_report_ids) as selected(id)
       left join public.admin_validation_reports_v1 as report
         on report.id = selected.id and report.passed and report.expires_at > v_now
       where report.id is null
     ) then
    raise exception 'NOT_READY' using errcode = '23514';
  end if;
  update public.ai_feature_config set ai_polish_enabled = true where id = true;
  update public.admin_ai_control_state_v1 set
    revision = revision + 1,
    reopened_at = clock_timestamp()
  where id = true returning * into v_control;
  insert into public.admin_audit_events(operation, actor, target_id, reason)
  values ('ai_reopen', v_actor::text, p_expected_policy_version_id, p_reason)
  returning id into v_audit;
  v_result := jsonb_build_object(
    'schemaVersion', 'admin_ai_control_result_v1',
    'aiEnabled', true,
    'controlRevision', v_control.revision::text,
    'closingCycleId', v_control.closing_cycle_id,
    'configGeneration', v_config.config_generation::text,
    'activePolicyVersionId', v_config.active_routing_policy_version_id,
    'readbackReportId', v_readback.id
  );
  return public.admin_commit_operation_v1(
    v_actor, 'ai_reopen', p_idempotency_key, v_payload, v_result, v_audit
  );
end;
$$;

create function public.admin_get_ai_control_state_v1(
  p_environment text,
  p_project_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_result jsonb;
begin
  v_actor := public.admin_assert_actor_v1(p_environment, p_project_ref);
  select jsonb_build_object(
    'schemaVersion', 'admin_ai_control_state_v1',
    'aiEnabled', config.ai_polish_enabled,
    'globalDailyLimit', config.global_daily_limit,
    'activePolicyVersionId', config.active_routing_policy_version_id,
    'configGeneration', config.config_generation::text,
    'controlRevision', control.revision::text,
    'closingCycleId', control.closing_cycle_id,
    'closedAt', control.closed_at,
    'reopenedAt', control.reopened_at,
    'writesEnabled', environment.control_plane_mode = 'jwt_v1'
  ) into v_result
  from public.admin_environment as environment
  cross join public.ai_feature_config as config
  cross join public.admin_ai_control_state_v1 as control
  where environment.id = true and config.id = true and control.id = true;
  if v_result is null then raise exception 'UNAVAILABLE' using errcode = 'P0001'; end if;
  return v_result;
end;
$$;

-- This is intentionally not granted. A DB owner invokes it only after
-- external build/operator readiness has been established. Privilege changes
-- and mode adoption are transactional; normal migration application stays
-- in legacy mode.
create function public.admin_cutover_authority_v1(
  p_reviewed_deployment_id uuid,
  p_validation_report_ids uuid[],
  p_expected_environment_revision bigint,
  p_expected_control_revision bigint,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_environment public.admin_environment%rowtype;
  v_config public.ai_feature_config%rowtype;
  v_control public.admin_ai_control_state_v1%rowtype;
  v_policy public.ai_routing_policy_versions%rowtype;
  v_evidence jsonb;
  v_cycle uuid := extensions.gen_random_uuid();
  v_audit uuid;
begin
  if session_user not in ('postgres', 'supabase_admin') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_reason is null or p_reason <> btrim(p_reason) or length(p_reason) not between 1 and 500 then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(172911, 7);
  select * into v_environment from public.admin_environment where id = true for update;
  select * into v_config from public.ai_feature_config where id = true for update;
  select * into v_control from public.admin_ai_control_state_v1 where id = true for update;
  if v_environment.id is null or v_config.id is null or v_control.id is null then
    raise exception 'UNAVAILABLE' using errcode = 'P0001';
  end if;
  if v_environment.control_plane_mode is distinct from 'legacy'
     or v_environment.revision is distinct from p_expected_environment_revision
     or v_control.revision is distinct from p_expected_control_revision
     or v_config.ai_polish_enabled
     or v_config.active_routing_policy_version_id is null
     or not exists (
       select 1 from public.admin_principals as principal
       join auth.users as account on account.id = principal.user_id
       where principal.revoked_at is null and account.deleted_at is null
         and not coalesce(account.is_anonymous, false)
         and (account.banned_until is null or account.banned_until <= clock_timestamp())
         and (account.email_confirmed_at is not null or account.phone_confirmed_at is not null)
     ) then
    raise exception 'CUTOVER_NOT_READY' using errcode = '23514';
  end if;
  select * into v_policy from public.ai_routing_policy_versions
  where id = v_config.active_routing_policy_version_id for update;
  if not found or v_policy.status not in ('canary', 'active')
     or v_policy.legal_bundle_version is distinct from public.current_ai_terms_version() then
    raise exception 'CUTOVER_NOT_READY' using errcode = '23514';
  end if;
  v_evidence := public.admin_assert_policy_validation_reports_v1(
    v_policy.id, p_validation_report_ids, clock_timestamp()
  );
  if (v_evidence ->> 'reviewedDeploymentId')::uuid is distinct from p_reviewed_deployment_id then
    raise exception 'CUTOVER_NOT_READY' using errcode = '23514';
  end if;
  if to_regprocedure('public.admin_disable_ai_v1(text,text,bigint,text,uuid)') is null
     or to_regprocedure('public.admin_set_ai_routing_pointer_v1(text,text,uuid,uuid[],bigint,uuid,bigint,text,uuid)') is null
     or to_regprocedure('public.admin_clear_ai_routing_pointer_v1(text,text,uuid[],bigint,uuid,bigint,text,uuid)') is null
     or to_regprocedure('public.record_admin_runtime_readback_v1(uuid,uuid,uuid[],text,text,text)') is null
     or to_regprocedure('public.admin_reopen_ai_v1(text,text,uuid,uuid,bigint,uuid,bigint,text,uuid)') is null
     or to_regprocedure('public.admin_set_membership_v1(text,text,uuid,boolean,bigint,text,uuid)') is null
     or to_regprocedure('public.admin_update_provider_defaults_v1(text,text,uuid,text,text,text,text,text,boolean,bigint,text,uuid)') is null
     or to_regprocedure('public.admin_create_provider_profile_v1(text,text,uuid,text,text,text,text,uuid)') is null
     or to_regprocedure('public.admin_create_profile_version_v2(text,text,uuid,integer,text,text,text,text,text,text,text,text,text,jsonb,text,uuid)') is null
     or to_regprocedure('public.admin_create_price_version_v1(text,text,uuid,text,integer,text,text,timestamptz,timestamptz,timestamptz,timestamptz,text,timestamptz,text,jsonb,jsonb,text,uuid)') is null
     or to_regprocedure('public.admin_set_global_daily_limit_v1(text,text,integer,integer,bigint,text,uuid)') is null
     or to_regprocedure('public.admin_seal_price_for_activation_v1(text,text,uuid,text,uuid,text,uuid)') is null
     or to_regprocedure('public.admin_transition_profile_version_v1(text,text,uuid,text,uuid,text,uuid)') is null
     or to_regprocedure('public.admin_create_routing_policy_v1(text,text,text,integer,jsonb,uuid,text,text,uuid[],text,uuid)') is null
     or to_regprocedure('public.admin_transition_routing_policy_v1(text,text,uuid,text,uuid[],text,uuid)') is null
     or to_regprocedure('public.admin_close_price_version_v1(text,text,uuid,timestamptz,uuid,uuid,text,uuid)') is null
     or to_regprocedure('public.admin_retire_profile_version_v1(text,text,uuid,uuid,text,uuid)') is null
     or to_regprocedure('public.admin_retire_provider_profile_v1(text,text,uuid,uuid,text,uuid)') is null then
    raise exception 'CUTOVER_SCHEMA_MISMATCH' using errcode = '23514';
  end if;

  execute 'revoke update (ai_polish_enabled, global_daily_limit, enabled_user_allowlist) on public.ai_feature_config from service_role';
  execute 'revoke execute on function public.transition_ai_routing_policy_v2(uuid,text,text,text,text,text,text,timestamptz,text) from service_role';
  execute 'revoke execute on function public.set_ai_routing_policy_pointer_v1(uuid,text,text,text,text,text,timestamptz,text) from service_role';
  execute 'revoke execute on function public.clear_ai_routing_policy_pointer_v1(uuid,text,text,text,text,text,timestamptz,text) from service_role';
  execute 'revoke execute on function public.retire_ai_provider_profile_version_v1(uuid,text,text,text,text,text,timestamptz,text) from service_role';
  execute 'revoke execute on function public.retire_ai_provider_profile_v1(uuid,text,text,text,text,text,timestamptz,text) from service_role';
  execute 'revoke execute on function public.close_ai_price_version_v1(uuid,timestamptz,uuid,text,text,text,text,text,timestamptz,text) from service_role';
  execute 'revoke execute on function public.seal_ai_price_for_activation_v1(uuid,text,text,text,timestamptz,timestamptz,jsonb,jsonb,text,text,text,text,text,timestamptz,text) from service_role';
  execute 'revoke execute on function public.transition_ai_provider_profile_version_v1(uuid,text,text,text,text,text,text,timestamptz,text) from service_role';
  execute 'revoke execute on function public.create_ai_routing_policy_version_v1(uuid,text,integer,text,jsonb,uuid,text,text,text,text,text,text,text,timestamptz,text) from service_role';

  update public.admin_ai_control_state_v1 set
    revision = revision + 1,
    closing_cycle_id = v_cycle,
    closed_at = clock_timestamp(),
    closed_by = null,
    reopened_at = null
  where id = true returning * into v_control;
  update public.admin_environment set
    control_plane_mode = 'jwt_v1', revision = revision + 1
  where id = true returning * into v_environment;
  insert into public.admin_audit_events(operation, actor, target_id, reason)
  values ('admin_authority_cutover', 'db_operator', p_reviewed_deployment_id, p_reason)
  returning id into v_audit;
  return jsonb_build_object(
    'schemaVersion', 'admin_authority_cutover_v1',
    'auditId', v_audit,
    'controlPlaneMode', v_environment.control_plane_mode,
    'environmentRevision', v_environment.revision::text,
    'controlRevision', v_control.revision::text,
    'closingCycleId', v_control.closing_cycle_id,
    'activePolicyVersionId', v_config.active_routing_policy_version_id,
    'configGeneration', v_config.config_generation::text,
    'reviewedDeploymentId', p_reviewed_deployment_id,
    'validationReportIds', v_evidence -> 'validationReportIds'
  );
end;
$$;

-- Preserve the read DTO while exposing the actual dark/cutover mode.
create or replace function public.admin_get_context_v1(
  p_environment text,
  p_project_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_actor uuid; v_result jsonb;
begin
  v_actor := public.admin_assert_actor_v1(p_environment, p_project_ref);
  select jsonb_build_object(
    'schemaVersion','admin_context_v1',
    'actor',jsonb_build_object('userId',v_actor,'email',u.email,'revision',p.revision::text),
    'environment',jsonb_build_object('name',e.environment,'projectRef',e.project_ref,
      'controlPlaneMode',e.control_plane_mode,'revision',e.revision::text),
    'features',jsonb_build_object('aiEnabled',f.ai_polish_enabled,'globalDailyLimit',f.global_daily_limit,
      'allowlistedUsers',coalesce(cardinality(f.enabled_user_allowlist),0),'configGeneration',f.config_generation::text,
      'activePolicyVersionId',f.active_routing_policy_version_id,'currentLegalBundle',public.current_ai_terms_version()),
    'capabilities',jsonb_build_object('writes',e.control_plane_mode='jwt_v1')
  ) into v_result from public.admin_environment e cross join public.ai_feature_config f
    join public.admin_principals p on p.user_id=v_actor join auth.users u on u.id=p.user_id
    where e.id=true and f.id=true;
  if v_result is null then raise exception 'UNAVAILABLE' using errcode='P0001'; end if;
  return v_result;
end;
$$;

revoke all on function public.admin_guard_control_evidence_v1(),
  public.admin_assert_jwt_control_mode_v1(),
  public.admin_replayed_operation_v1(jsonb,text,uuid),
  public.admin_policy_effective_routes_v1(uuid),
  public.admin_assert_policy_validation_reports_v1(uuid,uuid[],timestamptz),
  public.admin_disable_ai_v1(text,text,bigint,text,uuid),
  public.admin_set_ai_routing_pointer_v1(text,text,uuid,uuid[],bigint,uuid,bigint,text,uuid),
  public.admin_clear_ai_routing_pointer_v1(text,text,uuid[],bigint,uuid,bigint,text,uuid),
  public.record_admin_runtime_readback_v1(uuid,uuid,uuid[],text,text,text),
  public.admin_reopen_ai_v1(text,text,uuid,uuid,bigint,uuid,bigint,text,uuid),
  public.admin_get_ai_control_state_v1(text,text),
  public.admin_cutover_authority_v1(uuid,uuid[],bigint,bigint,text)
  from public, anon, authenticated, service_role;

grant execute on function public.admin_disable_ai_v1(text,text,bigint,text,uuid),
  public.admin_set_ai_routing_pointer_v1(text,text,uuid,uuid[],bigint,uuid,bigint,text,uuid),
  public.admin_clear_ai_routing_pointer_v1(text,text,uuid[],bigint,uuid,bigint,text,uuid),
  public.admin_reopen_ai_v1(text,text,uuid,uuid,bigint,uuid,bigint,text,uuid),
  public.admin_get_ai_control_state_v1(text,text)
  to authenticated;
grant execute on function public.record_admin_runtime_readback_v1(uuid,uuid,uuid[],text,text,text)
  to service_role;

commit;
