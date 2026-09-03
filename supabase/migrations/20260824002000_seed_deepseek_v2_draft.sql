-- Publish the reviewed DeepSeek V2 profile, current CNY price lanes, sealed
-- service-runtime identity, and G2 draft policy as dark configuration.
--
-- This owner-executed migration is intentionally DML-only. It does not seal a
-- price, promote a profile/policy, change the feature switch or routing pointer,
-- create runtime data, expose a registration primitive, or call a provider.

begin;

-- Bootstrap is permitted only when every CFG001-owned identity is absent.  A
-- row at any canonical ID/natural key means this migration may be a reapply,
-- never a repair: require the entire identity graph before any INSERT/UPDATE
-- below can change the catalog.  Projection validation remains below so an
-- identity-complete reapply still receives its existing exact diagnostics.
do $$
declare
  v_any_owned_identity boolean;
  v_count bigint;
begin
  select
    exists (
      select 1
      from public.ai_provider_profiles
      where id = '11111111-1111-4111-8111-111111111110'::uuid
         or profile_key = 'deepseek.official.deepseek-v4-flash.chat.v1'
    )
    or exists (
      select 1
      from public.ai_provider_profile_versions
      where id = '11111111-1111-4111-8111-111111111111'::uuid
         or (
           profile_id = '11111111-1111-4111-8111-111111111110'::uuid
           and version = 1
         )
    )
    or exists (
      select 1
      from public.ai_price_versions
      where id in (
        '11111111-1111-4111-8111-111111111112'::uuid,
        '11111111-1111-4111-8111-111111111113'::uuid
      ) or (
        profile_version_id = '11111111-1111-4111-8111-111111111111'::uuid
        and pricing_lane in ('offpeak', 'peak')
        and version = 1
      )
    )
    or exists (
      select 1
      from public.ai_price_components
      where price_version_id in (
        '11111111-1111-4111-8111-111111111112'::uuid,
        '11111111-1111-4111-8111-111111111113'::uuid
      )
    )
    or exists (
      select 1
      from public.ai_service_runtime_target_versions
      where runtime_target_id =
        'runtime-target.deepseek.official.deepseek-v4-flash.chat.v1'
    )
    or exists (
      select 1
      from public.ai_service_runtime_contract_versions
      where runtime_contract_id = 'runtime.deepseek-v2.v1'
    )
    or exists (
      select 1
      from public.ai_service_runtime_contract_targets
      where runtime_contract_id = 'runtime.deepseek-v2.v1'
    )
    or exists (
      select 1
      from public.ai_routing_policy_versions
      where id = '33333333-3333-4333-8333-333333333332'::uuid
         or (policy_key = 'polish.deepseek-only.g2.v1' and version = 1)
    ) into v_any_owned_identity;

  if not v_any_owned_identity then
    return;
  end if;

  select count(*) into v_count
  from public.ai_provider_profiles
  where id = '11111111-1111-4111-8111-111111111110'::uuid
     or profile_key = 'deepseek.official.deepseek-v4-flash.chat.v1';

  if v_count <> 1 or not exists (
    select 1
    from public.ai_provider_profiles
    where id = '11111111-1111-4111-8111-111111111110'::uuid
      and profile_key = 'deepseek.official.deepseek-v4-flash.chat.v1'
  ) then
    raise exception 'DeepSeek V2 profile identity mismatch'
      using errcode = '23514';
  end if;

  select count(*) into v_count
  from public.ai_provider_profile_versions
  where id = '11111111-1111-4111-8111-111111111111'::uuid
     or (
       profile_id = '11111111-1111-4111-8111-111111111110'::uuid
       and version = 1
     );

  if v_count <> 1 or not exists (
    select 1
    from public.ai_provider_profile_versions
    where id = '11111111-1111-4111-8111-111111111111'::uuid
      and profile_id = '11111111-1111-4111-8111-111111111110'::uuid
      and version = 1
  ) then
    raise exception 'DeepSeek V2 profile version mismatch'
      using errcode = '23514';
  end if;

  select count(*) into v_count
  from public.ai_price_versions
  where id in (
    '11111111-1111-4111-8111-111111111112'::uuid,
    '11111111-1111-4111-8111-111111111113'::uuid
  ) or (
    profile_version_id = '11111111-1111-4111-8111-111111111111'::uuid
    and pricing_lane in ('offpeak', 'peak')
    and version = 1
  );

  if v_count <> 2 or (
    select count(*)
    from public.ai_price_versions
    where (id, pricing_lane) in (
      ('11111111-1111-4111-8111-111111111112'::uuid, 'offpeak'::text),
      ('11111111-1111-4111-8111-111111111113'::uuid, 'peak'::text)
    )
      and profile_version_id = '11111111-1111-4111-8111-111111111111'::uuid
      and version = 1
  ) <> 2 then
    raise exception 'DeepSeek V2 price version mismatch'
      using errcode = '23514';
  end if;

  select count(*) into v_count
  from public.ai_service_runtime_target_versions
  where runtime_target_id =
    'runtime-target.deepseek.official.deepseek-v4-flash.chat.v1';

  if v_count <> 1 then
    raise exception 'DeepSeek V2 runtime target mismatch'
      using errcode = '23514';
  end if;

  select count(*) into v_count
  from public.ai_service_runtime_contract_versions
  where runtime_contract_id = 'runtime.deepseek-v2.v1';

  if v_count <> 1 then
    raise exception 'DeepSeek V2 runtime contract mismatch'
      using errcode = '23514';
  end if;

  select count(*) into v_count
  from public.ai_service_runtime_contract_targets
  where runtime_contract_id = 'runtime.deepseek-v2.v1';

  if v_count <> 1 or not exists (
    select 1
    from public.ai_service_runtime_contract_targets
    where runtime_contract_id = 'runtime.deepseek-v2.v1'
      and runtime_target_id =
        'runtime-target.deepseek.official.deepseek-v4-flash.chat.v1'
  ) then
    raise exception 'DeepSeek V2 runtime membership mismatch'
      using errcode = '23514';
  end if;

  select count(*) into v_count
  from public.ai_routing_policy_versions
  where id = '33333333-3333-4333-8333-333333333332'::uuid
     or (policy_key = 'polish.deepseek-only.g2.v1' and version = 1);

  if v_count <> 1 or not exists (
    select 1
    from public.ai_routing_policy_versions
    where id = '33333333-3333-4333-8333-333333333332'::uuid
      and policy_key = 'polish.deepseek-only.g2.v1'
      and version = 1
  ) then
    raise exception 'DeepSeek G2 draft routing policy mismatch'
      using errcode = '23514';
  end if;
