begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
-- Privileged synthetic setup. This is not evidence of Auth/MFA verification.
select common.audit_context(null,null,'Disposable runtime fixture, synthetic prices; not provider invoices','SYSTEM');
insert into auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at) values
('00000000-0000-4000-8000-000000000091','authenticated','authenticated','runtime-fixture@example.invalid',clock_timestamp(),clock_timestamp(),clock_timestamp()),
('00000000-0000-4000-8000-000000000092','authenticated','authenticated','bootstrap-fixture@example.invalid',clock_timestamp(),clock_timestamp(),clock_timestamp()) on conflict(id) do nothing;
do $$begin if not exists(select 1 from admin.environment) then perform admin.initialize('LOCAL','00000000-0000-4000-8000-000000000092');end if;end $$;
insert into ai.configurations(name,adapter_id,endpoint_url,model_id,credential_ref,legal_document_id,enabled)
 select 'Synthetic runtime fixture '||adapter_id,adapter_id,endpoint_url,model_id,'AI_PROVIDER_KEY_FIXTURE_'||adapter_id,id,true from legal.documents where kind='AI_PROVIDER' and enabled and not exists(select 1 from ai.configurations where name='Synthetic runtime fixture '||adapter_id);
insert into ai.prices(config_id,currency,input_standard_nanos_per_million,input_cache_read_nanos_per_million,input_cache_write_nanos_per_million,output_nanos_per_million)
 select id,case when adapter_id=3 then 'USD' else 'CNY' end,1000000,100000,0,2000000 from ai.configurations c where name like 'Synthetic runtime fixture %' on conflict(config_id) do nothing;
update ai.routing_rules set enabled=false where enabled;
insert into ai.routing_rules(enabled) values(true);
insert into ai.routing_rule_configurations(rule_id,config_id,is_default) select(select max(id) from ai.routing_rules),id,adapter_id=1 from ai.configurations where name like 'Synthetic runtime fixture %';
insert into ai.allowed_users(auth_user_id) values('00000000-0000-4000-8000-000000000091') on conflict do nothing;
update ai.runtime_control set enabled=true,audience='ALLOWLIST',user_daily_limit=10000,global_daily_limit=10000,user_minute_limit=10000,revision=revision+1 where id=1;
select set_config('request.jwt.claims',jsonb_build_object('sub','00000000-0000-4000-8000-000000000091','role','authenticated')::text,false);
do $$declare g jsonb;d legal.documents;c legal.documents;begin
 g=jsonb_build_object('contract_code','cv_app_db_2','database_instance_id',(select database_instance_id from admin.environment),'expected_auth_user_id','00000000-0000-4000-8000-000000000091');
 select * into d from legal.documents where kind='TERMS';perform public.legal_accept_document(g||jsonb_build_object('document_id',d.id::text,'document_audit_id',d.document_audit_id::text));
 select * into c from legal.documents where kind='AI_COMMON';for d in select * from legal.documents where kind='AI_PROVIDER' and enabled loop
 perform public.legal_accept_ai(g||jsonb_build_object('common',jsonb_build_object('document_id',c.id::text,'document_audit_id',c.document_audit_id::text),'provider',jsonb_build_object('document_id',d.id::text,'document_audit_id',d.document_audit_id::text)));
 end loop;end $$;
