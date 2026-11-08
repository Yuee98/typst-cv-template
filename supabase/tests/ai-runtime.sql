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
create function pg_temp.guard() returns jsonb language sql as $$ select jsonb_build_object('contract_code','cv_app_db_2','database_instance_id',(select database_instance_id from admin.environment),'owner_auth_user_id','00000000-0000-4000-8000-000000000091') $$;
create function pg_temp.reserve(p_adapter integer default 1) returns text language plpgsql as $$declare a jsonb;x jsonb;r jsonb;begin a=public.ai_availability(pg_temp.guard());select value into x from jsonb_array_elements(a->'configurations') where(value->>'adapter_id')::integer=p_adapter;r=public.ai_reserve(pg_temp.guard()||jsonb_build_object('client_request_key',extensions.gen_random_uuid(),'request_fingerprint',repeat('a',64),'config_id',x->>'config_id','expected_config_revision',x->>'revision','expected_control_revision',a->>'control_revision','common_document_audit_id',x#>>'{legal_display,common,document_audit_id}','provider_document_audit_id',x#>>'{legal_display,provider,document_audit_id}'));return r->>'request_id';end $$;
create function pg_temp.complete(p_req text,p_usage jsonb,p_bill boolean default true,p_state text default 'SUCCEEDED',p_retry boolean default false,p_complete boolean default true,p_no integer default 1) returns jsonb language sql as $$select public.ai_attempt_complete(pg_temp.guard()||jsonb_build_object('request_id',p_req,'attempt_no',p_no,'state',p_state,'transmitted',true,'provider_billable',p_bill,'retry_allowed',p_retry,'usage_complete',p_complete,'usage',p_usage))$$;
create function pg_temp.start(p_req text,p_no integer default 1) returns jsonb language sql as $$select public.ai_attempt_start(pg_temp.guard()||jsonb_build_object('request_id',p_req,'attempt_no',p_no)) $$;
create function pg_temp.finish(p_req text) returns jsonb language sql as $$select public.ai_finalize(pg_temp.guard()||jsonb_build_object('request_id',p_req)) $$;
create temp table cases(label text primary key,request_id text);
insert into cases values('ceil',pg_temp.reserve(1)),('usd',pg_temp.reserve(3));
select is((select s.currency from ai.request_snapshots s join ai.requests r on r.id=s.request_id where r.external_id=(select request_id from cases where label='ceil')),'CNY','DS frozen original currency');
select is((select s.currency from ai.request_snapshots s join ai.requests r on r.id=s.request_id where r.external_id=(select request_id from cases where label='usd')),'USD','Gemini frozen original currency');
select pg_temp.start(request_id) from cases;
select pg_temp.complete(request_id,'{"input_total":"3","input_standard":"2","cache_read":"1","cache_write":null,"output":"4","reasoning":"2"}') from cases;
select is((select a.estimated_cost_nanos from ai.attempts a join ai.requests r on r.id=a.request_id where r.external_id=(select request_id from cases where label='ceil')),11::bigint,'one ceil after sum; reasoning subset not charged twice');
select pg_temp.finish(request_id) from cases;
select is((select charged_count from ai.user_quota_daily where auth_user_id='00000000-0000-4000-8000-000000000091'),2::bigint,'user quota is only reserved/charged counts');
select is((select count(distinct currency) from ai.configuration_usage_daily),2::bigint,'central metrics preserves USD/CNY groups');
select is((select sum(known_estimated_cost_nanos) from ai.configuration_usage_daily where currency='USD'),11::numeric,'USD independently aggregates frozen cost');
select is((select sum(known_estimated_cost_nanos) from ai.configuration_usage_daily where currency='CNY'),11::numeric,'CNY independently aggregates frozen cost');
-- Mutating current prices does not alter already-reserved snapshots.
insert into cases values('frozen',pg_temp.reserve());
update ai.prices set currency='EUR',input_standard_nanos_per_million=999999999, input_cache_write_nanos_per_million=500000 where config_id=(select id from ai.configurations where adapter_id=1 limit 1);
select is((public.ai_execution_snapshot(pg_temp.guard()||jsonb_build_object('request_id',(select request_id from cases where label='frozen')))#>>'{price,currency}'),'CNY','price changes never rewrite existing request snapshot');
select pg_temp.start(request_id) from cases where label='frozen';select pg_temp.complete(request_id,'{"input_total":"3","input_standard":"2","cache_read":"1","cache_write":null,"output":"4","reasoning":"2"}') from cases where label='frozen';select pg_temp.finish(request_id) from cases where label='frozen';
-- Unknown cache-write with a non-zero frozen rate cannot become a known zero.
insert into cases values('incomplete',pg_temp.reserve());select pg_temp.start(request_id) from cases where label='incomplete';select pg_temp.complete(request_id,'{"input_total":"3","input_standard":"2","cache_read":"1","cache_write":null,"output":"4","reasoning":"2"}') from cases where label='incomplete';
select ok((select estimated_cost_nanos is null and known_estimated_cost_nanos>0 and cost_incomplete from ai.attempts a join ai.requests r on r.id=a.request_id where r.external_id=(select request_id from cases where label='incomplete')),'unknown positive-rate bucket keeps lower bound and incomplete total');
select pg_temp.finish(request_id) from cases where label='incomplete';
update ai.prices set input_standard_nanos_per_million=9223372036854775807 where config_id=(select id from ai.configurations where adapter_id=1 limit 1);
insert into cases values('overflow',pg_temp.reserve());select pg_temp.start(request_id) from cases where label='overflow';
select pg_temp.complete(request_id,'{"input_total":"9223372036854775807","input_standard":"9223372036854775807","cache_read":"0","cache_write":"0","output":"0","reasoning":"0"}') from cases where label='overflow';
select ok((select a.state='SUCCEEDED' and estimated_cost_nanos is null and cost_overflow from ai.attempts a join ai.requests r on r.id=a.request_id where r.external_id=(select request_id from cases where label='overflow')),'cost overflow persists terminal facts without pretending a truncated total');
select pg_temp.finish(request_id) from cases where label='overflow';
insert into cases values('notbillable',pg_temp.reserve());select pg_temp.start(request_id) from cases where label='notbillable';select pg_temp.complete(request_id,'{"input_total":null,"input_standard":null,"cache_read":null,"cache_write":null,"output":null,"reasoning":null}',false,'FAILED_UPSTREAM',false,false) from cases where label='notbillable';
select ok((select estimated_cost_nanos=0 and not cost_incomplete from ai.attempts a join ai.requests r on r.id=a.request_id where r.external_id=(select request_id from cases where label='notbillable')),'provider_billable=false is known actual zero despite unknown usage');select pg_temp.finish(request_id) from cases where label='notbillable';
insert into cases values('unknown',pg_temp.reserve());select pg_temp.start(request_id) from cases where label='unknown';select pg_temp.complete(request_id,'{"input_total":null,"input_standard":null,"cache_read":null,"cache_write":null,"output":null,"reasoning":null}',null,'UNKNOWN',true,false) from cases where label='unknown';
select is(pg_temp.finish((select request_id from cases where label='unknown'))->>'state','HELD','unknown transmission remains held');
select throws_ok($$select pg_temp.start((select request_id from cases where label='unknown'),2)$$,'P0001','CONFLICT','UNKNOWN can never be retried');
insert into cases values('cancel',pg_temp.reserve());select pg_temp.start(request_id) from cases where label='cancel';select pg_temp.complete(request_id,'{"input_total":"3","input_standard":"2","cache_read":"1","cache_write":"0","output":"4","reasoning":"2"}',true,'CANCELED') from cases where label='cancel';
select is(pg_temp.finish((select request_id from cases where label='cancel'))->>'outcome','CANCELED','provider canceled fact persists cancellation independently');
select is(pg_temp.finish((select request_id from cases where label='cancel'))->>'charged','true','transmitted cancellation charges user quota once');
insert into cases values('empty',pg_temp.reserve());
select is(pg_temp.finish((select request_id from cases where label='empty'))->>'outcome','RELEASED','zero attempt releases quota');
select is((select count(*) from ai.global_quota_daily),1::bigint,'global admission only counts actual first attempts');
-- Reconcile must progress completed work behind unknown and started rows.
insert into cases values('reconcile',pg_temp.reserve());select pg_temp.start(request_id) from cases where label='reconcile';select pg_temp.complete(request_id,'{"input_total":"3","input_standard":"2","cache_read":"1","cache_write":"0","output":"4","reasoning":"2"}') from cases where label='reconcile';
select is(ai.reconcile(1),1,'reconciler skips permanently irreducible unknown head');
select is((select state from ai.requests where external_id=(select request_id from cases where label='reconcile')),'FINALIZED','later terminal-known work is finalized');
-- Two attempts retain independent facts; SQL sums the independently ceiled attempt costs.
update ai.prices set currency='CNY',input_standard_nanos_per_million=1000000,input_cache_write_nanos_per_million=0 where config_id=(select id from ai.configurations where adapter_id=1 limit 1);
insert into cases values('retry',pg_temp.reserve());select pg_temp.start(request_id) from cases where label='retry';
select pg_temp.complete(request_id,'{"input_total":"3","input_standard":"2","cache_read":"1","cache_write":null,"output":"4","reasoning":"2"}',true,'INVALID_OUTPUT',true) from cases where label='retry';
select pg_temp.start(request_id,2) from cases where label='retry';select pg_temp.complete(request_id,'{"input_total":"3","input_standard":"2","cache_read":"1","cache_write":null,"output":"4","reasoning":"2"}',true,'SUCCEEDED',false,true,2) from cases where label='retry';
select is((select sum(estimated_cost_nanos) from ai.attempts a join ai.requests r on r.id=a.request_id where r.external_id=(select request_id from cases where label='retry')),22::numeric,'two real attempts retain 11+11 nanos');
select is(pg_temp.finish((select request_id from cases where label='retry'))->>'outcome','SUCCEEDED','second successful attempt settles request once');
select is(pg_temp.start((select request_id from cases where label='retry'),2)->>'may_transmit','false','attempt replay never authorizes a second transmission');
select public.ai_cancel(pg_temp.guard()||jsonb_build_object('request_id',(select request_id from cases where label='retry')));
select ok((select time_canceled is null and outcome='SUCCEEDED' from ai.requests where external_id=(select request_id from cases where label='retry')),'late cancel cannot rewrite finalized success');
-- A known terminal state with unknown transmission still cannot be refunded or retried.
insert into cases values('nulltransmit',pg_temp.reserve());select pg_temp.start(request_id) from cases where label='nulltransmit';
select public.ai_attempt_complete(pg_temp.guard()||jsonb_build_object('request_id',(select request_id from cases where label='nulltransmit'),'attempt_no',1,'state','FAILED_UPSTREAM','transmitted',null,'provider_billable',null,'retry_allowed',true,'usage_complete',false,'usage',jsonb_build_object('input_total',null,'input_standard',null,'cache_read',null,'cache_write',null,'output',null,'reasoning',null)));
select is(pg_temp.finish((select request_id from cases where label='nulltransmit'))->>'state','HELD','unknown transmission remains held even when terminal error is known');
select throws_ok($$select pg_temp.start((select request_id from cases where label='nulltransmit'),2)$$,'P0001','CONFLICT','unknown transmission never retries');
-- Shared clock helper lets a true admission day differ from the reserve day without patching bodies.
create or replace function common.now() returns timestamptz language sql volatile security invoker set search_path='' as $$select coalesce(nullif(current_setting('app.fixture_clock',true),'')::timestamptz,clock_timestamp())$$;
insert into cases values('nextday',pg_temp.reserve());
select set_config('app.fixture_clock',((clock_timestamp() at time zone 'UTC')::date+1)::text||'T00:00:01Z',true);
select pg_temp.start(request_id) from cases where label='nextday';
select ok((select provider_admission_day=reserve_day+1 from ai.requests where external_id=(select request_id from cases where label='nextday')),'first attempt uses locked current UTC admission day, not reserve day');
select set_config('app.fixture_clock','',true);
insert into admin.operations(actor_auth_user_id,operation_key,operation,payload_digest,entity_kind,entity_id,revision) values('00000000-0000-4000-8000-000000000091',extensions.gen_random_uuid(),'fixture',repeat('0',64),'fixture',1,1);
-- Active account deletion anonymizes requests; service late facts still settle.
insert into cases values('deleted',pg_temp.reserve());select pg_temp.start(request_id) from cases where label='deleted';
delete from auth.users where id='00000000-0000-4000-8000-000000000091';
select lives_ok($$select pg_temp.complete((select request_id from cases where label='deleted'),' {"input_total":"3","input_standard":"2","cache_read":"1","cache_write":"0","output":"4","reasoning":"2"}')$$,'deleted-user late facts accepted on existing started attempt');
select lives_ok($$select pg_temp.finish((select request_id from cases where label='deleted'))$$,'deleted-user frozen costs still settle');
select ok((select owner_auth_user_id is null and client_request_key is null from ai.requests where external_id=(select request_id from cases where label='deleted')),'Auth deletion anonymizes operational request ownership');

select is((select count(*) from audit.acceptances where owner_auth_user_id='00000000-0000-4000-8000-000000000091' or actor_auth_user_id='00000000-0000-4000-8000-000000000091'),0::bigint,'Auth deletion irreversibly unlinks acceptance history identity');
select is((select count(*) from audit.allowed_users where auth_user_id='00000000-0000-4000-8000-000000000091'),0::bigint,'allowlist history also loses deleted account identity');
select is((select count(*) from admin.operations where actor_auth_user_id='00000000-0000-4000-8000-000000000091'),0::bigint,'operation receipts cannot relink a deleted account');
select ok((select count(*)>0 from audit.acceptances where owner_auth_user_id is null),'exact acceptance facts remain after irreversible unlinking');
select throws_ok($$update audit.acceptances set owner_auth_user_id='00000000-0000-4000-8000-000000000092' where owner_auth_user_id is null$$,'P0001','INVALID_REQUEST','anonymous history cannot be linked to another account');

select * from finish();
rollback;