end;
$$;

-- A fresh database has no DeepSeek price identities, so the canonical six
-- components may be bootstrapped below.  Once either canonical price identity
-- exists, however, a partial/substituted/extended component set is evidence of
-- a corrupted prior seed and must fail before this migration repairs anything.
-- Reapplication is therefore exact-or-fail rather than a partial upsert.
do $$
declare
  v_existing_price_count bigint;
  v_component_count bigint;
  v_exact_component_count bigint;
begin
  select count(*) into v_existing_price_count
  from public.ai_price_versions
  where id in (
    '11111111-1111-4111-8111-111111111112'::uuid,
    '11111111-1111-4111-8111-111111111113'::uuid
  ) or (
    profile_version_id = '11111111-1111-4111-8111-111111111111'::uuid
    and pricing_lane in ('offpeak', 'peak')
    and version = 1
  );

  if v_existing_price_count > 0 then
    select count(*) into v_component_count
    from public.ai_price_components
    where price_version_id in (
      '11111111-1111-4111-8111-111111111112'::uuid,
      '11111111-1111-4111-8111-111111111113'::uuid
    );

    select count(*) into v_exact_component_count
    from public.ai_price_components as actual
    join (
      values
        ('11111111-1111-4111-8111-111111111112'::uuid, 'input_cache_read'::text, 50000000::bigint),
        ('11111111-1111-4111-8111-111111111112'::uuid, 'input_standard'::text, 1500000000::bigint),
        ('11111111-1111-4111-8111-111111111112'::uuid, 'output'::text, 4500000000::bigint),
        ('11111111-1111-4111-8111-111111111113'::uuid, 'input_cache_read'::text, 100000000::bigint),
        ('11111111-1111-4111-8111-111111111113'::uuid, 'input_standard'::text, 3000000000::bigint),
        ('11111111-1111-4111-8111-111111111113'::uuid, 'output'::text, 9000000000::bigint)
    ) as expected(price_version_id, component, nanos_per_million)
      using (price_version_id, component, nanos_per_million);

    if v_component_count <> 6 or v_exact_component_count <> 6 then
      raise exception 'DeepSeek V2 price component mismatch'
        using errcode = '23514';
    end if;
  end if;
