begin;
-- Transaction-local owner fixtures. The live local environment is restored by rollback.
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000205','owner-audit@fixture.invalid');
delete from legal.current_state;
delete from admin.environment;
delete from admin.members;
create temporary table owner_audit_fixture(key text primary key,value jsonb);
insert into owner_audit_fixture values('before',jsonb_build_object('init_count',(select count(*) from audit.events where action='ENVIRONMENT_INITIALIZED'),'legal_count',(select count(*) from audit.events where action='LEGAL_CURRENT_PUBLISHED')));
insert into auth.users(id,email,banned_until) values('00000000-0000-4000-8000-000000000206','banned-owner@fixture.invalid',clock_timestamp()+interval '1 day');
insert into auth.users(id,email,deleted_at) values('00000000-0000-4000-8000-000000000207','deleted-owner@fixture.invalid',clock_timestamp());
select throws_ok($$select admin.initialize('LOCAL','00000000-0000-4000-8000-000000000206')$$,'P0001','INVALID_REQUEST','banned Auth target cannot bootstrap administrator');
select throws_ok($$select admin.initialize('LOCAL','00000000-0000-4000-8000-000000000207')$$,'P0001','INVALID_REQUEST','soft-deleted Auth target cannot bootstrap administrator');
select throws_ok($$select admin.initialize('LOCAL','00000000-0000-4000-8000-000000000208')$$,'P0001','INVALID_REQUEST','missing Auth target cannot bootstrap administrator');
select ok(not exists(select 1 from admin.environment),'invalid bootstrap targets create no environment');
select lives_ok($$select admin.initialize('LOCAL','00000000-0000-4000-8000-000000000205')$$,'owner initializes environment and audit atomically');
select is((select count(*)::bigint from audit.events where action='ENVIRONMENT_INITIALIZED'),((select value->>'init_count' from owner_audit_fixture where key='before')::bigint)+1,'one initialization event');
select ok((select actor_kind='SYSTEM' and actor_auth_user_id is null and summary->>'target_administrator_auth_user_id'='00000000-0000-4000-8000-000000000205' from audit.events where action='ENVIRONMENT_INITIALIZED' order by id desc limit 1),'target administrator is audited as target, not impersonated as actor');
select ok((select user_created is null and user_updated is null from admin.members where auth_user_id='00000000-0000-4000-8000-000000000205'),'owner bootstrap does not attribute creation to target user');
select lives_ok($$select admin.initialize('LOCAL','00000000-0000-4000-8000-000000000205')$$,'same owner initialization is idempotent');
select is((select count(*)::bigint from audit.events where action='ENVIRONMENT_INITIALIZED'),((select value->>'init_count' from owner_audit_fixture where key='before')::bigint)+1,'initialization replay adds no fake audit');
select throws_ok($$select admin.initialize('PRODUCTION','00000000-0000-4000-8000-000000000205')$$,'P0001','CONFLICT','different environment initialization rejected');
do $$declare v_current legal.document_versions;v_new jsonb;begin
 select d.* into v_current from legal.document_versions d join legal.current_state c on c.terms_document_version_id=d.id;
 v_new=common.insert_entity('legal.document_versions',jsonb_build_object('document_code','TERMS','version',(select max(version)+1 from legal.document_versions where document_code='TERMS'),'renderer_contract',v_current.renderer_contract,'content',v_current.content,'content_digest',v_current.content_digest));
 insert into pg_temp.owner_audit_fixture values('targets',jsonb_build_object('terms',v_new->>'external_id','bundle',(select b.external_id from legal.bundles b join legal.current_state c on c.ai_bundle_id=b.id),'generation',(select generation from ai.runtime_control where id=1),'close_cycle',(select close_cycle from ai.runtime_control where id=1)));
