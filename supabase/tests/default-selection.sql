begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
-- Privileged synthetic setup. This is not evidence of Auth sign-in/session verification.
select common.audit_context(null,null,'Disposable runtime fixture, synthetic prices; not provider invoices','SYSTEM');
insert into auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at) values
('00000000-0000-4000-8000-000000000091','authenticated','authenticated','runtime-fixture@example.invalid',clock_timestamp(),clock_timestamp(),clock_timestamp()),
('00000000-0000-4000-8000-000000000092','authenticated','authenticated','bootstrap-fixture@example.invalid',clock_timestamp(),clock_timestamp(),clock_timestamp()) on conflict(id) do nothing;
do $$begin if not exists(select 1 from admin.environment) then perform admin.initialize('LOCAL','00000000-0000-4000-8000-000000000092');end if;end $$;
insert into ai.configurations(name,display_name,adapter_id,endpoint_url,model_id,credential_ref,legal_document_id,enabled)
select 'Synthetic runtime fixture '||f.adapter_id,'Visible fixture choice '||f.adapter_id,f.adapter_id,f.endpoint_url,f.model_id,'AI_PROVIDER_KEY_FIXTURE_'||f.adapter_id,d.id,true
from(values
 (1,'https://api.deepseek.com/responses','deepseek-flash','Official DeepSeek Open Platform'),
 (2,'https://api.xiaomimimo.com/v1/responses','mimo-v2.6-flash','Official MiMo API (mainland-China access)'),
 (3,'https://generativelanguage.googleapis.com/v1/interactions','gemini-3.8-flash','Google Gemini API (AI Studio)')
) f(adapter_id,endpoint_url,model_id,recipient_name)
join legal.documents d on d.kind='AI_PROVIDER' and d.enabled and d.recipient_name=f.recipient_name
where not exists(select 1 from ai.configurations c where c.name='Synthetic runtime fixture '||f.adapter_id);
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

