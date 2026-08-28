-- CFG-003: publish two dark, immutable daily-routing policy candidates.
-- This migration intentionally does not validate, promote, seal, activate, or
-- point at either row. MiMo remains a draft profile with an unsealed price.
begin;

do $$
declare
  expected record;
  actual_count bigint;
begin
  -- Preflight every fixed ID and natural identity before either insert. A
  -- pre-existing row is permitted only if its complete authored tuple is exact.
  for expected in
    select * from (values
      ('33333333-3333-4333-8333-333333333333'::uuid, 'polish.deepseek-mimo.daily.g4.v1'::text, 1::integer, 'draft'::text, 'Asia/Shanghai'::text,
       '{"schemaVersion":"routing_rules_v1","defaultRoute":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111112"},"windows":[{"weekdays":[1,2,3,4,5,6,7],"startMinute":540,"endMinute":720,"route":{"profileVersionId":"22222222-2222-4222-8222-222222222221","priceVersionId":"22222222-2222-4222-8222-222222222222"}},{"weekdays":[1,2,3,4,5,6,7],"startMinute":840,"endMinute":1080,"route":{"profileVersionId":"22222222-2222-4222-8222-222222222221","priceVersionId":"22222222-2222-4222-8222-222222222222"}}]}'::jsonb,
       '11111111-1111-4111-8111-111111111111'::uuid, '2026-08-23-multi-provider-v1'::text, 'runtime.deepseek-v2-mimo-v2.5-pro.v2'::text, '510fb411fdbbf2de5822e8becd508d7bb5da458392162f55244a5d3ab016721c'::text, '8c64daa9d7e9165417294e2d854b6ca77a2c7ba1db0611f15f9af7a67682bbe3'::text),
      ('33333333-3333-4333-8333-333333333334'::uuid, 'polish.deepseek-only.daily.rollback.v1'::text, 1::integer, 'draft'::text, 'Asia/Shanghai'::text,
       '{"schemaVersion":"routing_rules_v1","defaultRoute":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111112"},"windows":[{"weekdays":[1,2,3,4,5,6,7],"startMinute":540,"endMinute":720,"route":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111113"}},{"weekdays":[1,2,3,4,5,6,7],"startMinute":840,"endMinute":1080,"route":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111113"}}]}'::jsonb,
       '11111111-1111-4111-8111-111111111111'::uuid, '2026-08-23-multi-provider-v1'::text, 'runtime.deepseek-v2.v1'::text, '229ee6ca2b1ff78c81fc5748f01a285ac5936c1f8f06961c6c339ca808752ca9'::text, '4bd1a83446b0b19903f9c08aece54e2418cb3f880b49b63f30cbea6c7b4e40dd'::text)
    ) as rows(id, policy_key, version, status, timezone, rules, default_profile_version_id, legal_bundle_version, runtime_contract_id, runtime_contract_sha256, config_sha256)
  loop
    select count(*) into actual_count
    from public.ai_routing_policy_versions
    where id = expected.id or (policy_key = expected.policy_key and version = expected.version);

    if actual_count > 1 or (actual_count = 1 and not exists (
      select 1 from public.ai_routing_policy_versions
      where id = expected.id and policy_key = expected.policy_key and version = expected.version
        and status = expected.status and timezone = expected.timezone and rules = expected.rules
        and default_profile_version_id = expected.default_profile_version_id
        and legal_bundle_version = expected.legal_bundle_version
        and runtime_contract_id = expected.runtime_contract_id
        and runtime_contract_sha256 = expected.runtime_contract_sha256
        and config_sha256 = expected.config_sha256
        and validated_at is null and activated_at is null and retired_at is null
    )) then
      raise exception 'CFG-003 routing policy identity collision for %', expected.policy_key using errcode = '23514';
    end if;
  end loop;
end;
$$;

