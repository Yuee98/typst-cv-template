-- Publish the reviewed initial DeepSeek/MiMo legal bundle.
--
-- This owner-executed migration copies the LEGAL-002A reviewed roots. It does
-- not derive descriptor hashes, expose an authoring API, or activate routing.

begin;

insert into public.ai_legal_manifest_versions (
  legal_manifest_id,
  manifest_sha256
)
values
  (
    'deepseek-official-2026-08-23-v1',
    '0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b'
  ),
  (
    'mimo-cn-2026-08-23-v1',
    'f075f1e39e74a96ef2b536df8ba1e19c0840ce6d3be47d6deccd9c95da861c3f'
  );

insert into public.ai_legal_bundle_versions (
  legal_bundle_version,
  bundle_contract_sha256,
  manifest_set_sha256
)
values (
  '2026-08-23-multi-provider-v1',
  'fc26d1e1a016fda055fbe6a0b79b48d804fd7610e03bd5aa29389be37359ca18',
  'a6f5813b4626139233dab1429bdf2bb7b0196487c4c7530cdc2c50529943b073'
);

insert into public.ai_legal_bundle_manifests (
  legal_bundle_version,
  legal_manifest_id,
  manifest_sha256
)
values
  (
    '2026-08-23-multi-provider-v1',
    'deepseek-official-2026-08-23-v1',
    '0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b'
  ),
  (
    '2026-08-23-multi-provider-v1',
    'mimo-cn-2026-08-23-v1',
    'f075f1e39e74a96ef2b536df8ba1e19c0840ce6d3be47d6deccd9c95da861c3f'
  );

-- The existing DB-003A guard locks the authored child set, recomputes its
-- canonical C-sorted length-prefixed SHA-256, and permits this transition once.
update public.ai_legal_bundle_versions
set sealed_at = greatest(clock_timestamp(), created_at)
where legal_bundle_version = '2026-08-23-multi-provider-v1';

do $$
declare
  v_count bigint;
begin
  select count(*)
  into v_count
  from public.ai_legal_bundle_versions
  where legal_bundle_version = '2026-08-23-multi-provider-v1'
    and bundle_contract_sha256 = 'fc26d1e1a016fda055fbe6a0b79b48d804fd7610e03bd5aa29389be37359ca18'
    and manifest_set_sha256 = 'a6f5813b4626139233dab1429bdf2bb7b0196487c4c7530cdc2c50529943b073'
    and sealed_at is not null
    and sealed_at >= created_at;

  if v_count <> 1
     or (select count(*) from public.ai_legal_bundle_versions) <> 1 then
    raise exception 'initial legal bundle header publication mismatch'
      using errcode = '23514';
  end if;

  select count(*)
  into v_count
  from public.ai_legal_manifest_versions as actual
  join (
    values
      (
        'deepseek-official-2026-08-23-v1'::text,
        '0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b'::text
      ),
      (
        'mimo-cn-2026-08-23-v1'::text,
        'f075f1e39e74a96ef2b536df8ba1e19c0840ce6d3be47d6deccd9c95da861c3f'::text
      )
  ) as expected(legal_manifest_id, manifest_sha256)
    using (legal_manifest_id, manifest_sha256);

  if v_count <> 2
     or (select count(*) from public.ai_legal_manifest_versions) <> 2 then
    raise exception 'initial legal manifest catalog publication mismatch'
      using errcode = '23514';
  end if;

  select count(*)
  into v_count
  from public.ai_legal_bundle_manifests as actual
  join (
    values
      (
        'deepseek-official-2026-08-23-v1'::text,
        '0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b'::text
      ),
      (
        'mimo-cn-2026-08-23-v1'::text,
        'f075f1e39e74a96ef2b536df8ba1e19c0840ce6d3be47d6deccd9c95da861c3f'::text
      )
  ) as expected(legal_manifest_id, manifest_sha256)
    using (legal_manifest_id, manifest_sha256)
  where actual.legal_bundle_version = '2026-08-23-multi-provider-v1';

  if v_count <> 2
     or (
       select count(*)
       from public.ai_legal_bundle_manifests
       where legal_bundle_version = '2026-08-23-multi-provider-v1'
     ) <> 2
     or (select count(*) from public.ai_legal_bundle_manifests) <> 2 then
    raise exception 'initial legal bundle manifest-set publication mismatch'
      using errcode = '23514';
  end if;
end;
$$;

commit;
