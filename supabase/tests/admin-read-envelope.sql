-- Real authenticated role, local-only rollback fixtures; no Provider calls.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000310', 'admin-read@fixture.invalid'),
  ('00000000-0000-4000-8000-000000000311', 'admin-read-other@fixture.invalid');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-000000000312', '00000000-0000-4000-8000-000000000310'),
  ('00000000-0000-4000-8000-000000000313', '00000000-0000-4000-8000-000000000311');
do $$
begin
  if not exists (select 1 from admin.environment) then
    perform admin.initialize ('LOCAL', '00000000-0000-4000-8000-000000000310');
  else
    insert into admin.members (auth_user_id) values ('00000000-0000-4000-8000-000000000310');
  end if;
end
$$;
create temporary table admin_read_fixture (key text primary key, value jsonb);
insert into admin_read_fixture values (
  'base', (
    select jsonb_build_object(
      'contract_code', contract_code,
      'expected_environment', name,
      'database_instance_id', database_instance_id,
      'section', 'overview'
    )
    from admin.environment where id = 1
  )
), (
  'provider', (select to_jsonb(p.external_id) from ai.providers p where code = 'DEEPSEEK')
);
grant select on pg_temp.admin_read_fixture to authenticated;
create function pg_temp.admin_read_input (p_extra jsonb default '{}')
returns jsonb language sql volatile set search_path = '' as $$
select value || p_extra from pg_temp.admin_read_fixture where key = 'base'
$$;
grant execute on function pg_temp.admin_read_input (jsonb) to authenticated;

select ok((select prosecdef and proowner = 'app_api_owner'::regrole and proconfig = array['search_path=""'] from pg_catalog.pg_proc where oid = 'public.admin_read(jsonb)'::regprocedure), 'read envelope has restricted definer owner and empty search path');
select ok(has_function_privilege('authenticated', 'public.admin_read(jsonb)', 'execute') and not has_function_privilege('anon', 'public.admin_read(jsonb)', 'execute') and not has_function_privilege('service_role', 'public.admin_read(jsonb)', 'execute'), 'only authenticated API role may execute Admin read envelope');
select ok(not has_schema_privilege('authenticated', 'admin', 'usage') and not has_table_privilege('authenticated', 'admin.members', 'select'), 'combined reads add no private schema or table grants');
select ok(not has_schema_privilege('app_api_owner', 'public', 'create'), 'temporary owner-transfer CREATE grant is revoked');