-- These are read-only predecessor assertions. Darkness is intentional: no
-- `sealed_at`, profile validation, or price component seal is required here.
do $$
begin
  if not exists (
    select 1 from public.ai_legal_bundle_versions
    where legal_bundle_version = '2026-08-23-multi-provider-v1'
      and bundle_contract_sha256 = 'fc26d1e1a016fda055fbe6a0b79b48d804fd7610e03bd5aa29389be37359ca18'
      and sealed_at is not null
  ) or (select count(*) from public.ai_legal_bundle_manifests
         where legal_bundle_version = '2026-08-23-multi-provider-v1') <> 2
  or not exists (
    select 1 from public.ai_provider_profile_versions
    where id = '11111111-1111-4111-8111-111111111111'::uuid
      and status = 'draft' and adapter_kind = 'deepseek_chat_v1'
      and wire_api_kind = 'chat_completions_v1' and credential_alias = 'deepseek_api_key'
      and endpoint_alias = 'deepseek_official' and model_id = 'deepseek-v4-flash'
      and legal_manifest_id = 'deepseek-official-2026-08-23-v1'
      and config_sha256 = 'a79bbbaa5934d7f4890b2e97e13e7768f031e99625fe11446ba437feeffc8fa9'
      and validated_at is null and activated_at is null and retired_at is null
  ) or not exists (
    select 1 from public.ai_price_versions
    where id = '11111111-1111-4111-8111-111111111112'::uuid
      and profile_version_id = '11111111-1111-4111-8111-111111111111'::uuid
      and pricing_lane = 'offpeak' and version = 1 and currency = 'CNY'
      and calculator_kind = 'linear_token_v1' and valid_from = '2026-08-25T06:45:15.787Z'::timestamptz
      and source_url = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
      and source_checked_at = '2026-08-25T06:45:15.787Z'::timestamptz
      and source_snapshot_sha256 = '593f092cc8e91ad568f4843a83264e2f7aa2551b5c46d1e35b5e2654e3f06a02'
      and parameters = '{}'::jsonb and components_sealed_at is null
  ) or not exists (
    select 1 from public.ai_price_versions
    where id = '11111111-1111-4111-8111-111111111113'::uuid
      and profile_version_id = '11111111-1111-4111-8111-111111111111'::uuid
      and pricing_lane = 'peak' and version = 1 and currency = 'CNY'
      and calculator_kind = 'linear_token_v1' and valid_from = '2026-08-25T06:45:15.787Z'::timestamptz
      and source_url = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
      and source_checked_at = '2026-08-25T06:45:15.787Z'::timestamptz
      and source_snapshot_sha256 = '593f092cc8e91ad568f4843a83264e2f7aa2551b5c46d1e35b5e2654e3f06a02'
      and parameters = '{}'::jsonb and components_sealed_at is null
  ) or not exists (
    select 1 from public.ai_provider_profile_versions
    where id = '22222222-2222-4222-8222-222222222221'::uuid
      and status = 'draft' and adapter_kind = 'mimo_responses_v1' and wire_api_kind = 'responses_v1'
      and credential_alias = 'mimo_api_key' and endpoint_alias = 'mimo_cn_official'
      and model_id = 'mimo-v2.5-pro' and legal_manifest_id = 'mimo-cn-2026-08-23-v1'
      and config_sha256 = '319316de510f767885fdb94d75d067a7383c11f513b908026a2ab4ec68c8a121'
      and validated_at is null and activated_at is null and retired_at is null
  ) or not exists (
    select 1 from public.ai_price_versions
    where id = '22222222-2222-4222-8222-222222222222'::uuid
      and profile_version_id = '22222222-2222-4222-8222-222222222221'::uuid
      and pricing_lane = 'default' and version = 1 and currency = 'CNY'
      and calculator_kind = 'linear_token_v1' and valid_from = '2026-08-25T16:26:26.127Z'::timestamptz
      and source_url = 'https://mimo.mi.com/docs/en-US/price/pay-as-you-go'
      and source_checked_at = '2026-08-25T16:26:26.127Z'::timestamptz
      and source_snapshot_sha256 = '2b9aec6fe83c358db3697965ae4dbdaffbf976fbb48576bff55f2d9c2eb5f065'
      and parameters = '{}'::jsonb and components_sealed_at is null
  ) or not exists (
    select 1 from public.ai_service_runtime_contract_versions
    where runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v2'
      and runtime_contract_sha256 = '510fb411fdbbf2de5822e8becd508d7bb5da458392162f55244a5d3ab016721c'
      and legal_bundle_version = '2026-08-23-multi-provider-v1'
      and sealed_at is not null
  ) or (select count(*) from public.ai_service_runtime_contract_targets
         where runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v2'
           and runtime_contract_sha256 = '510fb411fdbbf2de5822e8becd508d7bb5da458392162f55244a5d3ab016721c') <> 2
  or not exists (
    select 1 from public.ai_service_runtime_contract_targets
    where runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v2'
      and runtime_contract_sha256 = '510fb411fdbbf2de5822e8becd508d7bb5da458392162f55244a5d3ab016721c'
      and runtime_target_id = 'runtime-target.mimo.cn.mimo-v2.5-pro.responses.v1'
      and profile_key = 'mimo.cn.mimo-v2.5-pro.responses.v1'
  ) or not exists (
    select 1 from public.ai_service_runtime_contract_targets
    where runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v2'
      and runtime_contract_sha256 = '510fb411fdbbf2de5822e8becd508d7bb5da458392162f55244a5d3ab016721c'
      and runtime_target_id = 'runtime-target.deepseek.official.deepseek-v4-flash.chat.v1'
      and profile_key = 'deepseek.official.deepseek-v4-flash.chat.v1'
  ) or not exists (
    select 1 from public.ai_service_runtime_contract_versions
    where runtime_contract_id = 'runtime.deepseek-v2.v1'
      and runtime_contract_sha256 = '229ee6ca2b1ff78c81fc5748f01a285ac5936c1f8f06961c6c339ca808752ca9'
      and legal_bundle_version = '2026-08-23-multi-provider-v1'
      and sealed_at is not null
  ) or (select count(*) from public.ai_service_runtime_contract_targets
         where runtime_contract_id = 'runtime.deepseek-v2.v1'
           and runtime_contract_sha256 = '229ee6ca2b1ff78c81fc5748f01a285ac5936c1f8f06961c6c339ca808752ca9') <> 1
  or not exists (
    select 1 from public.ai_service_runtime_contract_targets
    where runtime_contract_id = 'runtime.deepseek-v2.v1'
      and runtime_contract_sha256 = '229ee6ca2b1ff78c81fc5748f01a285ac5936c1f8f06961c6c339ca808752ca9'
      and runtime_target_id = 'runtime-target.deepseek.official.deepseek-v4-flash.chat.v1'
      and profile_key = 'deepseek.official.deepseek-v4-flash.chat.v1'
  ) then
    raise exception 'CFG-003 predecessor identity or intentional dark state mismatch' using errcode = '23514';
  end if;
