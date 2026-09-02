-- CFG-002: dark MiMo V2 catalog publication. This migration deliberately
-- registers and seals only the reviewed runtime root; the price stays unsealed.
begin;

-- Existing authored identities are never repaired. Check the price child set
-- before any insert so a partial pre-existing price cannot be completed here.
do $$
declare
  v_count bigint;
begin
  if exists (
    select 1 from public.ai_price_versions
    where id = '22222222-2222-4222-8222-222222222222'::uuid
       or (profile_version_id = '22222222-2222-4222-8222-222222222221'::uuid
           and pricing_lane = 'default' and version = 1)
  ) then
    select count(*) into v_count from public.ai_price_components
    where price_version_id = '22222222-2222-4222-8222-222222222222'::uuid;
    if v_count <> 4 then
      raise exception 'MiMo V2 pre-existing price component set is partial' using errcode = '23514';
    end if;
  end if;
end;
$$;

insert into public.ai_provider_profiles (id, profile_key, display_name, gateway_kind, model_vendor)
select
  '22222222-2222-4222-8222-222222222220'::uuid,
  'mimo.cn.mimo-v2.5-pro.responses.v1',
  'MiMo V2.5 Pro',
  'direct_mimo',
  'xiaomi-mimo'
where not exists (
  select 1 from public.ai_provider_profiles
  where id = '22222222-2222-4222-8222-222222222220'::uuid
);

do $$
begin
  if (select count(*) from public.ai_provider_profiles
      where id = '22222222-2222-4222-8222-222222222220'::uuid
         or profile_key = 'mimo.cn.mimo-v2.5-pro.responses.v1') <> 1
     or not exists (
       select 1 from public.ai_provider_profiles
       where id = '22222222-2222-4222-8222-222222222220'::uuid
         and profile_key = 'mimo.cn.mimo-v2.5-pro.responses.v1'
         and display_name = 'MiMo V2.5 Pro'
         and gateway_kind = 'direct_mimo'
         and model_vendor = 'xiaomi-mimo'
         and retired_at is null
     ) then
    raise exception 'MiMo V2 profile identity mismatch' using errcode = '23514';
  end if;
end;
$$;

insert into public.ai_provider_profile_versions (
  id, profile_id, version, status, adapter_kind, wire_api_kind,
  credential_alias, endpoint_alias, model_id, model_snapshot, upstream_route,
  capability_contract_id, cache_policy_id, legal_manifest_id,
  display_disclosure_key, config, config_sha256
)
select
  '22222222-2222-4222-8222-222222222221'::uuid,
  '22222222-2222-4222-8222-222222222220'::uuid,
  1, 'draft', 'mimo_responses_v1', 'responses_v1',
  'mimo_api_key', 'mimo_cn_official', 'mimo-v2.5-pro', null, '{}'::jsonb,
  'mimo_responses_output_text_v1', 'mimo_automatic_prompt_cache_v1',
  'mimo-cn-2026-08-23-v1', 'mimo-cn-v1',
  '{"reasoningEffort":"none","structuredOutput":"prompt_only","sendProviderSubjectId":false}'::jsonb,
  '319316de510f767885fdb94d75d067a7383c11f513b908026a2ab4ec68c8a121'
where not exists (
  select 1 from public.ai_provider_profile_versions
  where id = '22222222-2222-4222-8222-222222222221'::uuid
);

