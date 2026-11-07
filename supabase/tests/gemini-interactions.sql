-- Gemini uses the stable stateless Interactions contract; all test changes roll back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
select is((select count(*)::int from ai.providers where code='GEMINI' and recipient_code='GOOGLE_AI_STUDIO' and gateway_kind='DIRECT'),1,'Google AI Studio is a distinct direct recipient');
select ok((select default_model_id='gemini-3.8-flash' and default_endpoint_url='https://generativelanguage.googleapis.com/v1/interactions' and default_credential_ref is null from ai.providers where code='GEMINI'),'catalog carries the current model and stable endpoint without credentials');
select ok((select adapter_kind='gemini_interactions_v1' and wire_api_kind='interactions_v1' and execution_contract='cv_polish_1' and calculator_kind='linear_token_v1' and cache_policy='automatic' and time_deprecated is null from ai.capabilities where code='GEMINI_INTERACTIONS'),'Gemini descriptor matches the supported execution semantics');
select is((select descriptor_digest from ai.capabilities where code='GEMINI_INTERACTIONS'),'5802a15c2088f163dfb49c770d480ca168521a5eba2f145de9aca8ed279943df','database capability digest matches compiled Gemini code');
select ok((select new.ai_document_version_id<>old.ai_document_version_id and new.time_sealed is not null and old.time_sealed is not null and new.manifest_digest<>old.manifest_digest from legal.bundles new cross join legal.bundles old where new.code='CV_APP_GEMINI_20261107' and old.code='CV_APP_RESPONSES_20261107'),'Google has a new sealed bundle and common AI terms version');
select is((select count(*)::int from legal.disclosures d join legal.bundles b on b.id=d.bundle_id where b.code='CV_APP_GEMINI_20261107'),3,'new bundle discloses all three supported recipients');
select ok(not exists(select 1 from legal.disclosures d join legal.bundles b on b.id=d.bundle_id join legal.document_versions a on a.id=b.ai_document_version_id where b.code='CV_APP_GEMINI_20261107' and d.content_digest<>common.digest(jsonb_build_object('content',d.content,'ai_document_digest',a.content_digest,'manifest_digest',b.manifest_digest))),'all three exact consent digests bind the new common terms and manifest');
select ok((select d.model_id='gemini-3.8-flash' and d.recipient_code='GOOGLE_AI_STUDIO' and octet_length(d.content::text)<32768 from legal.disclosures d join legal.bundles b on b.id=d.bundle_id join ai.providers p on p.id=d.provider_id where b.code='CV_APP_GEMINI_20261107' and p.code='GEMINI'),'Google disclosure matches its model, recipient and bounded renderer');
create temporary table gemini_fixture(profile jsonb);
insert into gemini_fixture select common.insert_entity('ai.profiles',jsonb_build_object('provider_id',p.id,'code','GEMINI_SQL_FIXTURE','name','Gemini fixture','description','Rollback only')) from ai.providers p where p.code='GEMINI';
create function pg_temp.gemini_input() returns jsonb language sql volatile as $f$
select jsonb_build_object('profile_id',p.external_id,'expected_revision',p.revision::text,'capability_code','GEMINI_INTERACTIONS','endpoint_url','https://generativelanguage.googleapis.com/v1/interactions','credential_ref','AI_PROVIDER_KEY_GEMINI_SQL_TEST','model_id',d.model_id,'disclosure_id',d.external_id,'adapter_config','{"thinkingLevel":"low","thinkingSummaries":"none","structuredOutput":"json_schema","sendProviderSubjectId":false,"store":false,"background":false}'::jsonb)
from ai.profiles p join pg_temp.gemini_fixture f on f.profile->>'external_id'=p.external_id join legal.disclosures d on d.provider_id=p.provider_id join legal.bundles b on b.id=d.bundle_id where b.code='CV_APP_GEMINI_20261107';
$f$;
select lives_ok($$select admin.apply('profile_version_create',pg_temp.gemini_input(),null)$$,'Gemini creates using exact stateless low-thinking structured JSON configuration');
select throws_ok($$select admin.apply('profile_version_create',pg_temp.gemini_input()||'{"endpoint_url":"https://generativelanguage.googleapis.com/v1beta/interactions"}',null)$$,'P0001','INVALID_REQUEST','beta endpoint is not accepted as a second protocol');
select throws_ok($$select admin.apply('profile_version_create',pg_temp.gemini_input()||'{"endpoint_url":"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent"}',null)$$,'P0001','INVALID_REQUEST','generateContent has no execution fallback');
select throws_ok($$select admin.apply('profile_version_create',pg_temp.gemini_input()||'{"capability_code":"DEEPSEEK_RESPONSES"}',null)$$,'P0001','INVALID_REQUEST','another Provider capability cannot be attached to Gemini');
select throws_ok($$select admin.apply('profile_version_create',pg_temp.gemini_input()||'{"credential_ref":"AI_PROVIDER_KEY_DEEPSEEK_WRONG_PROVIDER"}',null)$$,'P0001','INVALID_REQUEST','credential references are scoped to Gemini');
select throws_ok($$select admin.apply('profile_version_create',jsonb_set(pg_temp.gemini_input(),'{adapter_config,store}','true'),null)$$,'P0001','INVALID_REQUEST','server-side stored interactions are forbidden');
select throws_ok($$select admin.apply('profile_version_create',jsonb_set(pg_temp.gemini_input(),'{adapter_config,background}','true'),null)$$,'P0001','INVALID_REQUEST','background interactions are forbidden');
select throws_ok($$select admin.apply('profile_version_create',jsonb_set(pg_temp.gemini_input(),'{adapter_config,sendProviderSubjectId}','true'),null)$$,'P0001','INVALID_REQUEST','Google requests cannot carry an account subject');
select throws_ok($$select admin.apply('profile_version_create',jsonb_set(pg_temp.gemini_input(),'{adapter_config,thinkingLevel}','"high"'),null)$$,'P0001','INVALID_REQUEST','configured thinking budget cannot silently increase');
select throws_ok($$select admin.apply('profile_version_create',pg_temp.gemini_input()#-'{adapter_config,thinkingSummaries}',null)$$,'P0001','INVALID_REQUEST','incomplete adapter format is rejected');
create function pg_temp.gemini_defaults(p_defaults jsonb) returns jsonb language sql volatile as $f$
select jsonb_build_object('external_id',external_id,'expected_revision',revision::text,'name',name,'description',description,'defaults',p_defaults) from ai.providers where code='GEMINI';
$f$;
select throws_ok($$select admin.apply('provider_update',pg_temp.gemini_defaults('{"capability_code":"MIMO_RESPONSES","endpoint_url":"https://generativelanguage.googleapis.com/v1/interactions"}'),null)$$,'P0001','INVALID_REQUEST','Google defaults require its own capability');
select throws_ok($$select admin.apply('provider_update',pg_temp.gemini_defaults('{"capability_code":"GEMINI_INTERACTIONS","endpoint_url":"https://generativelanguage.googleapis.com/v1beta/interactions"}'),null)$$,'P0001','INVALID_REQUEST','Google defaults require the stable endpoint');
select * from finish();
rollback;