end;
$$;

-- The root may be sealed only by this bootstrap.  An existing unsealed or
-- rebound root is a partial prior seed, not an invitation to repair a
-- security boundary on reapplication.
do $$
begin
  if exists (
    select 1
    from public.ai_service_runtime_contract_versions
    where runtime_contract_id = 'runtime.deepseek-v2.v1'
  ) and not exists (
    select 1
    from public.ai_service_runtime_contract_versions
    where runtime_contract_id = 'runtime.deepseek-v2.v1'
      and legal_bundle_version = '2026-08-23-multi-provider-v1'
      and bundle_contract_sha256 =
        'fc26d1e1a016fda055fbe6a0b79b48d804fd7610e03bd5aa29389be37359ca18'
      and runtime_target_set_sha256 =
        '5b7f5f2cd9d21c3c7409f02d7b65eda03999309c0ba3939e50fb81caca2c9340'
      and sealed_at is not null
      and sealed_at >= created_at
  ) then
    raise exception 'DeepSeek V2 runtime contract mismatch'
      using errcode = '23514';
  end if;
end;
$$;

insert into public.ai_provider_profiles (
  id,
  profile_key,
  display_name,
  gateway_kind,
  model_vendor
)
select
  '11111111-1111-4111-8111-111111111110'::uuid,
  'deepseek.official.deepseek-v4-flash.chat.v1',
  'DeepSeek V4 Flash',
  'direct_deepseek',
  'deepseek'
where not exists (
  select 1
  from public.ai_provider_profiles
  where id = '11111111-1111-4111-8111-111111111110'::uuid
);

insert into public.ai_provider_profile_versions (
  id,
  profile_id,
  version,
  status,
  adapter_kind,
  wire_api_kind,
  credential_alias,
  endpoint_alias,
  model_id,
  model_snapshot,
  upstream_route,
  capability_contract_id,
  cache_policy_id,
  legal_manifest_id,
  display_disclosure_key,
  config,
  config_sha256
)
select
  '11111111-1111-4111-8111-111111111111'::uuid,
  '11111111-1111-4111-8111-111111111110'::uuid,
  1,
  'draft',
  'deepseek_chat_v1',
  'chat_completions_v1',
  'deepseek_api_key',
  'deepseek_official',
  'deepseek-v4-flash',
  'DeepSeek-V4-Flash-0731',
  '{}'::jsonb,
  'deepseek_chat_json_object_v1',
  'deepseek_automatic_context_cache_v1',
  'deepseek-official-2026-08-23-v1',
  'deepseek-official-v1',
  '{"thinking":"disabled","structuredOutput":"json_object","providerSubjectField":"user_id"}'::jsonb,
  'a79bbbaa5934d7f4890b2e97e13e7768f031e99625fe11446ba437feeffc8fa9'
where not exists (
  select 1
  from public.ai_provider_profile_versions
  where id = '11111111-1111-4111-8111-111111111111'::uuid
);