select set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-4000-8000-000000000310', 'session_id', '00000000-0000-4000-8000-000000000312', 'aal', 'aal1')::text, true);
set local role authenticated;
select ok(not (public.admin_context() ? 'legal'), 'Admin context omits unused legal text');
select ok(pg_column_size(public.admin_context()) < 4096, 'Admin context remains a small identity and control DTO');
select diag(format('Admin context UTF8=%s bytes; dedicated legal current UTF8=%s bytes; context_has_legal=%s', octet_length(public.admin_context()::text), octet_length(public.legal_current()::text), public.admin_context() ? 'legal'));
select is(public.admin_read(pg_temp.admin_read_input()) -> 'context', public.admin_context(), 'warm overview preserves the exact current context');
select is(public.admin_read(pg_temp.admin_read_input()) -> 'data', 'null'::jsonb, 'overview data is explicitly null');
select is(public.admin_read(pg_temp.admin_read_input() - 'database_instance_id') -> 'context', public.admin_context(), 'cold read discovers identity through the same live Admin gate');
select is(public.admin_read(pg_temp.admin_read_input('{"section":"controls"}')) -> 'data', 'null'::jsonb, 'controls reuse slim context without a second payload');
select is(public.admin_read(pg_temp.admin_read_input('{"section":"providers","kind":"providers","limit":2}')) -> 'data', public.admin_records('providers', 2), 'provider page reuses the existing bounded projection');
select is(public.admin_read(pg_temp.admin_read_input(jsonb_build_object('section', 'providers', 'kind', 'providers', 'external_id', (select value #>> '{}' from pg_temp.admin_read_fixture where key = 'provider')))) -> 'data', public.admin_record('providers', (select value #>> '{}' from pg_temp.admin_read_fixture where key = 'provider')), 'detail reuses existing external-ID projection');
select is(public.admin_read(pg_temp.admin_read_input('{"section":"analytics","days":7}')) -> 'data', public.admin_analytics(7), 'analytics reuses the currency-separated daily aggregates');
select lives_ok($$select public.admin_read(pg_temp.admin_read_input(jsonb_build_object('section', section, 'kind', kind))) from (values ('users','users'),('users','members'),('profiles','profiles'),('profiles','profile_versions'),('prices','price_versions'),('policies','policies'),('policies','policy_versions'),('audit','events')) k(section,kind)$$, 'every allowed section and record-kind mapping works under authenticated');
select throws_ok($$select public.admin_read(pg_temp.admin_read_input('{"contract_code":"old"}'))$$, 'P0001', 'CLIENT_UPDATE_REQUIRED', 'wrong contract is rejected');
select throws_ok($$select public.admin_read(pg_temp.admin_read_input('{"database_instance_id":"00000000-0000-4000-8000-000000000000"}'))$$, 'P0001', 'CLIENT_UPDATE_REQUIRED', 'stale instance cannot silently rebind');
select throws_ok($$select public.admin_read(pg_temp.admin_read_input() - 'contract_code')$$, 'P0001', 'CLIENT_UPDATE_REQUIRED', 'contract is mandatory even on cold reads');
select throws_ok($$select public.admin_read(pg_temp.admin_read_input(jsonb_build_object('expected_environment', case when pg_temp.admin_read_input()->>'expected_environment'='LOCAL' then 'PRODUCTION' else 'LOCAL' end)))$$, 'P0001', 'CLIENT_UPDATE_REQUIRED', 'wrong deployment environment is rejected');
select throws_ok($$select public.admin_read(pg_temp.admin_read_input('{"database_instance_id":null}'))$$, 'P0001', 'INVALID_REQUEST', 'null instance is not a cold-read request');
select throws_ok($$select public.admin_read(pg_temp.admin_read_input('{"database_instance_id":"not-a-uuid"}'))$$, 'P0001', 'INVALID_REQUEST', 'malformed instance is rejected');
select throws_ok($$select public.admin_read(pg_temp.admin_read_input('{"section":"providers","kind":"members"}'))$$, 'P0001', 'INVALID_REQUEST', 'section cannot select an unrelated record kind');
select throws_ok($$select public.admin_read(pg_temp.admin_read_input('{"section":"providers","kind":"operations"}'))$$, 'P0001', 'INVALID_REQUEST', 'internal generic record kinds are not exposed through UI section routing');
select throws_ok($$select public.admin_read(pg_temp.admin_read_input('{"section":"providers","kind":"providers","limit":101}'))$$, 'P0001', 'INVALID_REQUEST', 'page limit is bounded');
select throws_ok($$select public.admin_read(pg_temp.admin_read_input('{"section":"providers","kind":"providers","limit":"25"}'))$$, 'P0001', 'INVALID_REQUEST', 'numeric strings are not accepted as limits');
select throws_ok($$select public.admin_read(pg_temp.admin_read_input('{"section":"providers","kind":"providers","external_id":null}'))$$, 'P0001', 'INVALID_REQUEST', 'null detail target cannot become a list');
select throws_ok($$select public.admin_read(pg_temp.admin_read_input('{"section":"providers","kind":"providers","external_id":"prv_000000000000","limit":25}'))$$, 'P0001', 'INVALID_REQUEST', 'list-only fields are rejected on detail requests');
select throws_ok($$select public.admin_read(pg_temp.admin_read_input('{"section":"providers","kind":"providers","after":null}'))$$, 'P0001', 'INVALID_REQUEST', 'cursor types are checked');
select throws_ok($$select public.admin_read(pg_temp.admin_read_input('{"days":7}'))$$, 'P0001', 'INVALID_REQUEST', 'analytics-only fields are rejected on overview');
select throws_ok($$select public.admin_read(pg_temp.admin_read_input('{"section":"analytics","days":32}'))$$, 'P0001', 'INVALID_REQUEST', 'analytics range is bounded to the UI contract');
select throws_ok($$select public.admin_read(pg_temp.admin_read_input('{"section":"analytics","days":7.5}'))$$, 'P0001', 'INVALID_REQUEST', 'analytics days must be an integer');
select throws_ok($$select public.admin_read(pg_temp.admin_read_input('{"unexpected":true}'))$$, 'P0001', 'INVALID_REQUEST', 'unknown fields fail closed');
select throws_ok($$select public.admin_read('[]')$$, 'P0001', 'INVALID_REQUEST', 'non-object inputs fail closed');
reset role;

update auth.sessions set not_after = clock_timestamp() - interval '1 second' where id = '00000000-0000-4000-8000-000000000312';
set local role authenticated;
select throws_ok($$select public.admin_read(pg_temp.admin_read_input())$$, 'P0001', 'UNAUTHORIZED', 'expired session is checked on every read');
reset role;
update auth.sessions set not_after = null where id = '00000000-0000-4000-8000-000000000312';
update auth.users set banned_until = clock_timestamp() + interval '1 hour' where id = '00000000-0000-4000-8000-000000000310';
set local role authenticated;
select throws_ok($$select public.admin_read(pg_temp.admin_read_input())$$, 'P0001', 'UNAUTHORIZED', 'banned account cannot reuse the envelope');
reset role;
update auth.users set banned_until = null where id = '00000000-0000-4000-8000-000000000310';
update admin.members set time_revoked = clock_timestamp() where auth_user_id = '00000000-0000-4000-8000-000000000310';
set local role authenticated;
select throws_ok($$select public.admin_read(pg_temp.admin_read_input())$$, 'P0001', 'FORBIDDEN', 'revoked membership cannot reuse the envelope');
reset role;
select set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-4000-8000-000000000311', 'session_id', '00000000-0000-4000-8000-000000000313', 'aal', 'aal1')::text, true);
set local role authenticated;
select throws_ok($$select public.admin_read(pg_temp.admin_read_input())$$, 'P0001', 'FORBIDDEN', 'ordinary authenticated user cannot read Admin context or data');
reset role;
set local role anon;
select throws_ok($$select public.admin_read('{}')$$, '42501', null, 'anonymous role cannot invoke the new RPC');
reset role;
set local role service_role;
select throws_ok($$select public.admin_read('{}')$$, '42501', null, 'service role cannot become an Admin through the new RPC');
reset role;

select * from finish();
rollback;
