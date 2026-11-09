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
-- No secret material or user's source data is emitted.
create function pg_temp.guard() returns jsonb language sql as $$select jsonb_build_object('contract_code','cv_app_db_2','database_instance_id',(select database_instance_id from admin.environment),'owner_auth_user_id','00000000-0000-4000-8000-000000000091','expected_auth_user_id','00000000-0000-4000-8000-000000000091')$$;
create temp table pins as select id,document_audit_id,content_digest from legal.documents;
select is((select count(*) from legal.acceptances where owner_auth_user_id='00000000-0000-4000-8000-000000000091'),5::bigint,'common plus each recipient acceptance is stored independently');
select is((select count(*) from audit.acceptances where owner_auth_user_id='00000000-0000-4000-8000-000000000091'),5::bigint,'acceptance histories point to exact document histories');
update legal.documents set revision=revision+1 where kind='TERMS';
select lives_ok($$select common.require_terms('00000000-0000-4000-8000-000000000091')$$,'same-content revision preserves exact consent');
update legal.documents set zh_body=zh_body||E'\n\nUpdated ordinary terms.',revision=revision+1 where kind='TERMS';
select throws_ok($$select common.require_terms('00000000-0000-4000-8000-000000000091')$$,'P0001','FORBIDDEN','changed current ordinary terms require new consent');
select throws_ok($$select public.legal_accept_document(pg_temp.guard()||jsonb_build_object('document_id',(select id::text from legal.documents where kind='TERMS'),'document_audit_id',(select document_audit_id::text from pins where id=(select id from legal.documents where kind='TERMS'))))$$,'P0001','CONFLICT','stale legal body may be read but cannot be accepted as current');
select lives_ok($$select public.legal_document_read(jsonb_build_object('external_id',(select external_id from legal.documents where kind='TERMS'),'document_audit_id',(select document_audit_id::text from pins where id=(select id from legal.documents where kind='TERMS')),'content_digest',(select content_digest from pins where id=(select id from legal.documents where kind='TERMS'))))$$,'previously enabled exact historical body remains readable');
select throws_ok($$select public.legal_accept_document(pg_temp.guard()||jsonb_build_object('expected_auth_user_id','00000000-0000-4000-8000-000000000099','document_id','1','document_audit_id','1'))$$,'P0001','CLIENT_UPDATE_REQUIRED','late account switch cannot record another account consent');
-- Atomic AI acceptance rejects stale provider without changing common acceptance.
create temp table before_acceptances as select count(*) as n from audit.acceptances;
update legal.documents set en_body=en_body||E'\n\nNew recipient processing fact.',revision=revision+1 where id=(select legal_document_id from ai.configurations where name='Synthetic runtime fixture 1');
select throws_ok($$select public.legal_accept_ai(pg_temp.guard()||jsonb_build_object('common',jsonb_build_object('document_id',(select id::text from legal.documents where kind='AI_COMMON'),'document_audit_id',(select document_audit_id::text from legal.documents where kind='AI_COMMON')),'provider',jsonb_build_object('document_id',(select id::text from legal.documents where id=(select legal_document_id from ai.configurations where name='Synthetic runtime fixture 1')),'document_audit_id',(select document_audit_id::text from pins where id=(select id from legal.documents where id=(select legal_document_id from ai.configurations where name='Synthetic runtime fixture 1'))))))$$,'P0001','CONFLICT','two-document consent is atomic on provider conflict');
select is((select count(*) from audit.acceptances),(select n from before_acceptances),'failed paired consent leaves no partial audit');
select ok(legal.acceptance_for('00000000-0000-4000-8000-000000000091',(select id from legal.documents where id=(select legal_document_id from ai.configurations where name='Synthetic runtime fixture 1'))) is null,'changed provider invalidates only matching consent');
select ok(legal.acceptance_for('00000000-0000-4000-8000-000000000091',(select id from legal.documents where id=(select legal_document_id from ai.configurations where name='Synthetic runtime fixture 2'))) is not null,'another recipient consent remains valid');
-- Asia/Shanghai periods and a single explicit fallback.
insert into ai.routing_rules(weekday,start_minute,end_minute,enabled) values(1,540,1080,true);
insert into ai.routing_rule_configurations(rule_id,config_id,is_default) select(select max(id) from ai.routing_rules),id,adapter_id=1 from ai.configurations where adapter_id in(1,2);
select is((select weekday from ai.routing_rules where id=ai.current_rule('2026-11-09T01:00:00Z')),1::smallint,'UTC Monday01:00 is Shanghai09:00 rule start inclusive');
select ok((select weekday is null from ai.routing_rules where id=ai.current_rule('2026-11-09T10:00:00Z')),'Shanghai18:00 end exclusive returns fallback');
select throws_ok($$insert into ai.routing_rules(weekday,start_minute,end_minute,enabled) values(1,600,700,true)$$,'23P01',null,'overlapping enabled day rules rejected');
select throws_ok($$insert into ai.routing_rules(enabled) values(true)$$,'23505',null,'only one enabled fallback exists');
set constraints all immediate;
select throws_ok($$insert into ai.routing_rules(weekday,start_minute,end_minute,enabled) values(2,100,200,true)$$,'P0001','INVALID_REQUEST','enabled graph without default rejected at constraint boundary');
set constraints all deferred;

select * from finish();
rollback;
