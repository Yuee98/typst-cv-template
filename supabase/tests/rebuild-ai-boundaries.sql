-- Owner-only disposable fixtures. No HTTP calls, hosted connection, or Provider secret.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000091','ai-boundary@fixture.invalid');
-- The request user must stay deletable; active administrators have a separate Auth FK.
do $$begin
 if not exists(select 1 from admin.environment) then
  insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000092','ai-boundary-admin@fixture.invalid');
  perform admin.initialize('LOCAL','00000000-0000-4000-8000-000000000092');
 end if;
end$$;
create temporary table ai_fixture(key text primary key,value jsonb);
insert into ai_fixture values('base',(select jsonb_build_object('contract_code',contract_code,'database_instance_id',database_instance_id,'owner_auth_user_id','00000000-0000-4000-8000-000000000091') from admin.environment where id=1));
create function pg_temp.service(p jsonb default '{}') returns jsonb language sql volatile as $$select (select value from pg_temp.ai_fixture where key='base')||p$$;
-- Build immutable profile/price/policy graphs through owner fixtures, never by relaxing API grants.
do $$declare p bigint;pv bigint;pc bigint;pol bigint;ver bigint;b bigint;d legal.disclosures;provider bigint;i int;o bigint[];begin
 select id into b from legal.bundles where time_sealed is not null order by id desc limit 1;
 for i in 1..3 loop
  select id into provider from ai.providers where code=case when i=2 then 'MIMO' else 'DEEPSEEK' end;
  select * into d from legal.disclosures where bundle_id=b and provider_id=provider order by id limit 1;
  insert into ai.profiles(provider_id,code,name,description) values(provider,'BOUNDARY_'||i,'Boundary '||i,'Owner-only SQL fixture') returning id into p;
  insert into ai.profile_versions(profile_id,version,provider_id,capability_id,endpoint_url,credential_ref,model_id,adapter_config,config_digest,legal_disclosure_id,legal_bundle_id,status,time_published)
  values(p,1,provider,(select id from ai.capabilities where code=case when i=2 then 'MIMO_RESPONSES' else 'DEEPSEEK_RESPONSES' end),case when i=2 then 'https://api.xiaomimimo.com/v1/responses' else 'https://api.deepseek.com/responses' end,'AI_PROVIDER_KEY_'||case when i=2 then 'MIMO' else 'DEEPSEEK' end||'_FIXTURE',d.model_id,case when i=2 then '{"reasoningEffort":"none","structuredOutput":"prompt_only","sendProviderSubjectId":false}'::jsonb else '{"reasoningEffort":"none","structuredOutput":"json_object","providerSubjectField":"user"}'::jsonb end,repeat('1',64),d.id,b,'PUBLISHED',clock_timestamp()) returning id into pv;
  insert into ai.price_versions(profile_version_id,lane_code,version,currency,calculator_kind,parameters,time_valid_from,status,config_digest,time_published) values(pv,'STANDARD',1,'CNY','linear_token_v1','{}',clock_timestamp()-interval '1 day','DRAFT',repeat('2',64),null) returning id into pc;
  insert into ai.price_components values(pc,'INPUT_STANDARD',1000000),(pc,'INPUT_CACHE_READ',100000),(pc,'INPUT_CACHE_WRITE',0),(pc,'OUTPUT',2000000);
  update ai.price_versions set status='PUBLISHED',time_published=clock_timestamp() where id=pc;
  insert into pg_temp.ai_fixture values('pv'||i,jsonb_build_object('id',pv,'price',pc));
  insert into legal.acceptances(owner_auth_user_id,disclosure_id,accepted_content_digest) values('00000000-0000-4000-8000-000000000091',d.id,d.content_digest) on conflict do nothing;
 end loop;
 insert into ai.policies(code,name,description) values('BOUNDARY_POLICY','Boundary policy','A/B before 18:00, A/C afterwards') returning id into pol;
 insert into ai.policy_versions(policy_id,version,legal_bundle_id,config_digest,status,time_published) values(pol,1,b,repeat('3',64),'DRAFT',null) returning id into ver;
 for i in 1..3 loop
  insert into ai.policy_options(policy_version_id,legal_bundle_id,profile_version_id,price_lane_code,display_order) values(ver,b,((select value from pg_temp.ai_fixture where key='pv'||i)->>'id')::bigint,'STANDARD',i) returning id into p;o=array_append(o,p);
 end loop;
 insert into ai.routing_rules values(ver,0,true,null,null,null,o[1]),(ver,1,false,1,0,1080,o[1]),(ver,2,false,1,1080,1440,o[1]);
 insert into ai.routing_rule_options values(ver,0,o[1]),(ver,0,o[3]),(ver,1,o[1]),(ver,1,o[2]),(ver,2,o[1]),(ver,2,o[3]);
 update ai.policy_versions set status='PUBLISHED',time_published=clock_timestamp() where id=ver;
 insert into pg_temp.ai_fixture values('graph',jsonb_build_object('policy',ver,'a',o[1],'b',o[2],'c',o[3]));
 update ai.runtime_control set active_policy_version_id=ver,enabled=true,audience='ALL',user_daily_limit=100,user_minute_limit=100,global_daily_limit=100,generation=generation+1 where id=1;