do $$
begin
  if (select count(*) from public.ai_provider_profile_versions
      where id = '22222222-2222-4222-8222-222222222221'::uuid
         or (profile_id = '22222222-2222-4222-8222-222222222220'::uuid and version = 1)) <> 1
     or not exists (
       select 1 from public.ai_provider_profile_versions
       where id = '22222222-2222-4222-8222-222222222221'::uuid
         and profile_id = '22222222-2222-4222-8222-222222222220'::uuid
         and version = 1 and status = 'draft'
         and adapter_kind = 'mimo_responses_v1' and wire_api_kind = 'responses_v1'
         and credential_alias = 'mimo_api_key' and endpoint_alias = 'mimo_cn_official'
         and model_id = 'mimo-v2.5-pro' and model_snapshot is null
         and upstream_route = '{}'::jsonb
         and capability_contract_id = 'mimo_responses_output_text_v1'
         and cache_policy_id = 'mimo_automatic_prompt_cache_v1'
         and legal_manifest_id = 'mimo-cn-2026-08-23-v1'
         and display_disclosure_key = 'mimo-cn-v1'
         and config = '{"reasoningEffort":"none","structuredOutput":"prompt_only","sendProviderSubjectId":false}'::jsonb
         and config_sha256 = '319316de510f767885fdb94d75d067a7383c11f513b908026a2ab4ec68c8a121'
         and validated_at is null and activated_at is null and retired_at is null
     ) then
    raise exception 'MiMo V2 profile version mismatch' using errcode = '23514';
  end if;
end;
$$;

insert into public.ai_price_versions (
  id, profile_version_id, pricing_lane, version, currency, calculator_kind,
  valid_from, valid_to, provider_effective_from, provider_effective_to,
  source_url, source_checked_at, source_snapshot_sha256, parameters
)
select
  '22222222-2222-4222-8222-222222222222'::uuid,
  '22222222-2222-4222-8222-222222222221'::uuid,
  'default', 1, 'CNY', 'linear_token_v1',
  '2026-08-25T16:26:26.127Z'::timestamptz, null, '2026-05-26T16:00:00Z'::timestamptz, null,
  'https://mimo.mi.com/docs/en-US/price/pay-as-you-go',
  '2026-08-28T08:05:41.986Z'::timestamptz,
  'd43d4c3ad011b00c6dbf4a2966871ebfe566e9a0cbdc2a77ee38833aa1b5edb3',
  '{}'::jsonb
where not exists (
  select 1 from public.ai_price_versions
  where id = '22222222-2222-4222-8222-222222222222'::uuid
);

do $$
begin
  if (select count(*) from public.ai_price_versions
      where id = '22222222-2222-4222-8222-222222222222'::uuid
         or (profile_version_id = '22222222-2222-4222-8222-222222222221'::uuid
             and pricing_lane = 'default' and version = 1)) <> 1
     or not exists (
       select 1 from public.ai_price_versions
       where id = '22222222-2222-4222-8222-222222222222'::uuid
         and profile_version_id = '22222222-2222-4222-8222-222222222221'::uuid
         and pricing_lane = 'default' and version = 1 and currency = 'CNY'
         and calculator_kind = 'linear_token_v1'
         and valid_from = '2026-08-25T16:26:26.127Z'::timestamptz
         and valid_to is null and provider_effective_from = '2026-05-26T16:00:00Z'::timestamptz and provider_effective_to is null
         and source_url = 'https://mimo.mi.com/docs/en-US/price/pay-as-you-go'
         and source_checked_at = '2026-08-28T08:05:41.986Z'::timestamptz
         and source_snapshot_sha256 = 'd43d4c3ad011b00c6dbf4a2966871ebfe566e9a0cbdc2a77ee38833aa1b5edb3'
         and parameters = '{}'::jsonb and components_sealed_at is null
     ) then
    raise exception 'MiMo V2 price version mismatch' using errcode = '23514';
  end if;
end;
$$;

insert into public.ai_price_components (price_version_id, component, nanos_per_million)
select expected.price_version_id, expected.component, expected.nanos_per_million
from (values
  ('22222222-2222-4222-8222-222222222222'::uuid, 'input_cache_read'::text, 25000000::bigint),
  ('22222222-2222-4222-8222-222222222222'::uuid, 'input_standard'::text, 3000000000::bigint),
  ('22222222-2222-4222-8222-222222222222'::uuid, 'input_cache_write'::text, 0::bigint),
  ('22222222-2222-4222-8222-222222222222'::uuid, 'output'::text, 6000000000::bigint)
) as expected(price_version_id, component, nanos_per_million)
where not exists (
  select 1 from public.ai_price_components as actual
  where actual.price_version_id = expected.price_version_id
    and actual.component = expected.component
);