-- Two candidates, one explicit default. This setup is privileged and synthetic;
-- the disable below crosses the actual authenticated Admin RPC boundary.
delete from ai.routing_rule_configurations where rule_id=(select max(id) from ai.routing_rules) and config_id=(select id from ai.configurations where name='Synthetic runtime fixture 3');
insert into admin.members(auth_user_id) select '00000000-0000-4000-8000-000000000092' where not exists(select 1 from admin.members where auth_user_id='00000000-0000-4000-8000-000000000092' and time_revoked is null);
insert into auth.sessions(id,user_id) values('00000000-0000-4000-8000-000000000093','00000000-0000-4000-8000-000000000092');
create function pg_temp.guard() returns jsonb language sql as $$ select jsonb_build_object('contract_code','cv_app_db_2','database_instance_id',(select database_instance_id from admin.environment),'owner_auth_user_id','00000000-0000-4000-8000-000000000091') $$;
create function pg_temp.reserve(p_adapter integer default 1) returns text language plpgsql as $$declare a jsonb;x jsonb;r jsonb;begin a=public.ai_availability(pg_temp.guard());select value into x from jsonb_array_elements(a->'configurations') where(value->>'adapter_id')::integer=p_adapter;r=public.ai_reserve(pg_temp.guard()||jsonb_build_object('client_request_key',extensions.gen_random_uuid(),'request_fingerprint',repeat('a',64),'config_id',x->>'config_id','expected_config_revision',x->>'revision','expected_control_revision',a->>'control_revision','common_document_audit_id',x#>>'{legal_display,common,document_audit_id}','provider_document_audit_id',x#>>'{legal_display,provider,document_audit_id}'));return r->>'request_id';end $$;
create temp table selection_cases(label text primary key,request_id text);
select is(public.ai_availability(pg_temp.guard())->>'default_config_id',(select id::text from ai.configurations where name='Synthetic runtime fixture 1'),'availability uses the declared default while available');
select is(jsonb_array_length(public.ai_availability(pg_temp.guard())->'configurations'),2,'both declared candidates are initially available');
insert into selection_cases values('old-default',pg_temp.reserve());
create temp table default_admin_payload as select admin.configuration_json(id)||jsonb_build_object('contract_code','cv_app_db_2','database_instance_id',(select database_instance_id from admin.environment),'operation_key',extensions.gen_random_uuid(),'reason','Default selection regression: disable declared default','expected_revision',revision::text,'enabled',false) payload from ai.configurations where name='Synthetic runtime fixture 1';
grant select on default_admin_payload to authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub','00000000-0000-4000-8000-000000000092','session_id','00000000-0000-4000-8000-000000000093','role','authenticated')::text,true);
set local role authenticated;
select public.admin_configuration_save(payload) from default_admin_payload;
reset role;
select ok((select time_canceled is not null from ai.requests where external_id=(select request_id from selection_cases where label='old-default')),'normal Admin disable persistently cancels the old default request');
select ok(public.ai_availability(pg_temp.guard())->'default_config_id'='null'::jsonb,'unavailable declared default is null; a nondefault candidate is never promoted');
select is(jsonb_array_length(public.ai_availability(pg_temp.guard())->'configurations'),1,'disabling default preserves the other available candidate');
select is(public.ai_availability(pg_temp.guard())#>>'{configurations,0,config_id}',(select id::text from ai.configurations where name='Synthetic runtime fixture 2'),'the remaining candidate is exactly the nondefault configuration');
select is(public.ai_availability(pg_temp.guard())->>'enabled','true','explicit selection remains possible without a default');
select is((select config_id::text from ai.routing_rule_configurations where rule_id=ai.current_rule(common.now()) and is_default),(select id::text from ai.configurations where name='Synthetic runtime fixture 1'),'availability does not rewrite the declared rule default');
insert into selection_cases values('explicit-other',pg_temp.reserve(2));
select is((select s.config_id from ai.request_snapshots s join ai.requests r on r.id=s.request_id where r.external_id=(select request_id from selection_cases where label='explicit-other')),(select id from ai.configurations where name='Synthetic runtime fixture 2'),'an explicitly selected nondefault candidate reserves normally');
select ok((select time_canceled is not null from ai.requests where external_id=(select request_id from selection_cases where label='old-default')),'selecting the other candidate cannot revive the old default reservation');
select is(public.ai_finalize(pg_temp.guard()||jsonb_build_object('request_id',(select request_id from selection_cases where label='old-default')))->>'outcome','RELEASED','canceled default with zero attempts releases its quota');
-- A missing eligible disclosure is another unavailable-default case, not a
-- reason to inherit the first remaining candidate as a default.
update default_admin_payload set payload=admin.configuration_json(c.id)||jsonb_build_object('contract_code','cv_app_db_2','database_instance_id',(select database_instance_id from admin.environment),'operation_key',extensions.gen_random_uuid(),'reason','Default selection regression: reenable declared default','expected_revision',c.revision::text,'enabled',true) from ai.configurations c where c.name='Synthetic runtime fixture 1';
set local role authenticated;
select public.admin_configuration_save(payload) from default_admin_payload;
reset role;
select is(public.ai_availability(pg_temp.guard())->>'default_config_id',(select id::text from ai.configurations where name='Synthetic runtime fixture 1'),'reenabling the declared default restores only that default');
update legal.documents set enabled=false,revision=revision+1 where id=(select legal_document_id from ai.configurations where name='Synthetic runtime fixture 1');
select ok(public.ai_availability(pg_temp.guard())->'default_config_id'='null'::jsonb,'default with an unavailable disclosure is null without provider substitution');
select is(jsonb_array_length(public.ai_availability(pg_temp.guard())->'configurations'),1,'unavailable default disclosure does not hide an unrelated candidate');
select * from finish();
rollback;