end$$;
select lives_ok($$select admin.publish_legal_current((select value->>'terms' from owner_audit_fixture where key='targets'),(select value->>'bundle' from owner_audit_fixture where key='targets'))$$,'owner publishes legal targets');
select is((select count(*)::bigint from audit.events where action='LEGAL_CURRENT_PUBLISHED'),((select value->>'legal_count' from owner_audit_fixture where key='before')::bigint)+1,'one legal publication event');
select ok((select actor_kind='SYSTEM' and actor_auth_user_id is null and summary->>'terms_document_version_id'=(select value->>'terms' from owner_audit_fixture where key='targets') from audit.events where action='LEGAL_CURRENT_PUBLISHED' order by id desc limit 1),'legal owner action has SYSTEM provenance and exact external target');
select ok((select not enabled and active_policy_version_id is null and generation=((select value->>'generation' from owner_audit_fixture where key='targets')::bigint)+1 and close_cycle=((select value->>'close_cycle' from owner_audit_fixture where key='targets')::bigint)+1 and user_updated is null from ai.runtime_control where id=1),'legal publication closes gate, clears pointer and advances controls');
select lives_ok($$select admin.publish_legal_current((select value->>'terms' from owner_audit_fixture where key='targets'),(select value->>'bundle' from owner_audit_fixture where key='targets'))$$,'same legal targets are a no-op');
select is((select count(*)::bigint from audit.events where action='LEGAL_CURRENT_PUBLISHED'),((select value->>'legal_count' from owner_audit_fixture where key='before')::bigint)+1,'legal replay does not create fake audit');
select ok(not has_function_privilege('authenticated','admin.initialize(text,uuid)','execute') and not has_function_privilege('service_role','admin.initialize(text,uuid)','execute') and not has_function_privilege('app_api_owner','admin.initialize(text,uuid)','execute'),'bootstrap stays owner-only');
select ok(not has_function_privilege('authenticated','admin.publish_legal_current(text,text)','execute') and not has_function_privilege('service_role','admin.publish_legal_current(text,text)','execute') and not has_function_privilege('app_api_owner','admin.publish_legal_current(text,text)','execute'),'legal publication stays owner-only');


-- Declaration-level lifecycle invariants: active Auth linkage is private and indexed.
select ok((select a.attgenerated='s' from pg_catalog.pg_attribute a where a.attrelid='admin.members'::regclass and a.attname='active_auth_user_id'),'active membership key is stored generated, never caller writable');
select ok((select con.confdeltype='r' and con.confrelid='auth.users'::regclass from pg_catalog.pg_constraint con where con.conrelid='admin.members'::regclass and con.conname='fk_admin_members_active_auth_user'),'active administrator uses restrictive Auth FK');
select ok(exists(select 1 from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid=i.indexrelid where i.indrelid='admin.members'::regclass and c.relname='ix_admin_members_active_auth_user_id' and pg_catalog.pg_get_expr(i.indpred,i.indrelid)='(active_auth_user_id IS NOT NULL)'),'active Auth FK delete path has partial index');
select ok((select not(admin.project('members',to_jsonb(m)) ? 'active_auth_user_id') and admin.project('members',to_jsonb(m))->>'auth_user_id'=m.auth_user_id::text from admin.members m where auth_user_id='00000000-0000-4000-8000-000000000205'),'Admin projection hides derived FK while preserving documented target Auth UUID');
select throws_ok($$delete from auth.users where id='00000000-0000-4000-8000-000000000205'$$,'23503',null,'active administrator cannot be deleted through Auth');
select throws_ok($$insert into admin.members(auth_user_id) values('00000000-0000-4000-8000-000000000209')$$,'23503',null,'membership activation cannot target a deleted or nonexistent Auth user');
update admin.members set time_revoked=clock_timestamp() where auth_user_id='00000000-0000-4000-8000-000000000205';
select is((select active_auth_user_id from admin.members where auth_user_id='00000000-0000-4000-8000-000000000205'),null::uuid,'revocation clears generated active linkage');
select lives_ok($$delete from auth.users where id='00000000-0000-4000-8000-000000000205'$$,'revoked administrator may be deleted through Auth');
select ok(exists(select 1 from admin.members where auth_user_id='00000000-0000-4000-8000-000000000205' and time_revoked is not null),'Auth deletion preserves revoked membership history and original target UUID');
select throws_ok($$update admin.members set time_revoked=null where auth_user_id='00000000-0000-4000-8000-000000000205'$$,'23503',null,'revoked historical member cannot reactivate after Auth deletion');

-- Guard evaluates effective privileges and both membership directions.
select lives_ok($$select common.assert_api_owner_safe()$$,'clean application API owner passes full guard');
select ok(not has_function_privilege('authenticated','common.assert_api_owner_safe()','execute') and not has_function_privilege('service_role','common.assert_api_owner_safe()','execute') and not has_function_privilege('app_api_owner','common.assert_api_owner_safe()','execute'),'role guard remains migration-owner-only');

select * from finish();

rollback;
