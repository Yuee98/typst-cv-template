begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
-- Real SQL role/public-RPC boundary with a privileged synthetic live Auth session.
-- This fixture is not evidence of a GoTrue password sign-in. All changes roll back.
select common.audit_context(null, null, 'Rollback-only legal Markdown RPC fixture', 'SYSTEM');
insert into auth.users(id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-000000000881', 'legal-markdown@example.invalid', clock_timestamp());
insert into auth.sessions(id, user_id) values
  ('00000000-0000-4000-8000-000000000882', '00000000-0000-4000-8000-000000000881');
do $$begin
  if not exists(select 1 from admin.environment) then
    perform admin.initialize('LOCAL', '00000000-0000-4000-8000-000000000881');
  else
    insert into admin.members(auth_user_id) values('00000000-0000-4000-8000-000000000881');
  end if;
end$$;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', '00000000-0000-4000-8000-000000000881',
  'session_id', '00000000-0000-4000-8000-000000000882', 'role', 'authenticated', 'aal', 'aal1')::text, true);
select set_config('legal_test.guard', jsonb_build_object(
  'contract_code', 'cv_app_db_2', 'database_instance_id', (select database_instance_id from admin.environment),
  'reason', 'Rollback-only exact legal reader input regression')::text, true);
create function pg_temp.save_document(p_value text, p_field text default 'zh_body', p_id text default null, p_enabled boolean default true)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_result jsonb;
begin
  set local role authenticated;
  v_result = public.admin_legal_document_save(current_setting('legal_test.guard')::jsonb || jsonb_build_object(
    'operation_key', gen_random_uuid(), 'id', p_id, 'expected_revision', case when p_id is null then null else '1' end,
    'kind', 'AI_PROVIDER', 'zh_title', '测试接收方说明', 'en_title', 'Synthetic recipient disclosure',
    'zh_body', 'Synthetic legal body.', 'en_body', 'Synthetic legal body.', 'effective_date', '2026-11-09',
    'recipient_name', 'Synthetic recipient', 'enabled', p_enabled) || jsonb_build_object(p_field, p_value));
  reset role;
  return v_result;
exception when others then
  reset role;
  raise;
end
$$;
grant execute on function pg_temp.save_document(text, text, text, boolean) to authenticated;
select set_config('legal_test.before', jsonb_build_object(
  'documents', (select count(*) from legal.documents), 'audits', (select count(*) from audit.documents),
  'operations', (select count(*) from admin.operations), 'control', (select to_jsonb(c) from ai.runtime_control c))::text, true);
select throws_ok($$select pg_temp.save_document('<p>bad</p>')$$, 'P0001', 'INVALID_REQUEST', 'authenticated RPC rejects HTML before a poisoned catalog row can commit');
select throws_ok($$select pg_temp.save_document('![alt](https://example.com/image.png)', 'en_body')$$, 'P0001', 'INVALID_REQUEST', 'the second language rejects images too');
select throws_ok($$select pg_temp.save_document(E'```\ncode\n```')$$, 'P0001', 'INVALID_REQUEST', 'fenced content is rejected');
select throws_ok($$select pg_temp.save_document('# Unsupported')$$, 'P0001', 'INVALID_REQUEST', 'unsupported heading level is rejected');
select throws_ok($$select pg_temp.save_document('* Unsupported list')$$, 'P0001', 'INVALID_REQUEST', 'unsupported list syntax is rejected');
select throws_ok($$select pg_temp.save_document('[bad](javascript:alert)')$$, 'P0001', 'INVALID_REQUEST', 'unsafe link protocols are rejected');
select throws_ok($$select pg_temp.save_document('[bad](https://user:password@example.com)')$$, 'P0001', 'INVALID_REQUEST', 'credential-bearing links are rejected');
select throws_ok($$select pg_temp.save_document('[bad](https://example.com:65536)')$$, 'P0001', 'INVALID_REQUEST', 'out-of-range ports are rejected');
select throws_ok($$select pg_temp.save_document('[bad](https://-invalid.example)')$$, 'P0001', 'INVALID_REQUEST', 'invalid authority labels are rejected');
select throws_ok($$select pg_temp.save_document(U&'\00A0\FEFF')$$, 'P0001', 'INVALID_REQUEST', 'JS-trim-only whitespace cannot become a document body');
select throws_ok($$select pg_temp.save_document('<p>disabled bad draft</p>', 'en_body', null, false)$$, 'P0001', 'INVALID_REQUEST', 'disabled drafts cannot bypass the write invariant');
select throws_ok($$select pg_temp.save_document(repeat('😀', 32769))$$, 'P0001', 'INVALID_REQUEST', 'body size uses the reader UTF-16 bound');
select throws_ok($$select pg_temp.save_document(repeat('😀', 251), 'zh_title')$$, 'P0001', 'INVALID_REQUEST', 'title size uses the reader UTF-16 bound');
select throws_ok($$select pg_temp.save_document(repeat('😀', 251), 'recipient_name')$$, 'P0001', 'INVALID_REQUEST', 'recipient size uses the reader UTF-16 bound');
select throws_ok($$select pg_temp.save_document(U&'\00A0\FEFF', 'zh_title')$$, 'P0001', 'INVALID_REQUEST', 'Unicode-whitespace-only titles cannot poison the strict reader');
select throws_ok($$select pg_temp.save_document(U&'\FEFF\3000', 'recipient_name')$$, 'P0001', 'INVALID_REQUEST', 'Unicode-whitespace-only recipients cannot poison the strict reader');
select throws_ok($$select pg_temp.save_document('10000-01-01', 'effective_date')$$, 'P0001', 'INVALID_REQUEST', 'dates outside a four-digit positive year are rejected');
select is(jsonb_build_object(
  'documents', (select count(*) from legal.documents), 'audits', (select count(*) from audit.documents),
  'operations', (select count(*) from admin.operations), 'control', (select to_jsonb(c) from ai.runtime_control c)),
  current_setting('legal_test.before')::jsonb, 'failed creates leave documents, audits, operation receipts and runtime revision unchanged');
