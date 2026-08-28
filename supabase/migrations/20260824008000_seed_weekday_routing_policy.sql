-- CFG-003 successor: preserve 07000's daily drafts as historical and publish
-- new weekday-only drafts. This migration never selects either historical row.
begin;

do $$
declare
  expected record;
  actual_count bigint;
  old_count bigint;
  new_count bigint;
begin
  -- 07000 is an immutable predecessor. Its two daily rows must remain exact,
  -- dark historical drafts; they are forbidden as a selected pointer target.
  select count(*) into old_count from public.ai_routing_policy_versions
  where id in (
    '33333333-3333-4333-8333-333333333333'::uuid,
    '33333333-3333-4333-8333-333333333334'::uuid
  ) or (policy_key, version) in (
    ('polish.deepseek-mimo.daily.g4.v1'::text, 1::integer),
    ('polish.deepseek-only.daily.rollback.v1'::text, 1::integer)
  );
  if old_count <> 2 then
    raise exception 'CFG-003 weekday predecessor daily group is missing, partial, or colliding' using errcode = '23514';
  end if;

  for expected in
    select * from (values
      ('33333333-3333-4333-8333-333333333333'::uuid, 'polish.deepseek-mimo.daily.g4.v1'::text, 1::integer, 'draft'::text, 'Asia/Shanghai'::text,
       '{"schemaVersion":"routing_rules_v1","defaultRoute":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111112"},"windows":[{"weekdays":[1,2,3,4,5,6,7],"startMinute":540,"endMinute":720,"route":{"profileVersionId":"22222222-2222-4222-8222-222222222221","priceVersionId":"22222222-2222-4222-8222-222222222222"}},{"weekdays":[1,2,3,4,5,6,7],"startMinute":840,"endMinute":1080,"route":{"profileVersionId":"22222222-2222-4222-8222-222222222221","priceVersionId":"22222222-2222-4222-8222-222222222222"}}]}'::jsonb,
       '11111111-1111-4111-8111-111111111111'::uuid, '2026-08-23-multi-provider-v1'::text, 'runtime.deepseek-v2-mimo-v2.5-pro.v2'::text, '510fb411fdbbf2de5822e8becd508d7bb5da458392162f55244a5d3ab016721c'::text, '8c64daa9d7e9165417294e2d854b6ca77a2c7ba1db0611f15f9af7a67682bbe3'::text),
      ('33333333-3333-4333-8333-333333333334'::uuid, 'polish.deepseek-only.daily.rollback.v1'::text, 1::integer, 'draft'::text, 'Asia/Shanghai'::text,
       '{"schemaVersion":"routing_rules_v1","defaultRoute":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111112"},"windows":[{"weekdays":[1,2,3,4,5,6,7],"startMinute":540,"endMinute":720,"route":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111113"}},{"weekdays":[1,2,3,4,5,6,7],"startMinute":840,"endMinute":1080,"route":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111113"}}]}'::jsonb,
       '11111111-1111-4111-8111-111111111111'::uuid, '2026-08-23-multi-provider-v1'::text, 'runtime.deepseek-v2.v1'::text, '229ee6ca2b1ff78c81fc5748f01a285ac5936c1f8f06961c6c339ca808752ca9'::text, '4bd1a83446b0b19903f9c08aece54e2418cb3f880b49b63f30cbea6c7b4e40dd'::text),
      ('33333333-3333-4333-8333-333333333335'::uuid, 'polish.deepseek-mimo.weekday.g4.v1'::text, 1::integer, 'draft'::text, 'Asia/Shanghai'::text,
       '{"schemaVersion":"routing_rules_v1","defaultRoute":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111112"},"windows":[{"weekdays":[1,2,3,4,5],"startMinute":540,"endMinute":720,"route":{"profileVersionId":"22222222-2222-4222-8222-222222222221","priceVersionId":"22222222-2222-4222-8222-222222222222"}},{"weekdays":[1,2,3,4,5],"startMinute":840,"endMinute":1080,"route":{"profileVersionId":"22222222-2222-4222-8222-222222222221","priceVersionId":"22222222-2222-4222-8222-222222222222"}}]}'::jsonb,
       '11111111-1111-4111-8111-111111111111'::uuid, '2026-08-23-multi-provider-v1'::text, 'runtime.deepseek-v2-mimo-v2.5-pro.v2'::text, '510fb411fdbbf2de5822e8becd508d7bb5da458392162f55244a5d3ab016721c'::text, '7580342cc3c61695d1c57e8c57b320acb3e54a471f4e848b0632afd1191c0567'::text),
      ('33333333-3333-4333-8333-333333333336'::uuid, 'polish.deepseek-only.weekday.rollback.v1'::text, 1::integer, 'draft'::text, 'Asia/Shanghai'::text,
       '{"schemaVersion":"routing_rules_v1","defaultRoute":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111112"},"windows":[{"weekdays":[1,2,3,4,5],"startMinute":540,"endMinute":720,"route":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111113"}},{"weekdays":[1,2,3,4,5],"startMinute":840,"endMinute":1080,"route":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111113"}}]}'::jsonb,
       '11111111-1111-4111-8111-111111111111'::uuid, '2026-08-23-multi-provider-v1'::text, 'runtime.deepseek-v2.v1'::text, '229ee6ca2b1ff78c81fc5748f01a285ac5936c1f8f06961c6c339ca808752ca9'::text, 'c98c1aa90df26e1392ae0258c99d284e273d4e519c13356fcfd4a7d7fe67b418'::text)
    ) as rows(id, policy_key, version, status, timezone, rules, default_profile_version_id, legal_bundle_version, runtime_contract_id, runtime_contract_sha256, config_sha256)
  loop
    select count(*) into actual_count from public.ai_routing_policy_versions
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
      raise exception 'CFG-003 weekday routing policy identity collision for %', expected.policy_key using errcode = '23514';
    end if;
  end loop;

  select count(*) into new_count from public.ai_routing_policy_versions
  where id in (
    '33333333-3333-4333-8333-333333333335'::uuid,
    '33333333-3333-4333-8333-333333333336'::uuid
  ) or (policy_key, version) in (
    ('polish.deepseek-mimo.weekday.g4.v1'::text, 1::integer),
    ('polish.deepseek-only.weekday.rollback.v1'::text, 1::integer)
  );
  if new_count not in (0, 2) then
    raise exception 'CFG-003 weekday routing policy group is partially present' using errcode = '23514';
  end if;

  if exists (select 1 from public.ai_feature_config where active_routing_policy_version_id in (
      '33333333-3333-4333-8333-333333333333'::uuid,
      '33333333-3333-4333-8333-333333333334'::uuid
    ))
    or not exists (select 1 from public.ai_legal_bundle_versions where legal_bundle_version = '2026-08-23-multi-provider-v1' and bundle_contract_sha256 = 'fc26d1e1a016fda055fbe6a0b79b48d804fd7610e03bd5aa29389be37359ca18' and sealed_at is not null)
    or (select count(*) from public.ai_legal_bundle_manifests where legal_bundle_version = '2026-08-23-multi-provider-v1') <> 2
    or not exists (select 1 from public.ai_legal_bundle_manifests where legal_bundle_version = '2026-08-23-multi-provider-v1' and legal_manifest_id = 'deepseek-official-2026-08-23-v1' and manifest_sha256 = '0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b')
    or not exists (select 1 from public.ai_legal_bundle_manifests where legal_bundle_version = '2026-08-23-multi-provider-v1' and legal_manifest_id = 'mimo-cn-2026-08-23-v1' and manifest_sha256 = 'f075f1e39e74a96ef2b536df8ba1e19c0840ce6d3be47d6deccd9c95da861c3f')
    or not exists (select 1 from public.ai_provider_profiles where id = '11111111-1111-4111-8111-111111111110'::uuid and profile_key = 'deepseek.official.deepseek-v4-flash.chat.v1' and display_name = 'DeepSeek V4 Flash' and gateway_kind = 'direct_deepseek' and model_vendor = 'deepseek' and retired_at is null)
    or not exists (select 1 from public.ai_provider_profile_versions where id = '11111111-1111-4111-8111-111111111111'::uuid and status = 'draft' and adapter_kind = 'deepseek_chat_v1' and endpoint_alias = 'deepseek_official' and model_id = 'deepseek-v4-flash' and validated_at is null and activated_at is null and retired_at is null)
    or not exists (select 1 from public.ai_provider_profile_versions where id = '22222222-2222-4222-8222-222222222221'::uuid and status = 'draft' and adapter_kind = 'mimo_responses_v1' and endpoint_alias = 'mimo_cn_official' and model_id = 'mimo-v2.5-pro' and validated_at is null and activated_at is null and retired_at is null)
    or (select count(*) from public.ai_price_versions where id in ('11111111-1111-4111-8111-111111111112'::uuid, '11111111-1111-4111-8111-111111111113'::uuid, '22222222-2222-4222-8222-222222222222'::uuid) and components_sealed_at is null) <> 3
    or (select count(*) from public.ai_price_components as actual join (values
          ('input_cache_read'::text, 50000000::bigint), ('input_standard'::text, 1500000000::bigint), ('output'::text, 4500000000::bigint)
        ) as expected(component, nanos_per_million) using (component, nanos_per_million)
        where actual.price_version_id = '11111111-1111-4111-8111-111111111112'::uuid) <> 3
    or (select count(*) from public.ai_price_components where price_version_id = '11111111-1111-4111-8111-111111111112'::uuid) <> 3
    or (select count(*) from public.ai_price_components as actual join (values
          ('input_cache_read'::text, 100000000::bigint), ('input_standard'::text, 3000000000::bigint), ('output'::text, 9000000000::bigint)
        ) as expected(component, nanos_per_million) using (component, nanos_per_million)
        where actual.price_version_id = '11111111-1111-4111-8111-111111111113'::uuid) <> 3
    or (select count(*) from public.ai_price_components where price_version_id = '11111111-1111-4111-8111-111111111113'::uuid) <> 3
    or (select count(*) from public.ai_price_components as actual join (values
          ('input_cache_read'::text, 25000000::bigint), ('input_standard'::text, 3000000000::bigint), ('input_cache_write'::text, 0::bigint), ('output'::text, 6000000000::bigint)
        ) as expected(component, nanos_per_million) using (component, nanos_per_million)
        where actual.price_version_id = '22222222-2222-4222-8222-222222222222'::uuid) <> 4
    or (select count(*) from public.ai_price_components where price_version_id = '22222222-2222-4222-8222-222222222222'::uuid) <> 4
    or not exists (select 1 from public.ai_service_runtime_contract_versions where runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v2' and runtime_contract_sha256 = '510fb411fdbbf2de5822e8becd508d7bb5da458392162f55244a5d3ab016721c' and legal_bundle_version = '2026-08-23-multi-provider-v1' and sealed_at is not null)
    or not exists (select 1 from public.ai_service_runtime_contract_targets where runtime_contract_id = 'runtime.deepseek-v2-mimo-v2.5-pro.v2' and runtime_contract_sha256 = '510fb411fdbbf2de5822e8becd508d7bb5da458392162f55244a5d3ab016721c' and runtime_target_id = 'runtime-target.mimo.cn.mimo-v2.5-pro.responses.v1' and profile_key = 'mimo.cn.mimo-v2.5-pro.responses.v1' and legal_manifest_id = 'mimo-cn-2026-08-23-v1')
    or not exists (select 1 from public.ai_service_runtime_contract_versions where runtime_contract_id = 'runtime.deepseek-v2.v1' and runtime_contract_sha256 = '229ee6ca2b1ff78c81fc5748f01a285ac5936c1f8f06961c6c339ca808752ca9' and legal_bundle_version = '2026-08-23-multi-provider-v1' and sealed_at is not null)
  then
    raise exception 'CFG-003 weekday predecessor identity, darkness, or forbidden daily selection mismatch' using errcode = '23514';
  end if;
end;
$$;

insert into public.ai_routing_policy_versions (
  id, policy_key, version, status, timezone, rules, default_profile_version_id,
  legal_bundle_version, runtime_contract_id, runtime_contract_sha256, config_sha256
)
select * from (values
  ('33333333-3333-4333-8333-333333333335'::uuid, 'polish.deepseek-mimo.weekday.g4.v1'::text, 1::integer, 'draft'::text, 'Asia/Shanghai'::text,
   '{"schemaVersion":"routing_rules_v1","defaultRoute":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111112"},"windows":[{"weekdays":[1,2,3,4,5],"startMinute":540,"endMinute":720,"route":{"profileVersionId":"22222222-2222-4222-8222-222222222221","priceVersionId":"22222222-2222-4222-8222-222222222222"}},{"weekdays":[1,2,3,4,5],"startMinute":840,"endMinute":1080,"route":{"profileVersionId":"22222222-2222-4222-8222-222222222221","priceVersionId":"22222222-2222-4222-8222-222222222222"}}]}'::jsonb,
   '11111111-1111-4111-8111-111111111111'::uuid, '2026-08-23-multi-provider-v1'::text, 'runtime.deepseek-v2-mimo-v2.5-pro.v2'::text, '510fb411fdbbf2de5822e8becd508d7bb5da458392162f55244a5d3ab016721c'::text, '7580342cc3c61695d1c57e8c57b320acb3e54a471f4e848b0632afd1191c0567'::text),
  ('33333333-3333-4333-8333-333333333336'::uuid, 'polish.deepseek-only.weekday.rollback.v1'::text, 1::integer, 'draft'::text, 'Asia/Shanghai'::text,
   '{"schemaVersion":"routing_rules_v1","defaultRoute":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111112"},"windows":[{"weekdays":[1,2,3,4,5],"startMinute":540,"endMinute":720,"route":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111113"}},{"weekdays":[1,2,3,4,5],"startMinute":840,"endMinute":1080,"route":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111113"}}]}'::jsonb,
   '11111111-1111-4111-8111-111111111111'::uuid, '2026-08-23-multi-provider-v1'::text, 'runtime.deepseek-v2.v1'::text, '229ee6ca2b1ff78c81fc5748f01a285ac5936c1f8f06961c6c339ca808752ca9'::text, 'c98c1aa90df26e1392ae0258c99d284e273d4e519c13356fcfd4a7d7fe67b418'::text)
) as expected(id, policy_key, version, status, timezone, rules, default_profile_version_id, legal_bundle_version, runtime_contract_id, runtime_contract_sha256, config_sha256)
where not exists (select 1 from public.ai_routing_policy_versions as actual where actual.id = expected.id);

do $$
begin
  if (select count(*) from public.ai_routing_policy_versions where id in (
        '33333333-3333-4333-8333-333333333335'::uuid,
        '33333333-3333-4333-8333-333333333336'::uuid
      )) <> 2
    or (select count(*) from public.ai_routing_policy_versions where (policy_key, version) in (
        ('polish.deepseek-mimo.weekday.g4.v1'::text, 1::integer),
        ('polish.deepseek-only.weekday.rollback.v1'::text, 1::integer)
      )) <> 2
    or exists (select 1 from public.ai_routing_policy_versions where id in (
        '33333333-3333-4333-8333-333333333335'::uuid,
        '33333333-3333-4333-8333-333333333336'::uuid
      ) and (status <> 'draft' or validated_at is not null or activated_at is not null or retired_at is not null))
    or not exists (select 1 from public.ai_routing_policy_versions where
        id = '33333333-3333-4333-8333-333333333335'::uuid
        and policy_key = 'polish.deepseek-mimo.weekday.g4.v1' and version = 1
        and config_sha256 = '7580342cc3c61695d1c57e8c57b320acb3e54a471f4e848b0632afd1191c0567'
        and rules = '{"schemaVersion":"routing_rules_v1","defaultRoute":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111112"},"windows":[{"weekdays":[1,2,3,4,5],"startMinute":540,"endMinute":720,"route":{"profileVersionId":"22222222-2222-4222-8222-222222222221","priceVersionId":"22222222-2222-4222-8222-222222222222"}},{"weekdays":[1,2,3,4,5],"startMinute":840,"endMinute":1080,"route":{"profileVersionId":"22222222-2222-4222-8222-222222222221","priceVersionId":"22222222-2222-4222-8222-222222222222"}}]}'::jsonb)
    or not exists (select 1 from public.ai_routing_policy_versions where
        id = '33333333-3333-4333-8333-333333333336'::uuid
        and policy_key = 'polish.deepseek-only.weekday.rollback.v1' and version = 1
        and config_sha256 = 'c98c1aa90df26e1392ae0258c99d284e273d4e519c13356fcfd4a7d7fe67b418'
        and rules = '{"schemaVersion":"routing_rules_v1","defaultRoute":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111112"},"windows":[{"weekdays":[1,2,3,4,5],"startMinute":540,"endMinute":720,"route":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111113"}},{"weekdays":[1,2,3,4,5],"startMinute":840,"endMinute":1080,"route":{"profileVersionId":"11111111-1111-4111-8111-111111111111","priceVersionId":"11111111-1111-4111-8111-111111111113"}}]}'::jsonb)
  then
    raise exception 'CFG-003 weekday routing policy postcondition mismatch' using errcode = '23514';
  end if;
end;
$$;

commit;
