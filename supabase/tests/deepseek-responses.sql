-- Current DeepSeek execution semantics; historical sealed Chat evidence is not edited.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
select is((select count(*)::int from ai.capabilities where code='DEEPSEEK_RESPONSES'),1,'one current DeepSeek Responses capability');
select ok(not exists(select 1 from ai.capabilities where code='DEEPSEEK_CHAT' or adapter_kind='deepseek_chat_v1' or wire_api_kind='chat_completions_v1'),'retired Chat execution capability has no dictionary entry');
select ok((select adapter_kind='deepseek_responses_v1' and wire_api_kind='responses_v1' and execution_contract='cv_polish_1' and calculator_kind='linear_token_v1' and cache_policy='automatic' and time_deprecated is null from ai.capabilities where code='DEEPSEEK_RESPONSES'),'Responses descriptor has the exact supported protocol');
select is((select descriptor_digest from ai.capabilities where code='DEEPSEEK_RESPONSES'),'10515a051b46ecb7a18dd6f946715d28f1f4c263571982079a181cfb4e2447cc','database descriptor matches the compiled application descriptor');
select ok((select new.ai_document_version_id=old.ai_document_version_id and new.time_sealed is not null and old.time_sealed is not null and new.manifest_digest<>old.manifest_digest from legal.bundles new cross join legal.bundles old where new.code='CV_APP_RESPONSES_20261107' and old.code='CURRENT_20261107'),'new sealed manifest reuses unchanged common terms');
select ok((select new.content=old.content and new.content_digest<>old.content_digest from legal.disclosures new join legal.bundles nb on nb.id=new.bundle_id join legal.disclosures old on old.provider_id=new.provider_id join legal.bundles ob on ob.id=old.bundle_id join ai.providers p on p.id=new.provider_id where nb.code='CV_APP_RESPONSES_20261107' and ob.code='CURRENT_20261107' and p.code='MIMO'),'MiMo content is unchanged while consent digest binds the new manifest');
select ok(not exists(select 1 from legal.disclosures d join legal.bundles b on b.id=d.bundle_id join legal.document_versions a on a.id=b.ai_document_version_id where b.code='CV_APP_RESPONSES_20261107' and d.content_digest<>common.digest(jsonb_build_object('content',d.content,'ai_document_digest',a.content_digest,'manifest_digest',b.manifest_digest))),'new disclosures bind content, common terms and manifest exactly');
select ok((select d.model_id='deepseek-flash' and d.disclosure_code='DEEPSEEK_RESPONSES_DEEPSEEK_FLASH_20261107' and octet_length(d.content::text)<32768 from legal.disclosures d join legal.bundles b on b.id=d.bundle_id join ai.providers p on p.id=d.provider_id where b.code='CV_APP_RESPONSES_20261107' and p.code='DEEPSEEK'),'new DeepSeek model and bounded disclosure are explicit');
-- Use the private invoker dispatcher as migration owner for focused authoring checks.
-- Normal authenticated commit, validation, readback and consent are covered by test:db.
create temporary table responses_fixture(profile jsonb);
insert into responses_fixture select common.insert_entity('ai.profiles',jsonb_build_object('provider_id',p.id,'code','RESPONSES_SQL_FIXTURE','name','Responses fixture','description','Rollback only')) from ai.providers p where p.code='DEEPSEEK';
create function pg_temp.responses_input() returns jsonb language sql volatile as $f$
select jsonb_build_object('profile_id',p.external_id,'expected_revision',p.revision::text,'capability_code','DEEPSEEK_RESPONSES','endpoint_url','https://api.deepseek.com/responses','credential_ref','AI_PROVIDER_KEY_DEEPSEEK_RESPONSES_TEST','model_id',d.model_id,'disclosure_id',d.external_id,'adapter_config','{"reasoningEffort":"none","structuredOutput":"json_object","providerSubjectField":"user"}'::jsonb)
from ai.profiles p join pg_temp.responses_fixture f on f.profile->>'external_id'=p.external_id join legal.disclosures d on d.provider_id=p.provider_id join legal.bundles b on b.id=d.bundle_id where b.code='CV_APP_RESPONSES_20261107';
$f$;
select lives_ok($$select admin.apply('profile_version_create',pg_temp.responses_input(),null)$$,'current Responses profile creates with exact subject and structured output semantics');
-- Explicit negative legacy payloads never become executable configurations.
select throws_ok($$select admin.apply('profile_version_create',pg_temp.responses_input()||'{"capability_code":"DEEPSEEK_CHAT"}',null)$$,'P0001','INVALID_REQUEST','old Chat capability is rejected');
select throws_ok($$select admin.apply('profile_version_create',pg_temp.responses_input()||'{"endpoint_url":"https://api.deepseek.com/chat/completions"}',null)$$,'P0001','INVALID_REQUEST','old Chat endpoint is rejected');
select throws_ok($$select admin.apply('profile_version_create',pg_temp.responses_input()||'{"adapter_config":{"thinking":"disabled","structuredOutput":"json_object","providerSubjectField":"user_id"}}',null)$$,'P0001','INVALID_REQUEST','old adapter fields and subject name are rejected');
select throws_ok($$select admin.apply('profile_version_create',pg_temp.responses_input()||'{"adapter_config":{"reasoningEffort":"none","structuredOutput":"json_object","providerSubjectField":"user","store":false}}',null)$$,'P0001','INVALID_REQUEST','unsupported store request switch is rejected');
create function pg_temp.responses_defaults(p_defaults jsonb) returns jsonb language sql volatile as $f$
select jsonb_build_object('external_id',external_id,'expected_revision',revision::text,'name',name,'description',description,'defaults',p_defaults) from ai.providers where code='DEEPSEEK';
$f$;
select throws_ok($$select admin.apply('provider_update',pg_temp.responses_defaults('{"capability_code":"DEEPSEEK_CHAT","endpoint_url":"https://api.deepseek.com/chat/completions"}'),null)$$,'P0001','INVALID_REQUEST','provider defaults cannot retain the retired capability');
select throws_ok($$select admin.apply('provider_update',pg_temp.responses_defaults('{"capability_code":"DEEPSEEK_RESPONSES","endpoint_url":"https://api.deepseek.com/chat/completions"}'),null)$$,'P0001','INVALID_REQUEST','provider defaults cannot retain the old endpoint');
select * from finish();
rollback;