do $$
begin
  if (select count(*) from public.ai_price_components
      where price_version_id = '22222222-2222-4222-8222-222222222222'::uuid) <> 4
     or (select count(*) from public.ai_price_components as actual join (values
       ('input_cache_read'::text, 25000000::bigint),
       ('input_standard'::text, 3000000000::bigint),
       ('input_cache_write'::text, 0::bigint),
       ('output'::text, 6000000000::bigint)
     ) as expected(component, nanos_per_million) using (component, nanos_per_million)
     where actual.price_version_id = '22222222-2222-4222-8222-222222222222'::uuid) <> 4 then
    raise exception 'MiMo V2 price component mismatch' using errcode = '23514';
  end if;
end;
$$;

-- Read-only legal-bundle reassertion: the foreign-keyed runtime projections
-- must keep consuming the sealed CFG-000 bundle rather than authoring legal facts.
do $$
begin
  if not exists (
    select 1 from public.ai_legal_bundle_versions
    where legal_bundle_version = '2026-08-23-multi-provider-v1'
      and bundle_contract_sha256 = 'fc26d1e1a016fda055fbe6a0b79b48d804fd7610e03bd5aa29389be37359ca18'
      and sealed_at is not null
  ) or (select count(*) from public.ai_legal_bundle_manifests
         where legal_bundle_version = '2026-08-23-multi-provider-v1') <> 2
     or (select count(*) from public.ai_legal_bundle_manifests
         where legal_bundle_version = '2026-08-23-multi-provider-v1'
           and (legal_manifest_id, manifest_sha256) in (
             ('deepseek-official-2026-08-23-v1', '0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b'),
             ('mimo-cn-2026-08-23-v1', 'f075f1e39e74a96ef2b536df8ba1e19c0840ce6d3be47d6deccd9c95da861c3f')
           )) <> 2 then
    raise exception 'MiMo V2 legal bundle projection mismatch' using errcode = '23514';
  end if;
end;
$$;

insert into public.ai_service_runtime_target_versions (
  runtime_target_id, runtime_target_sha256, profile_key, legal_manifest_id,
  manifest_sha256, route_descriptor_id, route_descriptor_sha256
)
select * from (values
  ('runtime-target.deepseek.official.deepseek-v4-flash.chat.v1'::text,
   'aa4948f6f0060a08ada1d0b831babd17c37287be02a9a8f2f9ec69c0f2bed119'::text,
   'deepseek.official.deepseek-v4-flash.chat.v1'::text,
   'deepseek-official-2026-08-23-v1'::text,
   '0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b'::text,
   'route.deepseek.official.v1'::text,
   'ddd46ac3d94fa9a3d4293f5f59faa52ee93a418927d13a01798f0802ccc99d79'::text),
  ('runtime-target.mimo.cn.mimo-v2.5-pro.responses.v1'::text,
   '091416c8ff3d9c3b32c24d6906b8d618a70da91a9e3cd68132aadcfa964121a6'::text,
   'mimo.cn.mimo-v2.5-pro.responses.v1'::text,
   'mimo-cn-2026-08-23-v1'::text,
   'f075f1e39e74a96ef2b536df8ba1e19c0840ce6d3be47d6deccd9c95da861c3f'::text,
   'route.mimo.cn.official.v1'::text,
   '405655fe1a3bbc0aa2eff7217b3f78bc8cd0b991f69cf35c06ac361b041e52fa'::text)
) as expected(runtime_target_id, runtime_target_sha256, profile_key, legal_manifest_id, manifest_sha256, route_descriptor_id, route_descriptor_sha256)
where not exists (
  select 1 from public.ai_service_runtime_target_versions as actual
  where actual.runtime_target_id = expected.runtime_target_id
);

