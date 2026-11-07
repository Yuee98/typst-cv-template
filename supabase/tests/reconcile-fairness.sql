-- Fairness under a full stale batch of indeterminate attempts; rollback-only, no network.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000000331', 'reconcile-fairness@fixture.invalid');
do $$
begin
  if not exists (select 1 from admin.environment) then
    insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000000332', 'reconcile-admin@fixture.invalid');
    perform admin.initialize ('LOCAL', '00000000-0000-4000-8000-000000000332');
  end if;
end
$$;
create temporary table reconcile_fixture (key text primary key, value jsonb);
insert into reconcile_fixture values ('base', (
  select jsonb_build_object('contract_code', contract_code, 'database_instance_id', database_instance_id, 'owner_auth_user_id', '00000000-0000-4000-8000-000000000331')
  from admin.environment where id = 1
));
-- Create one immutable graph using owner fixtures; public service RPCs still
-- produce every reservation, attempt permission and terminal usage fact below.
do $$
declare
  v_bundle bigint;
  v_provider bigint;
  v_profile bigint;
  v_version bigint;
  v_price bigint;
  v_policy bigint;
  v_policy_version bigint;
  v_option bigint;
  v_disclosure legal.disclosures;
begin
  select id into v_bundle from legal.bundles where time_sealed is not null order by id desc limit 1;
  select id into v_provider from ai.providers where code = 'DEEPSEEK';
  select * into v_disclosure from legal.disclosures where bundle_id = v_bundle and provider_id = v_provider;
  insert into ai.profiles (provider_id, code, name, description)
    values (v_provider, 'RECONCILE_FAIRNESS', 'Reconcile fairness', 'Rollback-only SQL fixture') returning id into v_profile;
  insert into ai.profile_versions (profile_id, version, provider_id, capability_id, endpoint_url, credential_ref, model_id, adapter_config, config_digest, legal_disclosure_id, legal_bundle_id, status, time_published)
    values (v_profile, 1, v_provider, (select id from ai.capabilities where code = 'DEEPSEEK_RESPONSES'), 'https://api.deepseek.com/responses', 'AI_PROVIDER_KEY_DEEPSEEK_RECONCILE_FIXTURE', v_disclosure.model_id, '{"reasoningEffort":"none","structuredOutput":"json_object","providerSubjectField":"user"}', repeat('1', 64), v_disclosure.id, v_bundle, 'PUBLISHED', clock_timestamp()) returning id into v_version;
  insert into ai.price_versions (profile_version_id, lane_code, version, currency, calculator_kind, parameters, time_valid_from, status, config_digest)
    values (v_version, 'STANDARD', 1, 'CNY', 'linear_token_v1', '{}', clock_timestamp() - interval '1 day', 'DRAFT', repeat('2', 64)) returning id into v_price;
  insert into ai.price_components values (v_price, 'INPUT_STANDARD', 1000000), (v_price, 'INPUT_CACHE_READ', 100000), (v_price, 'INPUT_CACHE_WRITE', 0), (v_price, 'OUTPUT', 2000000);
  update ai.price_versions set status = 'PUBLISHED', time_published = clock_timestamp() where id = v_price;
  insert into ai.policies (code, name, description) values ('RECONCILE_FAIRNESS', 'Reconcile fairness', 'Rollback-only SQL fixture') returning id into v_policy;
  insert into ai.policy_versions (policy_id, version, legal_bundle_id, config_digest) values (v_policy, 1, v_bundle, repeat('3', 64)) returning id into v_policy_version;
  insert into ai.policy_options (policy_version_id, legal_bundle_id, profile_version_id, price_lane_code, display_order) values (v_policy_version, v_bundle, v_version, 'STANDARD', 0) returning id into v_option;
  insert into ai.routing_rules values (v_policy_version, 0, true, null, null, null, v_option);
  insert into ai.routing_rule_options values (v_policy_version, 0, v_option);
  update ai.policy_versions set status = 'PUBLISHED', time_published = clock_timestamp() where id = v_policy_version;
  insert into legal.acceptances (owner_auth_user_id, disclosure_id, accepted_content_digest) values ('00000000-0000-4000-8000-000000000331', v_disclosure.id, v_disclosure.content_digest);
  update ai.runtime_control set active_policy_version_id = v_policy_version, enabled = true, audience = 'ALL', user_daily_limit = 1000, user_minute_limit = 1000, global_daily_limit = 1000, generation = generation + 1 where id = 1;