insert into public.ai_price_versions (
  id,
  profile_version_id,
  pricing_lane,
  version,
  currency,
  calculator_kind,
  valid_from,
  valid_to,
  provider_effective_from,
  provider_effective_to,
  source_url,
  source_checked_at,
  source_snapshot_sha256,
  parameters
)
select
  expected.id,
  '11111111-1111-4111-8111-111111111111'::uuid,
  expected.pricing_lane,
  1,
  'CNY',
  'linear_token_v1',
  '2026-08-25T06:45:15.787Z'::timestamptz,
  null,
  '2026-08-16T16:00:00Z'::timestamptz,
  null,
  'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  '2026-08-28T08:05:41.804Z'::timestamptz,
  '899affbdbc33d0be620d8dea59e86f5036c11b5410b14d060b8d2874c74f38e5',
  '{}'::jsonb
from (
  values
    ('11111111-1111-4111-8111-111111111112'::uuid, 'offpeak'::text),
    ('11111111-1111-4111-8111-111111111113'::uuid, 'peak'::text)
) as expected(id, pricing_lane)
where not exists (
  select 1
  from public.ai_price_versions as actual
  where actual.id = expected.id
);

insert into public.ai_price_components (
  price_version_id,
  component,
  nanos_per_million
)
select
  expected.price_version_id,
  expected.component,
  expected.nanos_per_million
from (
  values
    (
      '11111111-1111-4111-8111-111111111112'::uuid,
      'input_cache_read'::text,
      50000000::bigint
    ),
    (
      '11111111-1111-4111-8111-111111111112'::uuid,
      'input_standard'::text,
      1500000000::bigint
    ),
    (
      '11111111-1111-4111-8111-111111111112'::uuid,
      'output'::text,
      4500000000::bigint
    ),
    (
      '11111111-1111-4111-8111-111111111113'::uuid,
      'input_cache_read'::text,
      100000000::bigint
    ),
    (
      '11111111-1111-4111-8111-111111111113'::uuid,
      'input_standard'::text,
      3000000000::bigint
    ),
    (
      '11111111-1111-4111-8111-111111111113'::uuid,
      'output'::text,
      9000000000::bigint
    )
) as expected(price_version_id, component, nanos_per_million)
where not exists (
  select 1
  from public.ai_price_components as actual
  where actual.price_version_id = expected.price_version_id
    and actual.component = expected.component
);

-- Runtime catalogs are owner-only. Register the global target first, then the
-- unsealed root and exact membership. Reapplication skips the membership INSERT
-- before its BEFORE trigger can observe the already sealed parent.
insert into public.ai_service_runtime_target_versions (
  runtime_target_id,
  runtime_target_sha256,
  profile_key,
  legal_manifest_id,
  manifest_sha256,
  route_descriptor_id,
  route_descriptor_sha256
)
select
  'runtime-target.deepseek.official.deepseek-v4-flash.chat.v1',
  'aa4948f6f0060a08ada1d0b831babd17c37287be02a9a8f2f9ec69c0f2bed119',
  'deepseek.official.deepseek-v4-flash.chat.v1',
  'deepseek-official-2026-08-23-v1',
  '0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b',
  'route.deepseek.official.v1',
  'ddd46ac3d94fa9a3d4293f5f59faa52ee93a418927d13a01798f0802ccc99d79'
where not exists (
  select 1
  from public.ai_service_runtime_target_versions
  where runtime_target_id =
    'runtime-target.deepseek.official.deepseek-v4-flash.chat.v1'
);

insert into public.ai_service_runtime_contract_versions (
  runtime_contract_id,
  legal_bundle_version,
  bundle_contract_sha256,
  runtime_target_set_sha256
)
select
  'runtime.deepseek-v2.v1',
  '2026-08-23-multi-provider-v1',
  'fc26d1e1a016fda055fbe6a0b79b48d804fd7610e03bd5aa29389be37359ca18',
  '5b7f5f2cd9d21c3c7409f02d7b65eda03999309c0ba3939e50fb81caca2c9340'
where not exists (
  select 1
  from public.ai_service_runtime_contract_versions
  where runtime_contract_id = 'runtime.deepseek-v2.v1'
);

