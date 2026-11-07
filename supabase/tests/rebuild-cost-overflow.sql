-- Exact billing overflow must preserve Provider terminal facts, never truncate or retry transmission.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000104','cost-overflow@fixture.invalid');
do $$begin if not exists(select 1 from admin.environment) then perform admin.initialize('LOCAL','00000000-0000-4000-8000-000000000104');end if;end$$;
create temporary table overflow_fixture(key text primary key,value jsonb);
insert into overflow_fixture values('base',(select jsonb_build_object('contract_code',contract_code,'database_instance_id',database_instance_id,'owner_auth_user_id','00000000-0000-4000-8000-000000000104') from admin.environment where id=1));
do $$declare provider bigint;b bigint;d legal.disclosures;p bigint;pv bigint;pc bigint;policy bigint;v bigint;o bigint;a jsonb;option jsonb;u jsonb;r jsonb;attempt jsonb;facts jsonb;begin
 select id into provider from ai.providers where code='DEEPSEEK';select x.* into d from legal.disclosures x join legal.current_state c on c.ai_bundle_id=x.bundle_id where provider_id=provider limit 1;b=d.bundle_id;
 insert into ai.profiles(provider_id,code,name,description) values(provider,'OVERFLOW_FIXTURE','Overflow fixture','Owner-only local test') returning id into p;
 insert into ai.profile_versions(profile_id,version,provider_id,capability_id,endpoint_url,credential_ref,model_id,adapter_config,config_digest,legal_disclosure_id,legal_bundle_id,status,time_published)
 values(p,1,provider,(select id from ai.capabilities where code='DEEPSEEK_RESPONSES'),'https://api.deepseek.com/responses','AI_PROVIDER_KEY_DEEPSEEK_OVERFLOW',d.model_id,'{"reasoningEffort":"none","structuredOutput":"json_object","providerSubjectField":"user"}',repeat('4',64),d.id,b,'PUBLISHED',clock_timestamp()) returning id into pv;
 insert into ai.price_versions(profile_version_id,lane_code,version,currency,calculator_kind,parameters,time_valid_from,config_digest) values(pv,'OVERFLOW',1,'CNY','linear_token_v1','{}',clock_timestamp()-interval '1 day',repeat('5',64)) returning id into pc;
 insert into ai.price_components values(pc,'INPUT_STANDARD',0),(pc,'INPUT_CACHE_READ',0),(pc,'INPUT_CACHE_WRITE',0),(pc,'OUTPUT',9223372036854775807);
 update ai.price_versions set status='PUBLISHED',time_published=clock_timestamp() where id=pc;
 insert into ai.policies(code,name,description) values('OVERFLOW_POLICY','Overflow fixture','Owner-only local test') returning id into policy;
 insert into ai.policy_versions(policy_id,version,legal_bundle_id,config_digest) values(policy,1,b,repeat('6',64)) returning id into v;
 insert into ai.policy_options(policy_version_id,legal_bundle_id,profile_version_id,price_lane_code,display_order) values(v,b,pv,'OVERFLOW',0) returning id into o;
 insert into ai.routing_rules values(v,0,true,null,null,null,o);insert into ai.routing_rule_options values(v,0,o);
 update ai.policy_versions set status='PUBLISHED',time_published=clock_timestamp() where id=v;
 update ai.runtime_control set active_policy_version_id=v,enabled=true,audience='ALL',user_daily_limit=20,user_minute_limit=20,global_daily_limit=2000,generation=generation+1 where id=1;
 insert into legal.acceptances(owner_auth_user_id,disclosure_id,accepted_content_digest) values('00000000-0000-4000-8000-000000000104',d.id,d.content_digest);
 u=(select value from pg_temp.overflow_fixture where key='base');a=public.ai_availability(u);option=a->'options'->0;
 r=public.ai_reserve(u||jsonb_build_object('client_request_key',gen_random_uuid(),'request_fingerprint','overflow-only-fixture','selected_option_id',option->>'option_id','expected_generation',a->>'generation','expected_policy_version_id',a->>'policy_version_id','expected_profile_version_id',option->>'profile_version_id','disclosure_id',option->>'disclosure_id','content_digest',option->>'content_digest'));
 u=u||jsonb_build_object('request_id',r->>'request_id');attempt=public.ai_attempt_start(u||'{"attempt_no":1}');
 facts=u||jsonb_build_object('attempt_id',attempt->>'attempt_id','state','SUCCEEDED','transmitted',true,'provider_billable',true,'retry_allowed',false,'usage',jsonb_build_object('input_total','0','input_standard','0','cache_read','0','cache_write','0','output','1000001','reasoning','0'));
 perform public.ai_attempt_complete(facts);insert into pg_temp.overflow_fixture values('attempt',attempt),('request',r),('input',u),('facts',facts);
end$$;
set constraints all immediate;
select is((select state from ai.attempts where external_id=(select value->>'attempt_id' from overflow_fixture where key='attempt')),'SUCCEEDED','overflow does not erase successful terminal fact');
select ok((select estimated_cost_nanos is null and known_estimated_cost_nanos is null and incomplete_reasons @> array['COST_OVERFLOW'] from ai.attempts where external_id=(select value->>'attempt_id' from overflow_fixture where key='attempt')),'attempt overflow remains unknown with explicit reason');
select is(public.ai_attempt_complete((select value from overflow_fixture where key='facts'))->>'replayed','true','overflow completion is still idempotent');
select is(public.ai_finalize((select value from overflow_fixture where key='input'))->>'state','FINALIZED','overflow does not prevent authoritative user settlement');
select ok((select charged and estimated_cost_nanos is null and known_estimated_cost_nanos is null and incomplete_reasons @> array['COST_OVERFLOW'] from ai.requests where external_id=(select value->>'request_id' from overflow_fixture where key='request')),'request charges once without fabricating a zero complete estimate');
select ok((select incomplete_count=1 and known_estimated_cost_nanos=0 from ai.profile_usage_daily where profile_version_id=(select profile_version_id from ai.requests where external_id=(select value->>'request_id' from overflow_fixture where key='request'))),'daily cost is explicitly incomplete and only records a known lower bound');
select * from finish();
rollback;