end
$$;
set constraints all immediate;
insert into reconcile_fixture values ('reserve', (
  select f.value || jsonb_build_object('selected_option_id', o ->> 'option_id', 'expected_generation', a ->> 'generation', 'expected_policy_version_id', a ->> 'policy_version_id', 'expected_profile_version_id', o ->> 'profile_version_id', 'disclosure_id', o ->> 'disclosure_id', 'content_digest', o ->> 'content_digest')
  from pg_temp.reconcile_fixture f
  cross join lateral (select public.ai_availability(f.value) as a) av
  cross join lateral jsonb_array_elements(a -> 'options') o
  where f.key = 'base' and o ->> 'status' = 'READY'
  limit 1
));
create function pg_temp.reconcile_request (p_key text, p_attempt_state text default null, p_held boolean default false)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare
  v_input jsonb;
  v_request jsonb;
  v_attempt jsonb;
begin
  select value || jsonb_build_object('client_request_key', gen_random_uuid(), 'request_fingerprint', p_key) into v_input from pg_temp.reconcile_fixture where key = 'reserve';
  v_request := public.ai_reserve(v_input);
  v_input := v_input || jsonb_build_object('request_id', v_request ->> 'request_id', 'attempt_no', 1);
  if p_attempt_state is not null then
    v_attempt := public.ai_attempt_start(v_input);
    v_input := v_input || jsonb_build_object('attempt_id', v_attempt ->> 'attempt_id');
    if p_attempt_state <> 'STARTED' then
      perform public.ai_attempt_complete(v_input || jsonb_build_object('state', p_attempt_state, 'transmitted', case when p_attempt_state = 'UNKNOWN' then null else true end, 'provider_billable', case when p_attempt_state = 'UNKNOWN' then null else true end, 'retry_allowed', false, 'usage', case when p_attempt_state = 'UNKNOWN' then '{}'::jsonb else '{"input_total":"10","input_standard":"8","cache_read":"2","cache_write":"0","output":"4","reasoning":"0"}'::jsonb end));
    end if;
  end if;
  if p_held then update ai.requests set state = 'HELD' where external_id = v_request ->> 'request_id'; end if;
  insert into pg_temp.reconcile_fixture values (p_key, v_input);
  return v_input;
end
$$;
do $$
begin
  for v_i in 1..100 loop perform pg_temp.reconcile_request('pending-' || v_i, 'STARTED'); end loop;
  for v_i in 1..100 loop perform pg_temp.reconcile_request('unknown-' || v_i, 'UNKNOWN', true); end loop;
  perform pg_temp.reconcile_request('zero-attempt');
  perform pg_temp.reconcile_request('known-success', 'SUCCEEDED');
  perform pg_temp.reconcile_request('known-held-failure', 'FAILED_UPSTREAM', true);
  update ai.requests set time_progress = clock_timestamp() - interval '601 seconds' where owner_auth_user_id = '00000000-0000-4000-8000-000000000331';
end
$$;