insert into public.ai_service_runtime_contract_targets (
  runtime_contract_id,
  runtime_target_id,
  runtime_target_sha256,
  profile_key,
  legal_manifest_id,
  manifest_sha256,
  route_descriptor_id,
  route_descriptor_sha256
)
select
  'runtime.deepseek-v2.v1',
  'runtime-target.deepseek.official.deepseek-v4-flash.chat.v1',
  'aa4948f6f0060a08ada1d0b831babd17c37287be02a9a8f2f9ec69c0f2bed119',
  'deepseek.official.deepseek-v4-flash.chat.v1',
  'deepseek-official-2026-08-23-v1',
  '0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b',
  'route.deepseek.official.v1',
  'ddd46ac3d94fa9a3d4293f5f59faa52ee93a418927d13a01798f0802ccc99d79'
where not exists (
  select 1
  from public.ai_service_runtime_contract_targets
  where runtime_contract_id = 'runtime.deepseek-v2.v1'
    and runtime_target_id =
      'runtime-target.deepseek.official.deepseek-v4-flash.chat.v1'
);

update public.ai_service_runtime_contract_versions
set sealed_at = greatest(clock_timestamp(), created_at)
where runtime_contract_id = 'runtime.deepseek-v2.v1'
  and legal_bundle_version = '2026-08-23-multi-provider-v1'
  and bundle_contract_sha256 =
    'fc26d1e1a016fda055fbe6a0b79b48d804fd7610e03bd5aa29389be37359ca18'
  and runtime_target_set_sha256 =
    '5b7f5f2cd9d21c3c7409f02d7b65eda03999309c0ba3939e50fb81caca2c9340'
  and sealed_at is null;

insert into public.ai_routing_policy_versions (
  id,
  policy_key,
  version,
  status,
  timezone,
  rules,
  default_profile_version_id,
  legal_bundle_version,
  runtime_contract_id,
  config_sha256
)
select
  '33333333-3333-4333-8333-333333333332'::uuid,
  'polish.deepseek-only.g2.v1',
  1,
  'draft',
  'Asia/Shanghai',
  '{"schemaVersion":"routing_rules_v1","defaultRoute":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111112"},"windows":[{"weekdays":[1,2,3,4,5],"startMinute":540,"endMinute":720,"route":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111113"}},{"weekdays":[1,2,3,4,5],"startMinute":840,"endMinute":1080,"route":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111113"}}]}'::jsonb,
  '11111111-1111-4111-8111-111111111111'::uuid,
  '2026-08-23-multi-provider-v1',
  'runtime.deepseek-v2.v1',
  '40c9be17c5ad25e60640adc537526d2e6bf9e38424a344967ba6e5b2ceaf9cc4'
where not exists (
  select 1
  from public.ai_routing_policy_versions
  where id = '33333333-3333-4333-8333-333333333332'::uuid
);

do $$
declare
  v_count bigint;