do $$
begin
  if (select count(*) from public.ai_service_runtime_target_versions as actual join (values
    ('runtime-target.deepseek.official.deepseek-v4-flash.chat.v1'::text, 'aa4948f6f0060a08ada1d0b831babd17c37287be02a9a8f2f9ec69c0f2bed119'::text, 'deepseek.official.deepseek-v4-flash.chat.v1'::text, 'deepseek-official-2026-08-23-v1'::text, '0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b'::text, 'route.deepseek.official.v1'::text, 'ddd46ac3d94fa9a3d4293f5f59faa52ee93a418927d13a01798f0802ccc99d79'::text),
    ('runtime-target.mimo.cn.mimo-v2.5-pro.responses.v1'::text, '091416c8ff3d9c3b32c24d6906b8d618a70da91a9e3cd68132aadcfa964121a6'::text, 'mimo.cn.mimo-v2.5-pro.responses.v1'::text, 'mimo-cn-2026-08-23-v1'::text, 'f075f1e39e74a96ef2b536df8ba1e19c0840ce6d3be47d6deccd9c95da861c3f'::text, 'route.mimo.cn.official.v1'::text, '405655fe1a3bbc0aa2eff7217b3f78bc8cd0b991f69cf35c06ac361b041e52fa'::text)
  ) as expected(runtime_target_id, runtime_target_sha256, profile_key, legal_manifest_id, manifest_sha256, route_descriptor_id, route_descriptor_sha256)
    using (runtime_target_id, runtime_target_sha256, profile_key, legal_manifest_id, manifest_sha256, route_descriptor_id, route_descriptor_sha256)) <> 2 then
    raise exception 'MiMo V2 runtime target projection mismatch' using errcode = '23514';
  end if;
end;
$$;

insert into public.ai_service_runtime_contract_versions (
  runtime_contract_id, legal_bundle_version, bundle_contract_sha256,
  runtime_target_set_sha256
)
select
  'runtime.deepseek-v2-mimo-v2.5-pro.v2',
  '2026-08-23-multi-provider-v1',
  'fc26d1e1a016fda055fbe6a0b79b48d804fd7610e03bd5aa29389be37359ca18',
  '2ae3a6e969ceee2772d2863ffa23d11dd8e5e725b32df39969f5ade746b55878'
where not exists (
  select 1 from public.ai_service_runtime_contract_versions
  where runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v2'
);