select is(ai.reconcile(100), 100, 'first bounded batch moves 100 stale STARTED requests to HELD');
select is((select count(*)::integer from ai.requests r join pg_temp.reconcile_fixture f on r.external_id = f.value ->> 'request_id' where f.key like 'pending-%' and r.state = 'HELD'), 100, 'in-flight requests are held without inventing terminal facts');
select is(ai.reconcile(100), 3, 'already HELD indeterminate attempts do not starve later actionable work');
select ok((select r.state = 'FINALIZED' and r.outcome = 'RELEASED' and not r.charged from ai.requests r join pg_temp.reconcile_fixture f on r.external_id = f.value ->> 'request_id' where f.key = 'zero-attempt'), 'later zero-attempt reservation is released');
select ok((select r.state = 'FINALIZED' and r.outcome = 'SUCCEEDED' and r.charged and r.estimated_cost_nanos = 17 from ai.requests r join pg_temp.reconcile_fixture f on r.external_id = f.value ->> 'request_id' where f.key = 'known-success'), 'later known success settles exact synthetic cost once');
select ok((select r.state = 'FINALIZED' and r.outcome = 'FAILED_UPSTREAM' and not r.charged from ai.requests r join pg_temp.reconcile_fixture f on r.external_id = f.value ->> 'request_id' where f.key = 'known-held-failure'), 'HELD request with complete terminal facts remains actionable');
select is(ai.reconcile(100), 0, 'repeat cron does not spend slots on unchanged indeterminate HELD rows');
select is((select count(*)::integer from ai.attempts a join ai.requests r on r.id = a.request_id where r.owner_auth_user_id = '00000000-0000-4000-8000-000000000331' and a.state = 'STARTED' and a.time_terminal is null), 100, 'STARTED attempt facts stay intact');
select is((select count(*)::integer from ai.attempts a join ai.requests r on r.id = a.request_id where r.owner_auth_user_id = '00000000-0000-4000-8000-000000000331' and a.state = 'UNKNOWN' and a.transmitted is null and a.provider_billable is null and a.estimated_cost_nanos is null), 100, 'terminal UNKNOWN facts and unknown costs stay intact');
select ok((select reserved_count = 200 and charged_count = 1 from ai.user_usage_daily where auth_user_id = '00000000-0000-4000-8000-000000000331' and day = (clock_timestamp() at time zone 'UTC')::date), 'indeterminate requests retain all 200 quota reservations');

-- A trusted late producer fact makes one HELD request eligible again. Age the
-- progress clock explicitly to model the next stale reconciliation window.
select public.ai_attempt_complete((select value from pg_temp.reconcile_fixture where key = 'pending-1') || '{"state":"SUCCEEDED","transmitted":true,"provider_billable":true,"retry_allowed":false,"usage":{"input_total":"10","input_standard":"8","cache_read":"2","cache_write":"0","output":"4","reasoning":"0"}}');
update ai.requests set time_progress = clock_timestamp() - interval '601 seconds' where external_id = (select value ->> 'request_id' from pg_temp.reconcile_fixture where key = 'pending-1');
select is(ai.reconcile(100), 1, 'late completion makes the original HELD request actionable');
select ok((select r.state = 'FINALIZED' and r.outcome = 'SUCCEEDED' and r.charged from ai.requests r join pg_temp.reconcile_fixture f on r.external_id = f.value ->> 'request_id' where f.key = 'pending-1'), 'late known completion settles the original held request');
select is(ai.reconcile(100), 0, 'late settlement is not repeated');
select ok((select reserved_count = 199 and charged_count = 2 from ai.user_usage_daily where auth_user_id = '00000000-0000-4000-8000-000000000331' and day = (clock_timestamp() at time zone 'UTC')::date), 'late settlement releases only its reservation and charges once');
select throws_ok($$select ai.reconcile(null)$$, 'P0001', 'INVALID_REQUEST', 'null batch size cannot make cron unbounded');
select ok(not has_function_privilege('app_api_owner', 'ai.reconcile(integer)', 'execute') and not has_function_privilege('authenticated', 'ai.reconcile(integer)', 'execute') and not has_function_privilege('service_role', 'ai.reconcile(integer)', 'execute') and not has_function_privilege('anon', 'ai.reconcile(integer)', 'execute'), 'reconciliation stays owner/cron-only');
select ok((select not prosecdef and proconfig = array['search_path=""'] from pg_catalog.pg_proc where oid = 'ai.reconcile(integer)'::regprocedure), 'reconciler retains invoker security and empty search path');
select * from finish();
rollback;