select set_config('legal_test.document_id', (pg_temp.save_document(E'## Heading\n\nParagraph [safe](https://example.com:443/路径?q=%20#片段).\n\n- Item\n- [IPv6](https://[2001:db8::1]:8443/legal)'))->>'entity_id', true);
select set_config('legal_test.before_update', jsonb_build_object(
  'document', (select to_jsonb(d) from legal.documents d where id=current_setting('legal_test.document_id')::bigint),
  'audits', (select count(*) from audit.documents), 'operations', (select count(*) from admin.operations),
  'control', (select to_jsonb(c) from ai.runtime_control c))::text, true);
select throws_ok($$select pg_temp.save_document('1. Unsupported list', 'en_body', current_setting('legal_test.document_id'))$$, 'P0001', 'INVALID_REQUEST', 'updates reject malformed translated Markdown');
select is(jsonb_build_object(
  'document', (select to_jsonb(d) from legal.documents d where id=current_setting('legal_test.document_id')::bigint),
  'audits', (select count(*) from audit.documents), 'operations', (select count(*) from admin.operations),
  'control', (select to_jsonb(c) from ai.runtime_control c)), current_setting('legal_test.before_update')::jsonb,
  'failed update preserves original body, digest, revision, audit, receipt and runtime revision');
select throws_ok($$update legal.documents set zh_body='<script>bad</script>' where id=current_setting('legal_test.document_id')::bigint$$, 'P0001', 'INVALID_REQUEST', 'owner writes use the same trigger guard rather than bypassing the RPC');
select ok(legal.markdown_valid(repeat('中', 65536)), 'the full existing 65536-character Chinese limit remains valid');
select ok(legal.markdown_valid(repeat('😀', 32768)) and not legal.markdown_valid(repeat('😀', 32769)), 'supplementary characters match exact JS UTF-16 capacity');
select ok(legal.markdown_valid(E'## \n\n- \n\n[unmatched](javascript:bad link)'), 'empty heading/list and unmatched link literals keep existing renderer semantics');
select ok(not exists(select 1 from legal.documents where not legal.markdown_valid(zh_body) or not legal.markdown_valid(en_body)), 'every enabled canonical seed remains valid under the write/reader grammar');
select ok(not exists(
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='legal' and p.proname in('utf16_length','href_valid','markdown_valid')
    and (p.provolatile<>'i' or p.prosecdef or p.proconfig is distinct from array['search_path=""'])),
  'pure legal validators are immutable invokers with an empty fixed search_path');
select ok((select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='legal' and p.proname in('utf16_length','href_valid','markdown_valid'))=3, 'all three private reader-input helpers exist');
select ok(not exists(
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join pg_roles r
  where n.nspname='legal' and p.proname in('utf16_length','href_valid','markdown_valid')
    and r.rolname in('anon','authenticated','service_role') and has_function_privilege(r.oid,p.oid,'EXECUTE')),
  'API roles cannot invoke private legal validation helpers directly');
select ok(not exists(
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  where n.nspname='legal' and p.proname in('utf16_length','href_valid','markdown_valid') and a.grantee=0 and a.privilege_type='EXECUTE'),
  'PUBLIC has no helper EXECUTE permission');
select ok((select bool_and(has_function_privilege('app_api_owner',p.oid,'EXECUTE')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='legal' and p.proname in('utf16_length','href_valid','markdown_valid')), 'the existing RPC owner can run the invoker validators');
select * from finish();
rollback;
