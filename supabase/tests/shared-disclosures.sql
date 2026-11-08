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

-- Explicit privileged synthetic Auth session for SQL role tests; real password-login evidence lives in the API suite.
insert into auth.sessions(id,user_id) values('00000000-0000-4000-8000-000000000093','00000000-0000-4000-8000-000000000092');
select set_config('request.jwt.claims',jsonb_build_object('sub','00000000-0000-4000-8000-000000000092','session_id','00000000-0000-4000-8000-000000000093','aal','aal1','amr',jsonb_build_array(jsonb_build_object('method','password','timestamp',extract(epoch from clock_timestamp()))))::text,true);
create function pg_temp.admin_call(p_operation text,p_input jsonb) returns jsonb language plpgsql as $$declare r jsonb;begin execute format('select public.%I($1)','admin_'||p_operation) into r using jsonb_build_object('contract_code','cv_app_db_2','database_instance_id',(select database_instance_id from admin.environment),'operation_key',extensions.gen_random_uuid(),'reason','Synthetic SQL aggregate regression')||p_input;return r;end $$;
create function pg_temp.save_enabled(p_enabled boolean) returns jsonb language sql as $$ select pg_temp.admin_call('configuration_save',admin.configuration_json(id)||jsonb_build_object('expected_revision',revision::text,'enabled',p_enabled)) from ai.configurations where adapter_id=1 limit 1 $$;

-- One current recipient disclosure can serve unrelated execution connections.
create function pg_temp.provider_payload(p_id bigint,p_body text,p_enabled boolean default true) returns jsonb language sql as $$
 select jsonb_build_object('id',p_id::text,'expected_revision',(select revision::text from legal.documents where id=p_id),
 'kind','AI_PROVIDER','zh_title','共享接收方说明','en_title','Shared recipient disclosure','zh_body',p_body,'en_body',p_body,
 'effective_date','2026-11-09','recipient_name','Synthetic recipient shared by test connections','enabled',p_enabled)
$$;
create function pg_temp.config_payload(p_id bigint,p_name text,p_display text,p_adapter integer,p_endpoint text,p_model text,p_document bigint) returns jsonb language sql as $$
 select jsonb_build_object('id',p_id::text,'expected_revision',(select revision::text from ai.configurations where id=p_id),
 'name',p_name,'display_name',p_display,'adapter_id',p_adapter,'endpoint_url',p_endpoint,'model_id',p_model,
 'credential_ref','AI_PROVIDER_KEY_SHARED_FIXTURE','legal_document_id',p_document::text,'enabled',true,
 'price',coalesce(ai.price_json(p_id),jsonb_build_object('currency',case when p_adapter=3 then 'USD' else 'CNY' end,
 'input_standard_nanos_per_million','1000000','input_cache_read_nanos_per_million','100000','input_cache_write_nanos_per_million','0','output_nanos_per_million','2000000')))
$$;
create function pg_temp.failure_detail(p_operation text,p_input jsonb) returns text language plpgsql as $$declare v_detail text;begin
 perform pg_temp.admin_call(p_operation,p_input);return null;
 exception when raise_exception then
 if sqlerrm<>'INVALID_REQUEST' then raise;end if;get stacked diagnostics v_detail=pg_exception_detail;return v_detail;
end $$;
create function pg_temp.accept_shared(p_document bigint) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claims',jsonb_build_object('sub','00000000-0000-4000-8000-000000000091','role','authenticated')::text,true);
 perform public.legal_accept_ai(pg_temp.guard()||jsonb_build_object('expected_auth_user_id','00000000-0000-4000-8000-000000000091',
 'common',(select jsonb_build_object('document_id',id::text,'document_audit_id',document_audit_id::text) from legal.documents where kind='AI_COMMON'),
 'provider',(select jsonb_build_object('document_id',id::text,'document_audit_id',document_audit_id::text) from legal.documents where id=p_document)));
 perform set_config('request.jwt.claims',jsonb_build_object('sub','00000000-0000-4000-8000-000000000092','session_id','00000000-0000-4000-8000-000000000093','aal','aal1')::text,true);
end $$;
create function pg_temp.admin_read(p_section text,p_kind text default null,p_id bigint default null) returns jsonb language sql as $$
 select public.admin_read(jsonb_build_object('contract_code','cv_app_db_2','database_instance_id',(select database_instance_id from admin.environment),'expected_environment','LOCAL','section',p_section,'kind',p_kind,'id',p_id::text))