begin
  select count(*) into v_count
  from public.ai_provider_profiles
  where id = '11111111-1111-4111-8111-111111111110'::uuid
     or profile_key = 'deepseek.official.deepseek-v4-flash.chat.v1';

  if v_count <> 1 or not exists (
    select 1
    from public.ai_provider_profiles
    where id = '11111111-1111-4111-8111-111111111110'::uuid
      and profile_key = 'deepseek.official.deepseek-v4-flash.chat.v1'
      and display_name = 'DeepSeek V4 Flash'
      and gateway_kind = 'direct_deepseek'
      and model_vendor = 'deepseek'
      and retired_at is null
  ) then
    raise exception 'DeepSeek V2 profile identity mismatch'
      using errcode = '23514';
  end if;

  select count(*) into v_count
  from public.ai_provider_profile_versions
  where id = '11111111-1111-4111-8111-111111111111'::uuid
     or (
       profile_id = '11111111-1111-4111-8111-111111111110'::uuid
       and version = 1
     );

  if v_count <> 1 or not exists (
    select 1
    from public.ai_provider_profile_versions
    where id = '11111111-1111-4111-8111-111111111111'::uuid
      and profile_id = '11111111-1111-4111-8111-111111111110'::uuid
      and version = 1
      and status = 'draft'
      and adapter_kind = 'deepseek_chat_v1'
      and wire_api_kind = 'chat_completions_v1'
      and credential_alias = 'deepseek_api_key'
      and endpoint_alias = 'deepseek_official'
      and model_id = 'deepseek-v4-flash'
      and model_snapshot = 'DeepSeek-V4-Flash-0731'
      and upstream_route = '{}'::jsonb
      and capability_contract_id = 'deepseek_chat_json_object_v1'
      and cache_policy_id = 'deepseek_automatic_context_cache_v1'
      and legal_manifest_id = 'deepseek-official-2026-08-23-v1'
      and display_disclosure_key = 'deepseek-official-v1'
      and config =
        '{"thinking":"disabled","structuredOutput":"json_object","providerSubjectField":"user_id"}'::jsonb
      and config_sha256 =
        'a79bbbaa5934d7f4890b2e97e13e7768f031e99625fe11446ba437feeffc8fa9'
      and validated_at is null
      and activated_at is null
      and retired_at is null
  ) then
    raise exception 'DeepSeek V2 profile version mismatch'
      using errcode = '23514';
  end if;

  select count(*) into v_count
  from public.ai_price_versions
  where id in (
    '11111111-1111-4111-8111-111111111112'::uuid,
    '11111111-1111-4111-8111-111111111113'::uuid
  ) or (
    profile_version_id = '11111111-1111-4111-8111-111111111111'::uuid
    and pricing_lane in ('offpeak', 'peak')
    and version = 1
  );

  if v_count <> 2 or (
    select count(*)
    from public.ai_price_versions as actual
    join (
      values
        ('11111111-1111-4111-8111-111111111112'::uuid, 'offpeak'::text),
        ('11111111-1111-4111-8111-111111111113'::uuid, 'peak'::text)
    ) as expected(id, pricing_lane)
      on actual.id = expected.id
     and actual.pricing_lane = expected.pricing_lane
    where actual.profile_version_id =
      '11111111-1111-4111-8111-111111111111'::uuid
      and actual.version = 1
      and actual.currency = 'CNY'
      and actual.calculator_kind = 'linear_token_v1'
      and actual.valid_from = '2026-08-25T06:45:15.787Z'::timestamptz
      and actual.valid_to is null
      and actual.provider_effective_from = '2026-08-16T16:00:00Z'::timestamptz
      and actual.provider_effective_to is null
      and actual.source_url =
        'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
      and actual.source_checked_at =
        '2026-08-28T08:05:41.804Z'::timestamptz
      and actual.source_snapshot_sha256 =
        '899affbdbc33d0be620d8dea59e86f5036c11b5410b14d060b8d2874c74f38e5'
      and actual.parameters = '{}'::jsonb
      and actual.components_sealed_at is null
  ) <> 2 then
    raise exception 'DeepSeek V2 price version mismatch'
      using errcode = '23514';
  end if;

  select count(*) into v_count
  from public.ai_price_components as actual
  join (
    values
      ('11111111-1111-4111-8111-111111111112'::uuid, 'input_cache_read'::text, 50000000::bigint),
      ('11111111-1111-4111-8111-111111111112'::uuid, 'input_standard'::text, 1500000000::bigint),
      ('11111111-1111-4111-8111-111111111112'::uuid, 'output'::text, 4500000000::bigint),
      ('11111111-1111-4111-8111-111111111113'::uuid, 'input_cache_read'::text, 100000000::bigint),
      ('11111111-1111-4111-8111-111111111113'::uuid, 'input_standard'::text, 3000000000::bigint),
      ('11111111-1111-4111-8111-111111111113'::uuid, 'output'::text, 9000000000::bigint)
  ) as expected(price_version_id, component, nanos_per_million)
    using (price_version_id, component, nanos_per_million);

  if v_count <> 6 or (
    select count(*)
    from public.ai_price_components
    where price_version_id in (
      '11111111-1111-4111-8111-111111111112'::uuid,
      '11111111-1111-4111-8111-111111111113'::uuid
    )
  ) <> 6 then
    raise exception 'DeepSeek V2 price component mismatch'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.ai_service_runtime_target_versions
    where runtime_target_id =
        'runtime-target.deepseek.official.deepseek-v4-flash.chat.v1'
      and runtime_target_sha256 =
        'aa4948f6f0060a08ada1d0b831babd17c37287be02a9a8f2f9ec69c0f2bed119'
      and profile_key = 'deepseek.official.deepseek-v4-flash.chat.v1'
      and legal_manifest_id = 'deepseek-official-2026-08-23-v1'
      and manifest_sha256 =
        '0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b'
      and route_descriptor_id = 'route.deepseek.official.v1'
      and route_descriptor_sha256 =
        'ddd46ac3d94fa9a3d4293f5f59faa52ee93a418927d13a01798f0802ccc99d79'
  ) then
    raise exception 'DeepSeek V2 runtime target mismatch'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.ai_service_runtime_contract_versions
    where runtime_contract_id = 'runtime.deepseek-v2.v1'
      and legal_bundle_version = '2026-08-23-multi-provider-v1'
      and bundle_contract_sha256 =
        'fc26d1e1a016fda055fbe6a0b79b48d804fd7610e03bd5aa29389be37359ca18'
      and runtime_target_set_sha256 =
        '5b7f5f2cd9d21c3c7409f02d7b65eda03999309c0ba3939e50fb81caca2c9340'
      and sealed_at is not null
      and sealed_at >= created_at
  ) then
    raise exception 'DeepSeek V2 runtime contract mismatch'
      using errcode = '23514';
  end if;

  select count(*) into v_count
  from public.ai_service_runtime_contract_targets
  where runtime_contract_id = 'runtime.deepseek-v2.v1';

  if v_count <> 1 or not exists (
    select 1
    from public.ai_service_runtime_contract_targets
    where runtime_contract_id = 'runtime.deepseek-v2.v1'
      and runtime_target_id =
        'runtime-target.deepseek.official.deepseek-v4-flash.chat.v1'
      and runtime_target_sha256 =
        'aa4948f6f0060a08ada1d0b831babd17c37287be02a9a8f2f9ec69c0f2bed119'
      and profile_key = 'deepseek.official.deepseek-v4-flash.chat.v1'
      and legal_manifest_id = 'deepseek-official-2026-08-23-v1'
      and manifest_sha256 =
        '0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b'
      and route_descriptor_id = 'route.deepseek.official.v1'
      and route_descriptor_sha256 =
        'ddd46ac3d94fa9a3d4293f5f59faa52ee93a418927d13a01798f0802ccc99d79'
  ) then
    raise exception 'DeepSeek V2 runtime membership mismatch'
      using errcode = '23514';
  end if;

  select count(*) into v_count
  from public.ai_routing_policy_versions
  where id = '33333333-3333-4333-8333-333333333332'::uuid
     or (
       policy_key = 'polish.deepseek-only.g2.v1'
       and version = 1
     );

  if v_count <> 1 or not exists (
    select 1
    from public.ai_routing_policy_versions
    where id = '33333333-3333-4333-8333-333333333332'::uuid
      and policy_key = 'polish.deepseek-only.g2.v1'
      and version = 1
      and status = 'draft'
      and timezone = 'Asia/Shanghai'
      and rules =
        '{"schemaVersion":"routing_rules_v1","defaultRoute":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111112"},"windows":[{"weekdays":[1,2,3,4,5],"startMinute":540,"endMinute":720,"route":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111113"}},{"weekdays":[1,2,3,4,5],"startMinute":840,"endMinute":1080,"route":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111113"}}]}'::jsonb
      and default_profile_version_id =
        '11111111-1111-4111-8111-111111111111'::uuid
      and legal_bundle_version = '2026-08-23-multi-provider-v1'
      and runtime_contract_id = 'runtime.deepseek-v2.v1'
      and config_sha256 =
        '40c9be17c5ad25e60640adc537526d2e6bf9e38424a344967ba6e5b2ceaf9cc4'
      and validated_at is null
      and activated_at is null
      and retired_at is null
  ) then
    raise exception 'DeepSeek G2 draft routing policy mismatch'
      using errcode = '23514';
  end if;
end;
$$;

commit;