end$$;
set constraints all immediate;
-- RUNTIME_FIXTURE_SETUP_END
select is(ai.rule_at(((select value from ai_fixture where key='graph')->>'policy')::bigint,'2026-11-02T09:59:59Z'),1,'17:59:59 Shanghai uses A/B');
select is(ai.rule_at(((select value from ai_fixture where key='graph')->>'policy')::bigint,'2026-11-02T10:00:00Z'),2,'18:00 Shanghai switches to A/C');
select is(ai.rule_at(((select value from ai_fixture where key='graph')->>'policy')::bigint,'2026-11-03T00:00:00Z'),0,'unmatched weekday uses exactly the fallback');
create function pg_temp.draft_policy() returns jsonb language plpgsql volatile as $$declare p bigint;v bigint;o bigint;g jsonb:=(select value from pg_temp.ai_fixture where key='graph');bundle bigint;begin
 set constraints all deferred;
 select legal_bundle_id into bundle from ai.policy_versions where id=(g->>'policy')::bigint;
 insert into ai.policies(code,name,description) values('NEGATIVE_GRAPH','Negative graph','Disposable negative fixture') returning id into p;
 insert into ai.policy_versions(policy_id,version,legal_bundle_id,config_digest) values(p,1,bundle,repeat('4',64)) returning id into v;
 insert into ai.policy_options(policy_version_id,legal_bundle_id,profile_version_id,price_lane_code,display_order) values(v,bundle,((select value from pg_temp.ai_fixture where key='pv1')->>'id')::bigint,'STANDARD',0) returning id into o;
 return jsonb_build_object('policy',v,'a',o,'b',g->'b');
