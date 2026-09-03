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
    'get_ai_polish_execution_snapshot_v2', 'start_ai_polish_provider_attempt_v2'
  );