-- No secret material or user's source data is emitted.
create function pg_temp.guard() returns jsonb language sql as $$ select jsonb_build_object('contract_code','cv_app_db_2','database_instance_id',(select database_instance_id from admin.environment),'owner_auth_user_id','00000000-0000-4000-8000-000000000091') $$;
create function pg_temp.reserve(p_adapter integer default 1) returns text language plpgsql as $$declare a jsonb;x jsonb;r jsonb;begin a=public.ai_availability(pg_temp.guard());select value into x from jsonb_array_elements(a->'configurations') where(value->>'adapter_id')::integer=p_adapter;r=public.ai_reserve(pg_temp.guard()||jsonb_build_object('client_request_key',extensions.gen_random_uuid(),'request_fingerprint',repeat('a',64),'config_id',x->>'config_id','expected_config_revision',x->>'revision','expected_control_revision',a->>'control_revision','common_document_audit_id',x#>>'{legal_display,common,document_audit_id}','provider_document_audit_id',x#>>'{legal_display,provider,document_audit_id}'));return r->>'request_id';end $$;
create function pg_temp.complete(p_req text,p_usage jsonb,p_bill boolean default true,p_state text default 'SUCCEEDED',p_retry boolean default false,p_complete boolean default true,p_no integer default 1) returns jsonb language sql as $$select public.ai_attempt_complete(pg_temp.guard()||jsonb_build_object('request_id',p_req,'attempt_no',p_no,'state',p_state,'transmitted',true,'provider_billable',p_bill,'retry_allowed',p_retry,'usage_complete',p_complete,'usage',p_usage))$$;
create function pg_temp.start(p_req text,p_no integer default 1) returns jsonb language sql as $$select public.ai_attempt_start(pg_temp.guard()||jsonb_build_object('request_id',p_req,'attempt_no',p_no)) $$;
create function pg_temp.finish(p_req text) returns jsonb language sql as $$select public.ai_finalize(pg_temp.guard()||jsonb_build_object('request_id',p_req)) $$;

-- Explicit privileged synthetic Auth facts for SQL permission testing, not real MFA-login evidence.
insert into auth.sessions(id,user_id) values('00000000-0000-4000-8000-000000000093','00000000-0000-4000-8000-000000000092');
insert into auth.mfa_factors(id,user_id,status,factor_type,created_at,updated_at) values('00000000-0000-4000-8000-000000000094','00000000-0000-4000-8000-000000000092','verified','totp',clock_timestamp(),clock_timestamp());
select set_config('request.jwt.claims',jsonb_build_object('sub','00000000-0000-4000-8000-000000000092','session_id','00000000-0000-4000-8000-000000000093','aal','aal2','amr',jsonb_build_array(jsonb_build_object('method','totp','timestamp',extract(epoch from clock_timestamp()))))::text,true);
create function pg_temp.admin_call(p_operation text,p_input jsonb) returns jsonb language plpgsql as $$declare r jsonb;begin execute format('select public.%I($1)','admin_'||p_operation) into r using jsonb_build_object('contract_code','cv_app_db_2','database_instance_id',(select database_instance_id from admin.environment),'operation_key',extensions.gen_random_uuid(),'reason','Synthetic SQL aggregate regression')||p_input;return r;end $$;
create function pg_temp.save_enabled(p_enabled boolean) returns jsonb language sql as $$ select pg_temp.admin_call('configuration_save',admin.configuration_json(id)||jsonb_build_object('expected_revision',revision::text,'enabled',p_enabled)) from ai.configurations where adapter_id=1 limit 1 $$;
create temp table cancel_cases(label text primary key,request_id text);
insert into cancel_cases values('config',pg_temp.reserve());
select lives_ok($$select pg_temp.save_enabled(false)$$,'config disable executes real request-cancel query without ambiguous PL/pgSQL aliases');
select ok((select time_canceled is not null from ai.requests where external_id=(select request_id from cancel_cases where label='config')),'config disable persists cancellation immediately');
select lives_ok($$select pg_temp.save_enabled(true)$$,'config may be reenabled with a new aggregate revision');
select throws_ok($$select pg_temp.start((select request_id from cancel_cases where label='config'))$$,'P0001','UNAVAILABLE','old reservation cannot revive after configuration reenables');
select is(pg_temp.finish((select request_id from cancel_cases where label='config'))->>'outcome','RELEASED','disabled zero-attempt work releases without charging');
insert into cancel_cases values('allowlist',pg_temp.reserve());
select lives_ok($$select pg_temp.admin_call('allowed_user_set',jsonb_build_object('expected_revision',(select revision::text from ai.runtime_control),'auth_user_id','00000000-0000-4000-8000-000000000091','allowed',false))$$,'allowlist revoke has the same safe qualified cancel path');
select ok((select time_canceled is not null from ai.requests where external_id=(select request_id from cancel_cases where label='allowlist')),'allowlist revoke persists cancellation');
select pg_temp.admin_call('ai_update',(select common.api_json(to_jsonb(c)-'id')||jsonb_build_object('expected_revision',revision::text,'audience','ALL') from ai.runtime_control c));
insert into cancel_cases values('audience',pg_temp.reserve());
select lives_ok($$select pg_temp.admin_call('ai_update',(select common.api_json(to_jsonb(c)-'id')||jsonb_build_object('expected_revision',revision::text,'audience','ALLOWLIST') from ai.runtime_control c))$$,'audience narrowing safely cancels current nonmembers');
select ok((select time_canceled is not null from ai.requests where external_id=(select request_id from cancel_cases where label='audience')),'audience narrowing persists cancellation');
select throws_like($$delete from auth.users where id='00000000-0000-4000-8000-000000000092'$$,'%violates%','active administrator cannot bypass revoke through Auth deletion');
select * from finish();rollback;