end$$;
select throws_ok($test$do $$declare g jsonb:=pg_temp.draft_policy();begin set constraints all deferred;insert into ai.routing_rules values((g->>'policy')::bigint,3,false,null,null,null,(g->>'a')::bigint);insert into ai.routing_rule_options values((g->>'policy')::bigint,3,(g->>'a')::bigint);set constraints all immediate;end$$;$test$,'23514',null,'nonfallback rule cannot bypass shape constraints with NULL');
select throws_ok($test$do $$declare g jsonb:=pg_temp.draft_policy();begin set constraints all deferred;insert into ai.routing_rules values((g->>'policy')::bigint,0,true,null,null,null,(g->>'a')::bigint),((g->>'policy')::bigint,3,false,2,0,60,(g->>'b')::bigint);insert into ai.routing_rule_options values((g->>'policy')::bigint,0,(g->>'a')::bigint),((g->>'policy')::bigint,3,(g->>'a')::bigint);set constraints all immediate;end$$;$test$,'23503',null,'default option must be a member of its own rule');
select throws_ok($$update ai.policy_options set display_order=99 where id=((select value from ai_fixture where key='graph')->>'a')::bigint$$,'P0001','INVALID_REQUEST','published option graph cannot be edited');
select throws_ok($$delete from ai.price_components where price_version_id=((select value from ai_fixture where key='pv1')->>'price')::bigint$$,'P0001','INVALID_REQUEST','frozen price components cannot be deleted');
select throws_ok($test$do $$declare g jsonb:=(select value from pg_temp.ai_fixture where key='graph');begin insert into ai.routing_rules values((g->>'policy')::bigint,99,false,7,0,1,(g->>'a')::bigint);end$$;$test$,'P0001','INVALID_REQUEST','published graph cannot acquire new time rules');
create function pg_temp.reserve(p_key text) returns jsonb language plpgsql volatile as $$declare a jsonb;o jsonb;u jsonb;r jsonb;begin
 a=public.ai_availability(pg_temp.service());select x into o from jsonb_array_elements(a->'options') x where x->>'option_id'=(select external_id from ai.policy_options where id=((select value from pg_temp.ai_fixture where key='graph')->>'a')::bigint);
 u=pg_temp.service(jsonb_build_object('client_request_key',gen_random_uuid(),'request_fingerprint',p_key,'selected_option_id',o->>'option_id','expected_generation',a->>'generation','expected_policy_version_id',a->>'policy_version_id','expected_profile_version_id',o->>'profile_version_id','disclosure_id',o->>'disclosure_id','content_digest',o->>'content_digest'));
 r=public.ai_reserve(u);insert into pg_temp.ai_fixture values(p_key,u||jsonb_build_object('request_id',r->>'request_id'));return r;
