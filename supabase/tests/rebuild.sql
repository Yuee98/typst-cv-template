begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
select is((select count(*)::int from pg_tables where schemaname in ('cv','ai','legal','admin','audit')),31,'exactly 31 application tables');
select ok(not exists(select 1 from pg_tables where schemaname='public'),'no business tables in public');
select ok(not exists(select 1 from pg_tables where schemaname in ('cv','ai','legal','admin','audit') and not rowsecurity),'all business tables use RLS');
select ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('common','cv','ai','legal','admin') and p.proconfig is distinct from array['search_path=""']),'all helpers have empty search_path');
select ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and pg_get_userbyid(p.proowner)<>'app_api_owner'),'all public definer RPCs have restricted owner');
select ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('common','cv','ai','legal','admin') and p.prosecdef and pg_get_userbyid(p.proowner)<>'app_api_owner' and p.proname not in ('auth_user_active','auth_session_valid','auth_has_totp','auth_user_page')),'private postgres Auth bridges are the only elevated-owner exception');
select ok(not has_schema_privilege('app_api_owner','public','create'),'API owner cannot create public objects');
select ok(not pg_has_role('authenticated','app_api_owner','member') and not pg_has_role('service_role','app_api_owner','member'),'API roles cannot assume privileged owner');
select ok(not has_function_privilege('anon','public.cv_document_create(jsonb)','execute') and not has_function_privilege('authenticated','public.ai_reserve(jsonb)','execute'),'RPC ACLs separate user/service callers');
select ok(not has_table_privilege('service_role','ai.requests','select') and not has_table_privilege('authenticated','cv.documents','insert'),'service/client have no direct table write/read bypass');
select ok((select not enabled and active_policy_version_id is null and audience='ALLOWLIST' from ai.runtime_control),'baseline is disabled with no policy');
select ok(common.is_valid_external_id(common.generate_external_id('cv_'),'cv_',12),'typed cryptographic IDs validate');
select ok(not common.is_valid_external_id('cv_IIIIIIIIIIII','cv_',12),'Crockford alphabet excludes ambiguous letters');
-- All fixtures roll back; no Provider network call occurs.
insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000001','sql-owner@fixture.invalid'),('00000000-0000-4000-8000-000000000002','sql-other@fixture.invalid');
-- Real CLI Auth schema includes required session/MFA metadata; test fixtures supply it below.
insert into auth.sessions(id,user_id) values('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001');
insert into auth.mfa_factors(id,user_id,status,factor_type,created_at,updated_at) values('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000001','verified','totp',clock_timestamp(),clock_timestamp());
select set_config('request.jwt.claims',jsonb_build_object('sub','00000000-0000-4000-8000-000000000001','session_id','00000000-0000-4000-8000-000000000011','aal','aal2','amr',jsonb_build_array(jsonb_build_object('method','totp','timestamp',extract(epoch from clock_timestamp()))))::text,true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
do $$begin if not exists(select 1 from admin.environment) then perform admin.initialize('LOCAL','00000000-0000-4000-8000-000000000001');else insert into admin.members(auth_user_id,user_created,user_updated) values('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001');end if;end$$;
create temporary table fixture(key text primary key,value jsonb);
insert into fixture values('base',(select jsonb_build_object('contract_code',contract_code,'database_instance_id',database_instance_id,'expected_auth_user_id','00000000-0000-4000-8000-000000000001') from admin.environment where id=1));
create function pg_temp.input(p jsonb default '{}') returns jsonb language sql volatile as $$select (select value from pg_temp.fixture where key='base')||jsonb_build_object('reason','SQL fixture operation','operation_key',gen_random_uuid())||p$$;
insert into fixture values('valid_cv',jsonb_build_object('schemaVersion',7,'typstLang','zh','sectionOrder',jsonb_build_array('profile','skills','experience','education','research','publications','additional'),'header',jsonb_build_object('name','Fixture','subtitle','','email','','phone','','selfName',''),'sectionTitles',(select jsonb_object_agg(k,jsonb_build_object('title',k,'isDisplay',true,'pageBreakBefore',false)) from unnest(array['profile','skills','experience','education','research','publications','additional'])k),'profile','[]'::jsonb,'skills','[]'::jsonb,'experience','[]'::jsonb,'education','[]'::jsonb,'research','[]'::jsonb,'publications','[]'::jsonb,'additional','[]'::jsonb));
select ok(common.matches_schema((select value from fixture where key='valid_cv'),common.cv_schema()),'complete current CV schema accepted');
select ok(not common.matches_schema((select value#-'{header,name}' from fixture where key='valid_cv'),common.cv_schema()),'missing required header field rejected');
select ok(not common.matches_schema((select value#-'{sectionTitles,profile,pageBreakBefore}' from fixture where key='valid_cv'),common.cv_schema()),'missing current section property rejected');
select ok(not common.matches_schema((select jsonb_set(value,'{profile}','[{"body":42}]') from fixture where key='valid_cv'),common.cv_schema()),'nested CV content type rejected');
select throws_ok($$select public.legal_accept_document(pg_temp.input('{"expected_auth_user_id":"00000000-0000-4000-8000-000000000002"}'))$$,'P0001','CLIENT_UPDATE_REQUIRED','account switch rejects delayed client mutation');
select is(public.app_context()->>'ready','true','owner atomic initialization makes context ready');
select throws_ok($$select public.cv_document_create(jsonb_build_object('contract_code','cv_app_db_1','database_instance_id',gen_random_uuid()))$$,'P0001','CLIENT_UPDATE_REQUIRED','old instance rejects new writes');
select public.legal_accept_document(pg_temp.input(jsonb_build_object('document_version_id',public.legal_current()->'terms'->>'external_id','content_digest',public.legal_current()->'terms'->>'content_digest')));
select throws_ok($$select public.cv_document_create(pg_temp.input(' {"client_create_key":"00000000-0000-4000-8000-000000000031","title":"Old","storage_mode":"PLAIN","document_schema_version":6,"data":{"schemaVersion":6}} '))$$,'P0001','INVALID_REQUEST','old CV format rejected by DB');
select lives_ok($test$
do $$declare j jsonb;pv jsonb;v jsonb;p jsonb;validation jsonb;disclosure text;model text;provider text;bundle text;profile_input jsonb;policy jsonb;price jsonb;begin
 select external_id into provider from ai.providers where code='DEEPSEEK';select d.external_id,d.model_id,b.external_id into disclosure,model,bundle from legal.disclosures d join legal.bundles b on b.id=d.bundle_id where d.provider_id=(select id from ai.providers where code='DEEPSEEK') order by d.id desc limit 1;
 j=public.admin_profile_create(pg_temp.input(jsonb_build_object('provider_id',provider,'code','SQL_FIXTURE','name','Fixture','description','Local only')));p=j->'result';insert into pg_temp.fixture values('profile',p);
 profile_input=pg_temp.input(jsonb_build_object('profile_id',p->>'external_id','expected_revision',p->>'revision','capability_code','DEEPSEEK_RESPONSES','endpoint_url','https://api.deepseek.com/responses','credential_ref','AI_PROVIDER_KEY_DEEPSEEK_SQL_FIXTURE','model_id',model,'adapter_config',jsonb_build_object('reasoningEffort','none','structuredOutput','json_object','providerSubjectField','user'),'disclosure_id',disclosure));
 j=public.admin_profile_version_create(profile_input);pv=j->'result';insert into pg_temp.fixture values('profile_version',pv);
 v=public.config_validation_candidate(pg_temp.input(jsonb_build_object('target_kind','PROFILE','target_id',pv->>'external_id')));validation=public.config_validation_record(pg_temp.input(v||jsonb_build_object('passed',true,'reasons','[]'::jsonb)));
 select revision::text into provider from ai.profiles where external_id=p->>'external_id';j=public.admin_profile_version_publish(pg_temp.input(jsonb_build_object('external_id',pv->>'external_id','expected_revision',provider,'expected_status','DRAFT','config_digest',pv->>'config_digest','validation_id',validation->>'external_id')));pv=j->'result';update pg_temp.fixture set value=pv where key='profile_version';
 select revision::text into provider from ai.profiles where external_id=p->>'external_id';j=public.admin_price_version_create(pg_temp.input(jsonb_build_object('profile_version_id',pv->>'external_id','expected_revision',provider,'lane_code','STANDARD','currency','CNY','calculator_kind','linear_token_v1','parameters','{}'::jsonb,'valid_from',clock_timestamp()-interval '1 day','components',jsonb_build_object('INPUT_STANDARD','1000000','INPUT_CACHE_READ','100000','INPUT_CACHE_WRITE','0','OUTPUT','2000000'))));price=j->'result';insert into pg_temp.fixture values('price',price);
 v=public.config_validation_candidate(pg_temp.input(jsonb_build_object('target_kind','PRICE','target_id',price->>'external_id')));validation=public.config_validation_record(pg_temp.input(v||jsonb_build_object('passed',true,'reasons','[]'::jsonb)));
 select revision::text into provider from ai.profiles where external_id=p->>'external_id';perform public.admin_price_version_publish(pg_temp.input(jsonb_build_object('external_id',price->>'external_id','expected_revision',provider,'expected_status','DRAFT','config_digest',price->>'config_digest','validation_id',validation->>'external_id')));
 j=public.admin_policy_create(pg_temp.input(jsonb_build_object('code','SQL_POLICY','name','Fixture policy','description','Local only')));policy=j->'result';
 j=public.admin_policy_version_create(pg_temp.input(jsonb_build_object('policy_id',policy->>'external_id','expected_revision',policy->>'revision','bundle_id',bundle,'options',jsonb_build_array(jsonb_build_object('key','A','profile_version_id',pv->>'external_id','price_lane_code','STANDARD','display_order',0)),'rules',jsonb_build_array(jsonb_build_object('ordinal',0,'is_fallback',true,'option_keys',jsonb_build_array('A'),'default_option_key','A')))));policy=j->'result';insert into pg_temp.fixture values('policy_version',policy);
 v=public.config_validation_candidate(pg_temp.input(jsonb_build_object('target_kind','POLICY','target_id',policy->>'external_id')));validation=public.config_validation_record(pg_temp.input(v||jsonb_build_object('passed',true,'reasons','[]'::jsonb)));
 select revision::text into provider from ai.policies where id=(select policy_id from ai.policy_versions where external_id=policy->>'external_id');perform public.admin_policy_version_publish(pg_temp.input(jsonb_build_object('external_id',policy->>'external_id','expected_revision',provider,'expected_status','DRAFT','config_digest',policy->>'config_digest','validation_id',validation->>'external_id')));
 v=public.config_validation_candidate(pg_temp.input(jsonb_build_object('target_kind','POLICY','target_id',policy->>'external_id')));validation=public.config_validation_record(pg_temp.input(v||jsonb_build_object('passed',true,'reasons','[]'::jsonb)));
 perform public.admin_ai_set_policy(pg_temp.input(jsonb_build_object('expected_revision',(select revision::text from ai.runtime_control where id=1),'policy_version_id',policy->>'external_id','validation_id',validation->>'external_id')));
 perform public.admin_ai_set_allowed_user(pg_temp.input(jsonb_build_object('expected_revision',(select revision::text from ai.runtime_control where id=1),'auth_user_id','00000000-0000-4000-8000-000000000001','allowed',true)));
 v=public.runtime_readback_candidate(pg_temp.input());validation=public.runtime_readback_record(pg_temp.input(v||jsonb_build_object('passed',true,'reasons','[]'::jsonb)));
 perform public.admin_ai_reopen(pg_temp.input(jsonb_build_object('expected_revision',(select revision::text from ai.runtime_control where id=1),'readback_id',validation->>'external_id')));
end$$;
$test$,'real Admin draft -> validate -> publish -> pointer -> readback -> reopen chain');
select is((public.ai_availability(pg_temp.input('{"owner_auth_user_id":"00000000-0000-4000-8000-000000000001"}'))->'options'->0->>'status'),'CONSENT_REQUIRED','unaccepted Provider remains visible');
select lives_ok($test$
do $$declare a jsonb;o jsonb;r jsonb;t jsonb;result jsonb;u jsonb;begin
 u=pg_temp.input('{"owner_auth_user_id":"00000000-0000-4000-8000-000000000001"}');a=public.ai_availability(u);o=a->'options'->0;
 perform public.legal_accept_disclosure(pg_temp.input(jsonb_build_object('disclosure_id',o->>'disclosure_id','content_digest',o->>'content_digest','bundle_id',o->>'bundle_id','manifest_digest',o->>'manifest_digest')));
 u=u||jsonb_build_object('client_request_key',gen_random_uuid(),'request_fingerprint','fixture-exact-fingerprint','selected_option_id',o->>'option_id','expected_generation',a->>'generation','expected_policy_version_id',a->>'policy_version_id','expected_profile_version_id',o->>'profile_version_id','disclosure_id',o->>'disclosure_id','content_digest',o->>'content_digest');
 insert into pg_temp.fixture values('reserve_input',u);r=public.ai_reserve(u);insert into pg_temp.fixture values('request',r);
 assert (public.ai_reserve(u)->>'replayed')::boolean,'same key replays original reservation';
 u=u||jsonb_build_object('request_id',r->>'request_id','attempt_no',1);t=public.ai_attempt_start(u);assert (t->>'may_transmit')::boolean,'first attempt grants transmission';assert not (public.ai_attempt_start(u)->>'may_transmit')::boolean,'replay does not grant transmission';
 perform public.ai_attempt_complete(u||jsonb_build_object('attempt_id',t->>'attempt_id','state','SUCCEEDED','transmitted',true,'provider_billable',true,'retry_allowed',false,'usage',jsonb_build_object('input_total','10','input_standard','8','cache_read','2','cache_write','0','output','4','reasoning','0')));
 result=public.ai_finalize(u);assert result->>'state'='FINALIZED' and (result->>'charged')::boolean,'successful request charges once';assert public.ai_finalize(u)=result,'finalize replay stable';
 assert (select reserved_count=0 and charged_count=1 from ai.user_usage_daily where auth_user_id='00000000-0000-4000-8000-000000000001' and day=(clock_timestamp() at time zone 'UTC')::date),'quota released and charged once';
 assert (select estimated_cost_nanos=17 from ai.attempts where external_id=t->>'attempt_id'),'exact cost sums products then rounds once';
end$$;
$test$,'reserve idempotency, send-once permission, durable completion and exact single settlement');
select throws_ok($$select public.ai_reserve((select value from fixture where key='reserve_input')||'{"request_fingerprint":"different"}')$$,'P0001','CONFLICT','same key different fingerprint rejected');
select lives_ok($test$
do $$declare u jsonb;r jsonb;a jsonb;begin
 u=(select value from pg_temp.fixture where key='reserve_input')||jsonb_build_object('client_request_key',gen_random_uuid(),'request_fingerprint','held-fixture');r=public.ai_reserve(u);u=u||jsonb_build_object('request_id',r->>'request_id','attempt_no',1);a=public.ai_attempt_start(u);
 update ai.requests set time_progress=clock_timestamp()-interval '601 seconds' where external_id=r->>'request_id';perform ai.reconcile(100);assert (select state='HELD' from ai.requests where external_id=r->>'request_id'),'stale in-flight request held';assert (select state='STARTED' from ai.attempts where external_id=a->>'attempt_id'),'cron cannot fabricate terminal fact';
 perform public.ai_attempt_complete(u||jsonb_build_object('attempt_id',a->>'attempt_id','state','FAILED_UPSTREAM','transmitted',true,'provider_billable',true,'retry_allowed',false,'usage','{}'::jsonb));assert public.ai_finalize(u)->>'state'='FINALIZED','trusted late complete settles original held attempt';
 u=u||jsonb_build_object('client_request_key',gen_random_uuid(),'request_fingerprint','zero-attempt');r=public.ai_reserve(u);update ai.requests set time_progress=clock_timestamp()-interval '601 seconds' where external_id=r->>'request_id';perform ai.reconcile(100);assert (select state='FINALIZED' and outcome='RELEASED' and not charged from ai.requests where external_id=r->>'request_id'),'stale zero-attempt request released';
end$$;
$test$,'reconciler preserves unknown transmission, allows late complete and releases zero-attempt reservations');
select ok(not has_function_privilege('authenticated','common.auth_user_active(uuid)','execute'),'Auth bridges cannot be called directly by API clients');
select ok(not has_schema_privilege('authenticated','cv','usage'),'invoker view does not require base schema USAGE');
select ok((select bool_and(reloptions @> array['security_invoker=true']) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='v'),'all public views security_invoker');
-- A generated ID collision is retried exactly five times; manual IDs/business conflicts are not retried.
create or replace function common.generate_external_id(p_prefix text,p_suffix_length integer default 12) returns text language sql volatile security invoker set search_path='' as $$select p_prefix||repeat('0',p_suffix_length)$$;
select lives_ok($$select common.insert_entity('ai.profiles',jsonb_build_object('provider_id',(select id from ai.providers where code='DEEPSEEK'),'code','COLLISION_ONE','name','Collision fixture','description','Local fixture'))$$,'first deterministic fixture ID inserts');
select throws_ok($$select common.insert_entity('ai.profiles',jsonb_build_object('provider_id',(select id from ai.providers where code='DEEPSEEK'),'code','COLLISION_TWO','name','Collision fixture','description','Local fixture'))$$,'23505','External ID collision retry limit reached','only generated external ID conflicts retry to the fixed bound');
select throws_ok($$select common.insert_entity('ai.profiles',jsonb_build_object('external_id','prf_000000000000','provider_id',(select id from ai.providers where code='DEEPSEEK'),'code','COLLISION_MANUAL','name','Collision fixture','description','Local fixture'))$$,'23505',null,'manual external ID conflict is raised directly');
select throws_ok($$select common.insert_entity('ai.profiles',jsonb_build_object('external_id','prf_111111111111','provider_id',(select id from ai.providers where code='DEEPSEEK'),'code','COLLISION_ONE','name','Collision fixture','description','Local fixture'))$$,'23505',null,'business uniqueness failure is not swallowed as an ID collision');
select * from finish();
rollback;