end;
$$;

insert into public.ai_routing_policy_versions (
  id, policy_key, version, status, timezone, rules, default_profile_version_id,
  legal_bundle_version, runtime_contract_id, runtime_contract_sha256, config_sha256
)
select * from (values
  ('33333333-3333-4333-8333-333333333333'::uuid, 'polish.deepseek-mimo.daily.g4.v1'::text, 1::integer, 'draft'::text, 'Asia/Shanghai'::text,
   '{"schemaVersion":"routing_rules_v1","defaultRoute":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111112"},"windows":[{"weekdays":[1,2,3,4,5,6,7],"startMinute":540,"endMinute":720,"route":{"profileVersionId":"22222222-2222-4222-8222-222222222221","priceVersionId":"22222222-2222-4222-8222-222222222222"}},{"weekdays":[1,2,3,4,5,6,7],"startMinute":840,"endMinute":1080,"route":{"profileVersionId":"22222222-2222-4222-8222-222222222221","priceVersionId":"22222222-2222-4222-8222-222222222222"}}]}'::jsonb,
   '11111111-1111-4111-8111-111111111111'::uuid, '2026-08-23-multi-provider-v1'::text, 'runtime.deepseek-v2-mimo-v2.5-pro.v2'::text, '510fb411fdbbf2de5822e8becd508d7bb5da458392162f55244a5d3ab016721c'::text, '8c64daa9d7e9165417294e2d854b6ca77a2c7ba1db0611f15f9af7a67682bbe3'::text),
  ('33333333-3333-4333-8333-333333333334'::uuid, 'polish.deepseek-only.daily.rollback.v1'::text, 1::integer, 'draft'::text, 'Asia/Shanghai'::text,
   '{"schemaVersion":"routing_rules_v1","defaultRoute":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111112"},"windows":[{"weekdays":[1,2,3,4,5,6,7],"startMinute":540,"endMinute":720,"route":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111113"}},{"weekdays":[1,2,3,4,5,6,7],"startMinute":840,"endMinute":1080,"route":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111113"}}]}'::jsonb,
   '11111111-1111-4111-8111-111111111111'::uuid, '2026-08-23-multi-provider-v1'::text, 'runtime.deepseek-v2.v1'::text, '229ee6ca2b1ff78c81fc5748f01a285ac5936c1f8f06961c6c339ca808752ca9'::text, '4bd1a83446b0b19903f9c08aece54e2418cb3f880b49b63f30cbea6c7b4e40dd'::text)
) as expected(id, policy_key, version, status, timezone, rules, default_profile_version_id, legal_bundle_version, runtime_contract_id, runtime_contract_sha256, config_sha256)
where not exists (select 1 from public.ai_routing_policy_versions as actual where actual.id = expected.id);

