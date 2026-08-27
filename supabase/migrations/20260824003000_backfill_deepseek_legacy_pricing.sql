-- DB-012: one reviewed, owner-only historical DeepSeek price and backfill.
--
-- This is deliberately neither a live route nor a policy/runtime activation.
-- It records only a cost-only historical binding for the exact bare V1 cohort.

begin;

create or replace function public.backfill_deepseek_legacy_pricing_v1()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_cutoff constant timestamptz := '2026-08-16T16:00:00Z'::timestamptz;
  c_profile_id constant uuid := '11111111-1111-4111-8111-111111111111'::uuid;
  c_price_id constant uuid := '11111111-1111-4111-8111-111111111114'::uuid;
  c_max_bigint constant numeric := 9223372036854775807::numeric;
  v_request public.ai_request_ledger%rowtype;
  v_price public.ai_price_versions%rowtype;
  v_price_count bigint;
  v_component_count bigint;
  v_exact_component_count bigint;
  v_cost numeric;
  v_input_total numeric;
  v_created_price boolean := false;
  v_complete_tokens boolean;
  v_input_aggregate_known boolean;
  v_zero_or_absent_tokens boolean;
  v_semantic_class text;
begin
  -- All DB-012 paths take the canonical price parent before request rows.
  -- A concurrent request->price writer therefore fails boundedly instead of
  -- letting a migration wait indefinitely or partially progress.
  perform pg_catalog.set_config('lock_timeout', '500ms', true);

  -- CFG-001 owns this exact draft profile identity.  DB-012 never repairs or
  -- activates it, and does not infer an equivalent profile from a model name.
  if not exists (
    select 1
    from public.ai_provider_profile_versions as profile
    where profile.id = c_profile_id
      and profile.profile_id = '11111111-1111-4111-8111-111111111110'::uuid
      and profile.version = 1
      and profile.model_id = 'deepseek-v4-flash'
      and profile.status = 'draft'
      and profile.adapter_kind = 'deepseek_chat_v1'
      and profile.wire_api_kind = 'chat_completions_v1'
      and profile.credential_alias = 'deepseek_api_key'
      and profile.endpoint_alias = 'deepseek_official'
      and profile.capability_contract_id = 'deepseek_chat_json_object_v1'
      and profile.cache_policy_id = 'deepseek_automatic_context_cache_v1'
      and profile.legal_manifest_id = 'deepseek-official-2026-08-23-v1'
      and profile.display_disclosure_key = 'deepseek-official-v1'
      and profile.config =
        '{"thinking":"disabled","structuredOutput":"json_object","providerSubjectField":"user_id"}'::jsonb
      and profile.config_sha256 =
        'a79bbbaa5934d7f4890b2e97e13e7768f031e99625fe11446ba437feeffc8fa9'
      and profile.activated_at is null
      and profile.retired_at is null
  ) then
    raise exception 'DB-012 DeepSeek profile identity mismatch'
      using errcode = '23514';
  end if;

  -- The UUID and natural price identity are exact-or-fail.  A replay may see
  -- precisely the fully sealed row below, but cannot turn a partial/colliding
  -- row into a different historical assertion.
  select count(*) into v_price_count
  from public.ai_price_versions as price
  where price.id = c_price_id
     or (
       price.profile_version_id = c_profile_id
       and price.pricing_lane = 'legacy'
       and price.version = 1
     );

  if v_price_count = 0 then
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
    ) values (
      c_price_id,
      c_profile_id,
      'legacy',
      1,
      'CNY',
      'linear_token_v1',
      '-infinity'::timestamptz,
      c_cutoff,
      null,
      c_cutoff,
      'https://web.archive.org/web/20260814163114id_/https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
      '2026-08-25T16:42:19.348Z'::timestamptz,
      '2bab2555968333b6e0a6e9f04c5427880f36fba491d95790c3f44261e00c7d07',
      '{}'::jsonb
    );
    v_created_price := true;
  elsif v_price_count <> 1 then
    raise exception 'DB-012 legacy price UUID or natural identity collision'
      using errcode = '23514';
  end if;

  select price.* into v_price
  from public.ai_price_versions as price
  where price.id = c_price_id
  for update;

  if not found
     or v_price.profile_version_id is distinct from c_profile_id
     or v_price.pricing_lane is distinct from 'legacy'
     or v_price.version is distinct from 1
     or v_price.currency is distinct from 'CNY'
     or v_price.calculator_kind is distinct from 'linear_token_v1'
     or v_price.valid_from is distinct from '-infinity'::timestamptz
     or v_price.valid_to is distinct from c_cutoff
     or v_price.provider_effective_from is not null
     or v_price.provider_effective_to is distinct from c_cutoff
     or v_price.source_url is distinct from
       'https://web.archive.org/web/20260814163114id_/https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
     or v_price.source_checked_at is distinct from
       '2026-08-25T16:42:19.348Z'::timestamptz
     or v_price.source_snapshot_sha256 is distinct from
       '2bab2555968333b6e0a6e9f04c5427880f36fba491d95790c3f44261e00c7d07'
     or v_price.parameters is distinct from '{}'::jsonb then
    raise exception 'DB-012 legacy price projection mismatch'
      using errcode = '23514';
  end if;

  if v_created_price then
    insert into public.ai_price_components (
      price_version_id,
      component,
      nanos_per_million
    ) values
      (c_price_id, 'input_cache_read', 20000000),
      (c_price_id, 'input_standard', 1000000000),
      (c_price_id, 'output', 2000000000);

    -- DB-007's private seal helper is intentionally invoked by this owner-only
    -- primitive in this same transaction; no service-role grant is added.
    perform public.seal_ai_price_components_v1(
      array[c_price_id],
      greatest(pg_catalog.clock_timestamp(), v_price.created_at)
    );
  end if;

  select count(*), count(*) filter (
    where (component, nanos_per_million) in (
      ('input_cache_read'::text, 20000000::bigint),
      ('input_standard'::text, 1000000000::bigint),
      ('output'::text, 2000000000::bigint)
    )
  ) into v_component_count, v_exact_component_count
  from public.ai_price_components
  where price_version_id = c_price_id;

  select price.* into v_price
  from public.ai_price_versions as price
  where price.id = c_price_id
  for share;

  if v_component_count <> 3
     or v_exact_component_count <> 3
     or v_price.components_sealed_at is null then
    raise exception 'DB-012 legacy price components or seal mismatch'
      using errcode = '23514';
  end if;

  -- The candidate is deliberately narrower than "old-looking" rows.  Current
  -- route/V2/cost facts and child attempts are not repaired or reinterpreted.
  for v_request in
    select request.*
    from public.ai_request_ledger as request
    where request.state = 'finalized'
      and request.status is not null
      and request.finalized_at is not null
      and request.model is not distinct from 'deepseek-v4-flash'
      and request.reserved_at < c_cutoff
      and (request.provider_started_at is null or request.provider_started_at < c_cutoff)
      and request.finalized_at < c_cutoff
      and request.route_schema_version is null
      and pg_catalog.num_nonnulls(
        request.config_generation,
        request.routing_policy_version_id,
        request.profile_version_id,
        request.price_version_id,
        request.legal_bundle_version,
        request.runtime_contract_id,
        request.runtime_contract_sha256,
        request.gateway_kind,
        request.model_id,
        request.wire_api_kind,
        request.display_disclosure_key
      ) = 0
      and request.usage_schema_version is null
      and request.cost_basis is null
      and pg_catalog.num_nonnulls(
        request.input_total_tokens,
        request.input_cache_read_tokens,
        request.input_cache_write_tokens,
        request.input_standard_tokens,
        request.reasoning_tokens,
        request.cache_usage_reporting,
        request.incomplete_fields,
        request.billing_currency,
        request.known_estimated_cost_nanos,
        request.estimated_cost_nanos,
        request.provider_reported_currency,
        request.provider_reported_cost_nanos,
        request.cost_reconciliation_status
      ) = 0
      and not exists (
        select 1
        from public.ai_provider_attempt_ledger as attempt
        where attempt.reservation_id = request.reservation_id
      )
    order by request.reservation_id
    for update of request
  loop
    -- Recheck all facts after the parent lock.  Any late child, prebinding, or
    -- cutoff/identity change fails closed instead of producing a partial run.
    if v_request.state is distinct from 'finalized'
       or v_request.status is null
       or v_request.finalized_at is null
       or v_request.model is distinct from 'deepseek-v4-flash'
       or v_request.reserved_at >= c_cutoff
       or v_request.provider_started_at >= c_cutoff
       or v_request.finalized_at >= c_cutoff
       or v_request.route_schema_version is not null
       or pg_catalog.num_nonnulls(
         v_request.config_generation, v_request.routing_policy_version_id,
         v_request.profile_version_id, v_request.price_version_id,
         v_request.legal_bundle_version, v_request.runtime_contract_id,
         v_request.runtime_contract_sha256, v_request.gateway_kind,
         v_request.model_id, v_request.wire_api_kind,
         v_request.display_disclosure_key, v_request.usage_schema_version,
         v_request.cost_basis, v_request.input_total_tokens,
         v_request.input_cache_read_tokens, v_request.input_cache_write_tokens,
         v_request.input_standard_tokens, v_request.reasoning_tokens,
         v_request.cache_usage_reporting, v_request.incomplete_fields,
         v_request.billing_currency, v_request.known_estimated_cost_nanos,
         v_request.estimated_cost_nanos, v_request.provider_reported_currency,
         v_request.provider_reported_cost_nanos,
         v_request.cost_reconciliation_status
       ) <> 0
       or exists (
         select 1 from public.ai_provider_attempt_ledger as attempt
         where attempt.reservation_id = v_request.reservation_id
       ) then
      raise exception 'DB-012 candidate changed while locked'
        using errcode = '23514';
    end if;

    v_complete_tokens := v_request.input_cached_tokens is not null
      and v_request.input_uncached_tokens is not null
      and v_request.output_tokens is not null;
    v_input_aggregate_known := v_request.input_cached_tokens is not null
      and v_request.input_uncached_tokens is not null;
    v_zero_or_absent_tokens := pg_catalog.num_nonnulls(
      v_request.input_cached_tokens,
      v_request.input_uncached_tokens,
      v_request.output_tokens
    ) = 0 or (
      v_request.input_cached_tokens = 0
      and v_request.input_uncached_tokens = 0
      and v_request.output_tokens = 0
    );

    if v_request.provider_billable is true
       and v_request.status in ('succeeded', 'canceled', 'failed_upstream', 'invalid_output')
       and v_request.provider_started_at is not null
       and v_request.attempt_count > 0 then
      v_semantic_class := 'billable';
    elsif v_request.provider_billable is false
       and v_request.status in ('released', 'failed_upstream')
       and v_request.provider_started_at is null
       and v_request.attempt_count = 0
       and v_zero_or_absent_tokens then
      v_semantic_class := 'unbilled';
    elsif v_request.provider_billable is null
       and v_request.status in ('canceled', 'failed_upstream', 'invalid_output', 'abandoned')
       and v_request.provider_started_at is not null
       and v_request.attempt_count > 0 then
      v_semantic_class := 'unknown';
    else
      raise exception 'DB-012 contradictory legacy request semantic class: %',
        v_request.reservation_id using errcode = '23514';
    end if;

    if v_input_aggregate_known then
      if v_request.input_cached_tokens::numeric < 0
         or v_request.input_uncached_tokens::numeric < 0
         or v_request.input_cached_tokens::numeric > c_max_bigint
         or v_request.input_uncached_tokens::numeric > c_max_bigint then
        raise exception 'DB-012 legacy token range violation: %', v_request.reservation_id
          using errcode = '22003';
      end if;

      v_input_total := v_request.input_cached_tokens::numeric
        + v_request.input_uncached_tokens::numeric;
      if v_input_total > c_max_bigint then
        raise exception 'DB-012 legacy input-token sum overflow: %', v_request.reservation_id
          using errcode = '22003';
      end if;
    elsif v_request.input_cached_tokens is not null and v_request.input_cached_tokens < 0
       or v_request.input_uncached_tokens is not null and v_request.input_uncached_tokens < 0
       then
      raise exception 'DB-012 legacy token range violation: %', v_request.reservation_id
        using errcode = '22003';
    end if;

    if v_request.output_tokens is not null
       and (v_request.output_tokens::numeric < 0
         or v_request.output_tokens::numeric > c_max_bigint) then
      raise exception 'DB-012 legacy token range violation: %', v_request.reservation_id
        using errcode = '22003';
    end if;

    if v_semantic_class = 'billable'
       and v_request.usage_complete is true
       and v_complete_tokens then
      v_cost := pg_catalog.ceil((
        v_request.input_cached_tokens::numeric * 20000000::numeric
        + v_request.input_uncached_tokens::numeric * 1000000000::numeric
        + v_request.output_tokens::numeric * 2000000000::numeric
      ) / 1000000::numeric);
      if v_cost is null or v_cost < 0 or v_cost > c_max_bigint then
        raise exception 'DB-012 legacy cost overflow: %', v_request.reservation_id
          using errcode = '22003';
      end if;
    elsif v_semantic_class = 'unbilled' then
      v_cost := 0;
    else
      v_cost := null;
    end if;

    -- The trigger recognizes this transaction-local, SECURITY DEFINER-only
    -- owner path.  service_role can neither execute this function nor satisfy
    -- its current_user check in the trigger replacement below.
    perform pg_catalog.set_config(
      'ai.backfill_deepseek_legacy_pricing_v1', 'owner-executed', true
    );

    update public.ai_request_ledger
    set route_schema_version = 'legacy_pricing_v1',
        profile_version_id = c_profile_id,
        price_version_id = c_price_id,
        usage_schema_version = 'legacy_v1',
        input_total_tokens = case when v_input_aggregate_known then v_input_total::bigint else null end,
        input_cache_read_tokens = v_request.input_cached_tokens,
        input_cache_write_tokens = null,
        input_standard_tokens = v_request.input_uncached_tokens,
        reasoning_tokens = null,
        cache_usage_reporting = case
          when v_input_aggregate_known then 'unavailable'
          else null
        end,
        incomplete_fields = case
          when v_cost is null then array['estimated_cost']::text[]
          else array[]::text[]
        end,
        cost_basis = 'legacy_request_aggregate',
        billing_currency = 'CNY',
        known_estimated_cost_nanos = v_cost::bigint,
        estimated_cost_nanos = v_cost::bigint,
        provider_reported_currency = null,
        provider_reported_cost_nanos = null,
        cost_reconciliation_status = case
          when v_cost is null then 'incomplete_usage'
          else 'not_available'
        end
    where reservation_id = v_request.reservation_id;

    if not found then
      raise exception 'DB-012 locked candidate update disappeared'
        using errcode = '23514';
    end if;
  end loop;