$$;
create temp table sharing_ids(label text primary key,id bigint);
insert into sharing_ids values('document',((pg_temp.admin_call('legal_document_save',pg_temp.provider_payload(null,'## Processing'||E'\n\nSynthetic shared processing facts.')))->>'entity_id')::bigint);
insert into sharing_ids values('a',((pg_temp.admin_call('configuration_save',pg_temp.config_payload(null,'internal-alpha','Visible choice A',1,'https://alpha.example.test/responses','synthetic-alpha-model',(select id from sharing_ids where label='document'))))->>'entity_id')::bigint);
insert into sharing_ids values('b',((pg_temp.admin_call('configuration_save',pg_temp.config_payload(null,'internal-gamma','Visible choice B',3,'https://gamma.example.test/interactions','synthetic-gamma-model',(select id from sharing_ids where label='document'))))->>'entity_id')::bigint);
select is((select count(distinct adapter_id) from ai.configurations where id in(select id from sharing_ids where label in('a','b'))),2::bigint,'one disclosure is accepted by two different code adapters');
select is((select count(distinct endpoint_url||' '||model_id) from ai.configurations where id in(select id from sharing_ids where label in('a','b'))),2::bigint,'different endpoints and models do not force different legal documents');
select is((select count(distinct legal_document_id) from ai.configurations where id in(select id from sharing_ids where label in('a','b'))),1::bigint,'connections retain one explicit shared disclosure FK');
select ok(not exists(select 1 from information_schema.columns where table_schema in('legal','audit') and table_name='documents' and column_name in('adapter_id','endpoint_url','model_id')),'current and historical legal documents have no execution metadata columns');
select ok(not exists(select 1 from jsonb_array_elements(pg_temp.admin_read('disclosures','documents')#>'{data,records}') d where d->>'kind'<>'AI_PROVIDER' or d ?| array['adapter_id','endpoint_url','model_id']),'dedicated disclosure list contains only provider documents and no execution metadata');
select throws_ok($$select pg_temp.admin_read('disclosures','documents',(select id from legal.documents where kind='AI_COMMON'))$$,'P0001','NOT_FOUND','provider detail cannot expose an editable common document');
select is(pg_temp.failure_detail('legal_document_save',pg_temp.provider_payload((select id from legal.documents where kind='AI_COMMON'),'## Changed')),'DOCUMENT_KIND_IMMUTABLE','provider payload cannot convert common terms into a provider document');
select is(pg_temp.failure_detail('legal_document_save',pg_temp.provider_payload(null,'## Legacy')||jsonb_build_object('adapter_id',null)),'UNEXPECTED_LEGAL_FIELDS','removed execution fields are rejected even when explicitly null');
select is(pg_temp.failure_detail('configuration_save',pg_temp.config_payload(null,'missing-label','',1,'https://alpha.example.test/responses','synthetic-model',(select id from sharing_ids where label='document'))-'display_name'),'MISSING_display_name','a user-visible display name is mandatory');
select throws_ok($$select pg_temp.admin_call('configuration_save',pg_temp.config_payload(null,'blank-label','   ',1,'https://alpha.example.test/responses','synthetic-model',(select id from sharing_ids where label='document')))$$,'23514',null,'blank display names cannot be saved');
select pg_temp.accept_shared((select id from sharing_ids where label='document'));
select common.audit_context(null,null,'Shared recipient routing fixture','SYSTEM');
update ai.routing_rules set enabled=false where enabled;
select pg_temp.admin_call('rule_save',jsonb_build_object('id',null,'expected_revision',null,'weekday',null,'start_minute',null,'end_minute',null,'enabled',true,'members',jsonb_build_array(jsonb_build_object('config_id',(select id::text from sharing_ids where label='a'),'is_default',true),jsonb_build_object('config_id',(select id::text from sharing_ids where label='b'),'is_default',false))));
select lives_ok($$select pg_temp.admin_call('ai_update',jsonb_build_object('expected_revision',(select revision::text from ai.runtime_control),'enabled',true,'audience','ALLOWLIST','user_daily_limit','10000','global_daily_limit','10000','user_minute_limit','10000'))$$,'runtime can enable with a disclosure shared across adapters and models');
select is((public.ai_availability(pg_temp.guard())->'configurations')->0->>'display_name','Visible choice A','availability exposes the explicit display label');
select ok(not exists(select 1 from jsonb_array_elements(public.ai_availability(pg_temp.guard())->'configurations') c where(c->>'consent_required')::boolean),'one explicit disclosure acceptance covers both linked connections');
create temp table sharing_request(label text primary key,external_id text);
insert into sharing_request values('old',pg_temp.reserve(1));
create temp table sharing_pins as select document_audit_id,content_digest from legal.documents where id=(select id from sharing_ids where label='document');
select pg_temp.admin_call('configuration_save',pg_temp.config_payload((select id from sharing_ids where label='a'),'internal-alpha-renamed','Visible renamed A',1,'https://alpha.example.test/responses','synthetic-alpha-model',(select id from sharing_ids where label='document')));
select is((public.ai_execution_snapshot(pg_temp.guard()||jsonb_build_object('request_id',(select external_id from sharing_request where label='old')))->>'config_display_name'),'Visible choice A','an existing request freezes its user-visible label');
select is((public.ai_execution_snapshot(pg_temp.guard()||jsonb_build_object('request_id',(select external_id from sharing_request where label='old')))->>'config_name'),'internal-alpha','the internal name is independently frozen');
select ok((select document_audit_id=(select document_audit_id from sharing_pins) and content_digest=(select content_digest from sharing_pins) from legal.documents where id=(select id from sharing_ids where label='document')),'cosmetic configuration renames do not change legal targets or digests');
select ok(not exists(select 1 from jsonb_array_elements(public.ai_availability(pg_temp.guard())->'configurations') c where(c->>'consent_required')::boolean),'cosmetic renames do not require consent again');
insert into sharing_request values('new',pg_temp.reserve(1));
select is((public.ai_execution_snapshot(pg_temp.guard()||jsonb_build_object('request_id',(select external_id from sharing_request where label='new')))->>'config_display_name'),'Visible renamed A','new reservations freeze the new display name');
select pg_temp.finish((select external_id from sharing_request where label='old'));
select is((select c->>'config_display_name' from jsonb_array_elements(pg_temp.admin_read('usage','analytics')#>'{data,configurations}') c where c->>'config_id'=(select id::text from sharing_ids where label='a') limit 1),'Visible choice A','daily metrics use the frozen audit display name rather than current configuration');
select pg_temp.admin_call('legal_document_save',pg_temp.provider_payload((select id from sharing_ids where label='document'),'## Updated processing'||E'\n\nMeaningfully updated shared facts.'));
select ok(not exists(select 1 from jsonb_array_elements(public.ai_availability(pg_temp.guard())->'configurations') c where not(c->>'consent_required')::boolean),'changing shared disclosure content requires exact consent for all linked connections');
select throws_ok($$select pg_temp.reserve(1)$$,'P0001','FORBIDDEN','a new request cannot reuse acceptance of an old document body');
select lives_ok($$select public.legal_document_read(jsonb_build_object('external_id',(select external_id from legal.documents where id=(select id from sharing_ids where label='document')),'document_audit_id',(select document_audit_id::text from sharing_pins),'content_digest',(select content_digest from sharing_pins)))$$,'the previously accepted document audit remains an immutable readable target');
select ok((select h.en_body like '%Synthetic shared processing facts.%' from audit.documents h where h.audit_id=(select document_audit_id from sharing_pins)),'new content never overwrites the historical accepted body');
select pg_temp.accept_shared((select id from sharing_ids where label='document'));
select lives_ok($$select pg_temp.reserve(3)$$,'explicit acceptance of the new shared body restores other-adapter eligibility');
select pg_temp.admin_call('legal_document_save',pg_temp.provider_payload((select id from sharing_ids where label='document'),'## Updated processing'||E'\n\nMeaningfully updated shared facts.',false));
select is(jsonb_array_length(public.ai_availability(pg_temp.guard())->'configurations'),0,'disabling a linked provider document removes all of its connections from availability');
select lives_ok($$select pg_temp.admin_call('legal_document_save',pg_temp.provider_payload(null,repeat('中',65536)))$$,'65536 Chinese characters per language fit the shared UI and database body limits');
select throws_ok($$select pg_temp.admin_call('legal_document_save',pg_temp.provider_payload(null,repeat('x',65537)))$$,'P0001','INVALID_REQUEST','body character count over the public limit is rejected');
select * from finish();
rollback;