do $$
begin
  if (select count(*) from public.ai_service_runtime_contract_versions
      where runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v2') <> 1
     or not exists (
       select 1 from public.ai_service_runtime_contract_versions
       where runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v2'
         and legal_bundle_version = '2026-08-23-multi-provider-v1'
         and bundle_contract_sha256 = 'fc26d1e1a016fda055fbe6a0b79b48d804fd7610e03bd5aa29389be37359ca18'
         and runtime_target_set_sha256 = '2ae3a6e969ceee2772d2863ffa23d11dd8e5e725b32df39969f5ade746b55878'
     ) then
    raise exception 'MiMo V2 runtime root mismatch' using errcode = '23514';
  end if;
end;
$$;

-- The membership trigger takes the same root lock. A sealed pre-existing root
-- is never mutated; an unsealed exact root receives only absent exact members.
insert into public.ai_service_runtime_contract_targets (
  runtime_contract_id, runtime_target_id, runtime_target_sha256,
  profile_key, legal_manifest_id, manifest_sha256,
  route_descriptor_id, route_descriptor_sha256
)
select
  'runtime.deepseek-v2-mimo-v2.5-pro.v2',
  expected.runtime_target_id, expected.runtime_target_sha256, expected.profile_key,
  expected.legal_manifest_id, expected.manifest_sha256, expected.route_descriptor_id,
  expected.route_descriptor_sha256
from (values
  ('runtime-target.deepseek.official.deepseek-v4-flash.chat.v1'::text, 'aa4948f6f0060a08ada1d0b831babd17c37287be02a9a8f2f9ec69c0f2bed119'::text, 'deepseek.official.deepseek-v4-flash.chat.v1'::text, 'deepseek-official-2026-08-23-v1'::text, '0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b'::text, 'route.deepseek.official.v1'::text, 'ddd46ac3d94fa9a3d4293f5f59faa52ee93a418927d13a01798f0802ccc99d79'::text),
  ('runtime-target.mimo.cn.mimo-v2.5-pro.responses.v1'::text, '091416c8ff3d9c3b32c24d6906b8d618a70da91a9e3cd68132aadcfa964121a6'::text, 'mimo.cn.mimo-v2.5-pro.responses.v1'::text, 'mimo-cn-2026-08-23-v1'::text, 'f075f1e39e74a96ef2b536df8ba1e19c0840ce6d3be47d6deccd9c95da861c3f'::text, 'route.mimo.cn.official.v1'::text, '405655fe1a3bbc0aa2eff7217b3f78bc8cd0b991f69cf35c06ac361b041e52fa'::text)
) as expected(runtime_target_id, runtime_target_sha256, profile_key, legal_manifest_id, manifest_sha256, route_descriptor_id, route_descriptor_sha256)
join public.ai_service_runtime_contract_versions as root
  on root.runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v2'
 and root.sealed_at is null
where not exists (
  select 1 from public.ai_service_runtime_contract_targets as actual
  where actual.runtime_contract_id = root.runtime_contract_id
    and actual.runtime_target_id = expected.runtime_target_id
);

do $$
declare
  v_sealed_at timestamptz;
begin
  select sealed_at into v_sealed_at
  from public.ai_service_runtime_contract_versions
  where runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v2'
  for update;
  if not found
     or (select count(*) from public.ai_service_runtime_contract_targets
         where runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v2') <> 2
     or (select count(*) from public.ai_service_runtime_contract_targets as actual join (values
       ('runtime-target.deepseek.official.deepseek-v4-flash.chat.v1'::text, 'deepseek.official.deepseek-v4-flash.chat.v1'::text),
       ('runtime-target.mimo.cn.mimo-v2.5-pro.responses.v1'::text, 'mimo.cn.mimo-v2.5-pro.responses.v1'::text)
     ) as expected(runtime_target_id, profile_key) using (runtime_target_id, profile_key)
     where actual.runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v2') <> 2 then
    raise exception 'MiMo V2 runtime membership mismatch' using errcode = '23514';
  end if;
end;
$$;

update public.ai_service_runtime_contract_versions
set sealed_at = greatest(clock_timestamp(), created_at)
where runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v2'
  and legal_bundle_version = '2026-08-23-multi-provider-v1'
  and bundle_contract_sha256 = 'fc26d1e1a016fda055fbe6a0b79b48d804fd7610e03bd5aa29389be37359ca18'
  and runtime_target_set_sha256 = '2ae3a6e969ceee2772d2863ffa23d11dd8e5e725b32df39969f5ade746b55878'
  and sealed_at is null;

do $$
begin
  if not exists (
    select 1 from public.ai_provider_profiles
    where id = '22222222-2222-4222-8222-222222222220'::uuid
      and profile_key = 'mimo.cn.mimo-v2.5-pro.responses.v1'
      and display_name = 'MiMo V2.5 Pro' and gateway_kind = 'direct_mimo'
      and model_vendor = 'xiaomi-mimo' and retired_at is null
  ) or not exists (
    select 1 from public.ai_provider_profile_versions
    where id = '22222222-2222-4222-8222-222222222221'::uuid
      and profile_id = '22222222-2222-4222-8222-222222222220'::uuid
      and version = 1 and status = 'draft' and adapter_kind = 'mimo_responses_v1'
      and wire_api_kind = 'responses_v1' and credential_alias = 'mimo_api_key'
      and endpoint_alias = 'mimo_cn_official' and model_id = 'mimo-v2.5-pro'
      and model_snapshot is null and upstream_route = '{}'::jsonb
      and capability_contract_id = 'mimo_responses_output_text_v1'
      and cache_policy_id = 'mimo_automatic_prompt_cache_v1'
      and legal_manifest_id = 'mimo-cn-2026-08-23-v1'
      and display_disclosure_key = 'mimo-cn-v1'
      and config = '{"reasoningEffort":"none","structuredOutput":"prompt_only","sendProviderSubjectId":false}'::jsonb
      and config_sha256 = '319316de510f767885fdb94d75d067a7383c11f513b908026a2ab4ec68c8a121'
      and validated_at is null and activated_at is null and retired_at is null
  ) or not exists (
    select 1 from public.ai_price_versions
    where id = '22222222-2222-4222-8222-222222222222'::uuid
      and profile_version_id = '22222222-2222-4222-8222-222222222221'::uuid
      and pricing_lane = 'default' and version = 1 and currency = 'CNY'
      and calculator_kind = 'linear_token_v1'
      and valid_from = '2026-08-25T16:26:26.127Z'::timestamptz
      and valid_to is null and provider_effective_from = '2026-05-26T16:00:00Z'::timestamptz and provider_effective_to is null
      and source_url = 'https://mimo.mi.com/docs/en-US/price/pay-as-you-go'
      and source_checked_at = '2026-08-28T08:05:41.986Z'::timestamptz
      and source_snapshot_sha256 = 'd43d4c3ad011b00c6dbf4a2966871ebfe566e9a0cbdc2a77ee38833aa1b5edb3'
      and parameters = '{}'::jsonb and components_sealed_at is null
  ) or (select count(*) from public.ai_price_components as actual join (values
    ('input_cache_read'::text, 25000000::bigint), ('input_standard'::text, 3000000000::bigint),
    ('input_cache_write'::text, 0::bigint), ('output'::text, 6000000000::bigint)
  ) as expected(component, nanos_per_million) using (component, nanos_per_million)
  where actual.price_version_id = '22222222-2222-4222-8222-222222222222'::uuid) <> 4
     or (select count(*) from public.ai_price_components where price_version_id = '22222222-2222-4222-8222-222222222222'::uuid) <> 4
     or not exists (
    select 1 from public.ai_service_runtime_contract_versions
    where runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v2'
      and sealed_at is not null and sealed_at >= created_at
  ) or (select count(*) from public.ai_service_runtime_contract_targets
         where runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v2') <> 2
     or exists (
       select 1 from public.ai_service_runtime_contract_versions
       where runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v1'
     )
     or exists (
       select 1 from public.ai_service_runtime_contract_targets
       where runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v1'
     )
     or not exists (
    select 1 from public.ai_service_runtime_contract_versions
    where runtime_contract_id = 'runtime.deepseek-v2.v1'
      and runtime_target_set_sha256 = '5b7f5f2cd9d21c3c7409f02d7b65eda03999309c0ba3939e50fb81caca2c9340'
      and sealed_at is not null
  ) or (select count(*) from public.ai_service_runtime_contract_targets
         where runtime_contract_id = 'runtime.deepseek-v2.v1') <> 1
     or not exists (
       select 1 from public.ai_service_runtime_contract_targets
       where runtime_contract_id = 'runtime.deepseek-v2.v1'
         and runtime_target_id = 'runtime-target.deepseek.official.deepseek-v4-flash.chat.v1'
         and runtime_target_sha256 = 'aa4948f6f0060a08ada1d0b831babd17c37287be02a9a8f2f9ec69c0f2bed119'
         and profile_key = 'deepseek.official.deepseek-v4-flash.chat.v1'
         and legal_manifest_id = 'deepseek-official-2026-08-23-v1'
         and manifest_sha256 = '0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b'
         and route_descriptor_id = 'route.deepseek.official.v1'
         and route_descriptor_sha256 = 'ddd46ac3d94fa9a3d4293f5f59faa52ee93a418927d13a01798f0802ccc99d79'
     ) then
    raise exception 'MiMo V2 final runtime assertion failed' using errcode = '23514';
  end if;
end;
$$;

commit;
