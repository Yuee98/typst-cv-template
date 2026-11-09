-- OWNER ONLY. Disposable database only. Never apply this fixture to a hosted or main local database.
do $$ begin if current_database() not like 'cv\_%' escape '\' then raise exception 'Fixture requires a disposable cv_ database';end if;end $$;
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
select jsonb_build_object('fixture','ai-runtime','user','00000000-0000-4000-8000-000000000091','configurations',(select count(*) from ai.configurations where name like 'Synthetic runtime fixture %'));
