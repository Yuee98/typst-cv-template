-- Read-only owner query. Copy the JSON result into the successor authority
-- fixture after applying I02/I03; do not alter the frozen CFG001 v1 values.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
select jsonb_agg(jsonb_build_object(
  'schema', n.nspname,
  'name', p.proname,
  'identityArguments', pg_get_function_identity_arguments(p.oid),
  'prokind', p.prokind,
  'prosecdef', p.prosecdef,
  'owner', pg_get_userbyid(p.proowner),
  'definitionSha256', encode(extensions.digest(replace(replace(pg_get_functiondef(p.oid), chr(13) || chr(10), chr(10)), chr(13), chr(10)), 'sha256'), 'hex'),
  'publicExecute', exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
    where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
  ),
  'anonExecute', has_function_privilege('anon', p.oid, 'EXECUTE'),
  'authenticatedExecute', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
  'serviceRoleExecute', has_function_privilege('service_role', p.oid, 'EXECUTE')
) order by p.proname)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'admin_guard_audit_v1', 'admin_bootstrap_v1', 'admin_assert_actor_v1',
    'admin_get_context_v1', 'admin_records_query_v1', 'admin_list_records_v1',
    'admin_get_record_v1', 'ai_endpoint_shape_v2',
    'guard_ai_provider_directory_v2', 'guard_ai_profile_provider_v2',
    'guard_ai_profile_binding_v2', 'guard_ai_attempt_binding_v2',
    'get_ai_polish_execution_snapshot_v2', 'start_ai_polish_provider_attempt_v2',
    'guard_ai_runtime_code_capability_v2',
    'ai_legal_display_content_shape_v2',
    'guard_ai_legal_display_version_v2',
    'guard_ai_current_legal_bundle_v2',
    'get_ai_current_legal_bundle_v2',
    'guard_ai_runtime_target_binding_v2',
    'guard_user_ai_legal_acceptance_v2',
    'has_accepted_ai_legal_disclosure_v2',
    'accept_ai_legal_disclosure_v2',
    'get_ai_legal_display_v2',
    'get_ai_polish_availability_v2',
    'guard_ai_request_legal_acceptance_v2',
    'admin_guard_committed_operation_v1',
    'admin_canonical_operation_payload_sha256_v1',
    'admin_has_recent_totp_v1',
    'admin_assert_write_actor_v1',
    'admin_lock_committed_operation_v1',
    'admin_commit_operation_v1',
    'admin_get_committed_operation_v1',
    'admin_get_write_authority_v1',
    'admin_guard_validation_evidence_v1',
    'admin_import_reviewed_deployment_v1',
    'get_admin_validation_candidate_v1',
    'record_admin_validation_report_v1',
    'get_admin_runtime_validation_v1',
    'get_ai_polish_execution_snapshot_v3'
  );