end$$;
select lives_ok($$select pg_temp.reserve('boundary-reservation')$$,'valid selected option reserves');
select ok((select r.time_reserved>transaction_timestamp() from ai.requests r where external_id=(select value->>'request_id' from ai_fixture where key='boundary-reservation')),'reservation uses observed wall time rather than transaction start');
select throws_ok($$select public.ai_reserve((select value from ai_fixture where key='boundary-reservation')||jsonb_build_object('client_request_key',gen_random_uuid(),'expected_generation','0'))$$,'P0001','CONFLICT','stale generation cannot reserve or send');
select lives_ok($test$do $$declare u jsonb;r jsonb;a jsonb;done jsonb;facts jsonb;begin
 perform pg_temp.reserve('retry');u=(select value from pg_temp.ai_fixture where key='retry');a=public.ai_attempt_start(u||'{"attempt_no":1}');
 facts=u||jsonb_build_object('attempt_id',a->>'attempt_id','state','INVALID_OUTPUT','transmitted',true,'provider_billable',true,'retry_allowed',true,'usage',jsonb_build_object('input_total','3','input_standard','2','cache_read','1','cache_write',null,'output','4','reasoning','2'));
 perform public.ai_attempt_complete(facts);assert (public.ai_attempt_complete(facts)->>'replayed')::boolean,'identical complete replays';
 a=public.ai_attempt_start(u||'{"attempt_no":2}');assert (a->>'may_transmit')::boolean,'durable retry fact grants second attempt';assert not (public.ai_attempt_start(u||'{"attempt_no":2}')->>'may_transmit')::boolean,'retry response replay cannot grant another send';
 perform public.ai_attempt_complete(u||jsonb_build_object('attempt_id',a->>'attempt_id','state','SUCCEEDED','transmitted',true,'provider_billable',true,'retry_allowed',false,'usage',jsonb_build_object('input_total','3','input_standard','2','cache_read','1','cache_write',null,'output','4','reasoning','2')));
 done=public.ai_finalize(u);assert done->>'outcome'='SUCCEEDED' and (done->>'charged')::boolean,'two attempts charge one request';
 assert (select estimated_cost_nanos=22 from ai.requests where external_id=u->>'request_id'),'two costs round once per attempt, then sum; unknown zero-rate cache writes do not erase completeness';
end$$;$test$,'retry uses one frozen request and preserves complete exact costs');
select lives_ok($test$do $$declare u jsonb;a jsonb;done jsonb;begin
 perform pg_temp.reserve('unknown');u=(select value from pg_temp.ai_fixture where key='unknown');a=public.ai_attempt_start(u||'{"attempt_no":1}');
 perform public.ai_attempt_complete(u||jsonb_build_object('attempt_id',a->>'attempt_id','state','UNKNOWN','transmitted',null,'provider_billable',null,'retry_allowed',false,'usage','{}'::jsonb));
 done=public.ai_finalize(u);assert done->>'state'='HELD' and done->'charged'='null'::jsonb,'unknown terminal retains reserved quota';
 assert (select estimated_cost_nanos is null from ai.requests where external_id=u->>'request_id'),'unknown cost is not zero';
end$$;$test$,'unknown transmission is retained rather than refunded or billed as zero');
select throws_ok($$select public.ai_attempt_start((select value from ai_fixture where key='unknown')||'{"attempt_no":2}')$$,'P0001','CONFLICT','unknown terminal never authorizes another attempt');
select lives_ok($test$do $$declare u jsonb;a jsonb;done jsonb;begin
 perform pg_temp.reserve('cancel-terminal');u=(select value from pg_temp.ai_fixture where key='cancel-terminal');a=public.ai_attempt_start(u||'{"attempt_no":1}');
 perform public.ai_attempt_complete(u||jsonb_build_object('attempt_id',a->>'attempt_id','state','CANCELED','transmitted',true,'provider_billable',null,'retry_allowed',false,'usage','{}'::jsonb));
 done=public.ai_finalize(u);assert done->>'outcome'='CANCELED' and (done->>'charged')::boolean,'durable cancellation terminal prevents incorrect failure refund even if separate cancel response was lost';
end$$;$test$,'transmitted cancellation charges once while retaining unknown provider cost');
select lives_ok($test$do $$declare u jsonb;done jsonb;before_count bigint;begin
 select coalesce(sum(admitted_count),0) into before_count from ai.global_usage_daily;perform pg_temp.reserve('cancel-before');u=(select value from pg_temp.ai_fixture where key='cancel-before');perform public.ai_cancel(u);done=public.ai_finalize(u);assert done->>'outcome'='RELEASED' and not (done->>'charged')::boolean,'zero-attempt cancellation releases';assert (select coalesce(sum(admitted_count),0)=before_count from ai.global_usage_daily),'no admission creates no global Provider count';
end$$;$test$,'cancel before attempt does not manufacture provider usage');
select lives_ok($test$do $$declare u jsonb;a jsonb;done jsonb;begin
 perform pg_temp.reserve('deleted-after-send');u=(select value from pg_temp.ai_fixture where key='deleted-after-send');a=public.ai_attempt_start(u||'{"attempt_no":1}');
 delete from auth.users where id='00000000-0000-4000-8000-000000000091';
 assert (select owner_auth_user_id is null and client_request_key is null and request_fingerprint is null from ai.requests where external_id=u->>'request_id'),'Auth deletion anonymizes request identity';
 perform public.ai_attempt_complete(u||jsonb_build_object('attempt_id',a->>'attempt_id','state','SUCCEEDED','transmitted',true,'provider_billable',true,'retry_allowed',false,'usage',jsonb_build_object('input_total','3','input_standard','2','cache_read','1','cache_write',null,'output','4','reasoning','2')));
 done=public.ai_finalize(u);assert done->>'state'='FINALIZED' and done->>'outcome'='SUCCEEDED','trusted terminal producer settles after identity deletion';
 assert (select estimated_cost_nanos=11 from ai.requests where external_id=u->>'request_id'),'known Provider cost survives user deletion';
end$$;$test$,'Auth deletion cannot discard a trusted late terminal fact or its accounting');
select * from finish();
rollback;