do $$
declare
  expected record;
  actual_count bigint;
begin
  for expected in
    select * from (values
      ('33333333-3333-4333-8333-333333333333'::uuid, 'polish.deepseek-mimo.daily.g4.v1'::text, 1::integer, '8c64daa9d7e9165417294e2d854b6ca77a2c7ba1db0611f15f9af7a67682bbe3'::text),
      ('33333333-3333-4333-8333-333333333334'::uuid, 'polish.deepseek-only.daily.rollback.v1'::text, 1::integer, '4bd1a83446b0b19903f9c08aece54e2418cb3f880b49b63f30cbea6c7b4e40dd'::text)
    ) as rows(id, policy_key, version, config_sha256)
  loop
    select count(*) into actual_count from public.ai_routing_policy_versions
    where id = expected.id or (policy_key = expected.policy_key and version = expected.version);
    if actual_count <> 1 or not exists (
      select 1 from public.ai_routing_policy_versions
      where id = expected.id and policy_key = expected.policy_key and version = expected.version
        and status = 'draft' and timezone = 'Asia/Shanghai'
        and default_profile_version_id = '11111111-1111-4111-8111-111111111111'::uuid
        and legal_bundle_version = '2026-08-23-multi-provider-v1'
        and config_sha256 = expected.config_sha256
        and validated_at is null and activated_at is null and retired_at is null
        and (
          (expected.policy_key = 'polish.deepseek-mimo.daily.g4.v1'
           and runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v2'
           and runtime_contract_sha256 = '510fb411fdbbf2de5822e8becd508d7bb5da458392162f55244a5d3ab016721c'
           and rules = '{"schemaVersion":"routing_rules_v1","defaultRoute":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111112"},"windows":[{"weekdays":[1,2,3,4,5,6,7],"startMinute":540,"endMinute":720,"route":{"profileVersionId":"22222222-2222-4222-8222-222222222221","priceVersionId":"22222222-2222-4222-8222-222222222222"}},{"weekdays":[1,2,3,4,5,6,7],"startMinute":840,"endMinute":1080,"route":{"profileVersionId":"22222222-2222-4222-8222-222222222221","priceVersionId":"22222222-2222-4222-8222-222222222222"}}]}'::jsonb)
          or (expected.policy_key = 'polish.deepseek-only.daily.rollback.v1'
           and runtime_contract_id = 'runtime.deepseek-v2.v1'
           and runtime_contract_sha256 = '229ee6ca2b1ff78c81fc5748f01a285ac5936c1f8f06961c6c339ca808752ca9'
           and rules = '{"schemaVersion":"routing_rules_v1","defaultRoute":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111112"},"windows":[{"weekdays":[1,2,3,4,5,6,7],"startMinute":540,"endMinute":720,"route":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111113"}},{"weekdays":[1,2,3,4,5,6,7],"startMinute":840,"endMinute":1080,"route":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111113"}}]}'::jsonb)
        )
    ) then
      raise exception 'CFG-003 routing policy postcondition mismatch for %', expected.policy_key using errcode = '23514';
    end if;
  end loop;
end;
$$;

commit;