end;
$$;

revoke all on function public.backfill_deepseek_legacy_pricing_v1()
  from public, anon, authenticated, service_role;

-- DB-007 rejects every direct bare -> legacy binding.  Preserve that rule for
-- service_role and all non-owner callers, while admitting exactly the private
-- primitive above (whose owner is verified dynamically, not by a role name).
create or replace function public.guard_ai_request_route_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_profile_display_disclosure_key text;
  v_components_sealed_at timestamptz;
  v_pricing_lane text;
  v_backfill_owner text;
begin
  if tg_op = 'UPDATE' and old.route_schema_version is not null and (
    new.route_schema_version, new.config_generation,
    new.routing_policy_version_id, new.profile_version_id, new.price_version_id,
    new.legal_bundle_version, new.runtime_contract_id, new.runtime_contract_sha256,
    new.gateway_kind, new.model_id, new.wire_api_kind, new.display_disclosure_key
  ) is distinct from (
    old.route_schema_version, old.config_generation,
    old.routing_policy_version_id, old.profile_version_id, old.price_version_id,
    old.legal_bundle_version, old.runtime_contract_id, old.runtime_contract_sha256,
    old.gateway_kind, old.model_id, old.wire_api_kind, old.display_disclosure_key
  ) then
    raise exception 'ai_request_ledger route binding is immutable once frozen'
      using errcode = '23514';
  end if;

  select pg_catalog.pg_get_userbyid(proc.proowner) into v_backfill_owner
  from pg_catalog.pg_proc as proc
  where proc.oid = 'public.backfill_deepseek_legacy_pricing_v1()'::regprocedure;

  if new.route_schema_version is not distinct from 'legacy_pricing_v1'
     and (tg_op = 'INSERT' or (tg_op = 'UPDATE' and old.route_schema_version is null))
     and new.profile_version_id is not null
     and new.price_version_id is not null
     and pg_catalog.num_nonnulls(
       new.config_generation, new.routing_policy_version_id,
       new.legal_bundle_version, new.runtime_contract_id, new.runtime_contract_sha256,
       new.gateway_kind, new.model_id, new.wire_api_kind, new.display_disclosure_key
     ) = 0
     and new.usage_schema_version is not distinct from 'legacy_v1'
     and new.cost_basis is not distinct from 'legacy_request_aggregate'
     and not (
       current_user = v_backfill_owner
       and pg_catalog.current_setting(
         'ai.backfill_deepseek_legacy_pricing_v1', true
       ) = 'owner-executed'
     ) then
    raise exception 'legacy pricing bindings cannot be created by direct ledger writes'
      using errcode = '23514';
  end if;

  if new.route_schema_version is not distinct from 'route_snapshot_v1'
     and new.profile_version_id is not null then
    select display_disclosure_key into v_profile_display_disclosure_key
    from public.ai_provider_profile_versions
    where id = new.profile_version_id
    for share;
    if not found then
      raise exception 'request route profile version does not exist' using errcode = '23503';
    end if;
    if new.display_disclosure_key is distinct from v_profile_display_disclosure_key then
      raise exception 'request route disclosure differs from immutable profile disclosure'
        using errcode = '23514';
    end if;
  end if;

  if new.price_version_id is not null then
    select components_sealed_at, pricing_lane
    into v_components_sealed_at, v_pricing_lane
    from public.ai_price_versions where id = new.price_version_id for share;
    if not found then
      raise exception 'request route price version does not exist' using errcode = '23503';
    end if;
    if new.route_schema_version is not distinct from 'legacy_pricing_v1'
       and v_pricing_lane <> 'legacy' then
      raise exception 'legacy pricing binding requires the reserved legacy lane'
        using errcode = '23514';
    end if;
    if new.route_schema_version is not distinct from 'route_snapshot_v1'
       and v_pricing_lane = 'legacy' then
      raise exception 'current route snapshots cannot reference the legacy lane'
        using errcode = '23514';
    end if;
    if v_components_sealed_at is null then
      raise exception 'request route requires an already sealed price version'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_ai_request_route_snapshot()
  from public, anon, authenticated, service_role;

select public.backfill_deepseek_legacy_pricing_v1();

commit;
