-- DB-013: audited, owner-controlled routing lifecycle.  This migration
-- composes the DB-007 guards and transition-intent trigger; it adds no route,
-- price, legal, runtime, or provider authoring authority.

begin;

-- The existing row guard accepts exactly these retirement edges but its
-- original intent CHECK did not.  Keep the single intent relation and trigger.
alter table public.ai_routing_policy_transition_intents
  drop constraint ai_routing_policy_transition_intents_status_check;
alter table public.ai_routing_policy_transition_intents
  add constraint ai_routing_policy_transition_intents_status_check check (
    (from_status, to_status) in (
      ('draft', 'validated'), ('draft', 'retired'),
      ('validated', 'canary'), ('validated', 'active'), ('validated', 'retired'),
      ('canary', 'active'), ('canary', 'retired'),
      ('active', 'retired')
    )
  );

create table public.ai_routing_lifecycle_audit (
  audit_id uuid primary key default extensions.gen_random_uuid(),
  operation text not null check (operation in (
    'policy_transition', 'pointer_set', 'pointer_clear',
    'profile_version_retire', 'profile_retire', 'price_close',
    'price_seal', 'profile_version_transition', 'policy_create'
  )),
  policy_version_id uuid null references public.ai_routing_policy_versions(id),
  profile_id uuid null references public.ai_provider_profiles(id),
  profile_version_id uuid null references public.ai_provider_profile_versions(id),
  price_version_id uuid null references public.ai_price_versions(id),
  from_status text null,
  to_status text null,
  old_active_policy_version_id uuid null references public.ai_routing_policy_versions(id),
  new_active_policy_version_id uuid null references public.ai_routing_policy_versions(id),
  old_config_generation bigint null,
  new_config_generation bigint null,
  old_retired_at timestamptz null,
  new_retired_at timestamptz null,
  old_valid_to timestamptz null,
  new_valid_to timestamptz null,
  old_components_sealed_at timestamptz null,
  new_components_sealed_at timestamptz null,
  runtime_contract_id text not null check (
    runtime_contract_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$'
  ),
  runtime_contract_sha256 text not null check (runtime_contract_sha256 ~ '^[0-9a-f]{64}$'),
  actor text not null check (actor = pg_catalog.btrim(actor) and pg_catalog.length(actor) between 1 and 128),
  reason text not null check (reason = pg_catalog.btrim(reason) and pg_catalog.length(reason) between 1 and 500),
  reviewed_source_commit_oid text not null check (reviewed_source_commit_oid ~ '^sha1:[0-9a-f]{40}$'),
  reviewed_source_sha256 text not null check (reviewed_source_sha256 ~ '^[0-9a-f]{64}$'),
  rechecked_at timestamptz not null,
  rechecked_sha256 text not null check (rechecked_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz not null,
  transaction_id bigint not null,
  constraint ai_routing_lifecycle_audit_operation_shape check (
    (operation = 'policy_transition'
      and policy_version_id is not null and from_status is not null and to_status is not null
      and profile_id is null and profile_version_id is null and price_version_id is null
      and old_active_policy_version_id is null and new_active_policy_version_id is null
      and old_config_generation is null and new_config_generation is null
      and old_retired_at is null and new_retired_at is null and old_valid_to is null and new_valid_to is null
      and old_components_sealed_at is null and new_components_sealed_at is null)
    or (operation = 'pointer_set'
      and policy_version_id is not null and from_status is null and to_status is null
      and new_active_policy_version_id = policy_version_id and new_active_policy_version_id is not null
      and old_config_generation is not null and new_config_generation = old_config_generation + 1
      and profile_id is null and profile_version_id is null and price_version_id is null
      and old_retired_at is null and new_retired_at is null and old_valid_to is null and new_valid_to is null
      and old_components_sealed_at is null and new_components_sealed_at is null)
    or (operation = 'pointer_clear'
      and policy_version_id is not null and from_status is null and to_status is null
      and old_active_policy_version_id = policy_version_id and new_active_policy_version_id is null
      and old_config_generation is not null and new_config_generation = old_config_generation + 1
      and profile_id is null and profile_version_id is null and price_version_id is null
      and old_retired_at is null and new_retired_at is null and old_valid_to is null and new_valid_to is null
      and old_components_sealed_at is null and new_components_sealed_at is null)
    or (operation = 'profile_version_retire'
      and profile_version_id is not null and old_retired_at is null and new_retired_at is not null
      and policy_version_id is null and profile_id is null and price_version_id is null
      and from_status is null and to_status is null and old_active_policy_version_id is null and new_active_policy_version_id is null
      and old_config_generation is null and new_config_generation is null and old_valid_to is null and new_valid_to is null
      and old_components_sealed_at is null and new_components_sealed_at is null)
    or (operation = 'profile_retire'
      and profile_id is not null and old_retired_at is null and new_retired_at is not null
      and policy_version_id is null and profile_version_id is null and price_version_id is null
      and from_status is null and to_status is null and old_active_policy_version_id is null and new_active_policy_version_id is null
      and old_config_generation is null and new_config_generation is null and old_valid_to is null and new_valid_to is null
      and old_components_sealed_at is null and new_components_sealed_at is null)
    or (operation = 'price_close'
      and price_version_id is not null and old_valid_to is null and new_valid_to is not null
      and policy_version_id is null and profile_id is null and profile_version_id is null
      and from_status is null and to_status is null and old_active_policy_version_id is null and new_active_policy_version_id is null
      and old_config_generation is null and new_config_generation is null and old_retired_at is null and new_retired_at is null
      and old_components_sealed_at is null and new_components_sealed_at is null)
    or (operation = 'price_seal'
      and price_version_id is not null and old_components_sealed_at is null and new_components_sealed_at is not null
      and policy_version_id is null and profile_id is null and profile_version_id is null
      and from_status is null and to_status is null and old_active_policy_version_id is null and new_active_policy_version_id is null
      and old_config_generation is null and new_config_generation is null and old_retired_at is null and new_retired_at is null
      and old_valid_to is null and new_valid_to is null)
    or (operation = 'profile_version_transition'
      and profile_version_id is not null and from_status is not null and to_status is not null
      and policy_version_id is null and profile_id is null and price_version_id is null
      and old_active_policy_version_id is null and new_active_policy_version_id is null
      and old_config_generation is null and new_config_generation is null and old_retired_at is null and new_retired_at is null
      and old_valid_to is null and new_valid_to is null and old_components_sealed_at is null and new_components_sealed_at is null)
    or (operation = 'policy_create'
      and policy_version_id is not null
      and profile_id is null and profile_version_id is null and price_version_id is null
      and from_status is null and to_status is null and old_active_policy_version_id is null and new_active_policy_version_id is null
      and old_config_generation is null and new_config_generation is null and old_retired_at is null and new_retired_at is null
      and old_valid_to is null and new_valid_to is null and old_components_sealed_at is null and new_components_sealed_at is null)
  )
);

alter table public.ai_routing_lifecycle_audit enable row level security;
revoke all on public.ai_routing_lifecycle_audit from public, anon, authenticated, service_role;

create function public.guard_ai_routing_lifecycle_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'ai_routing_lifecycle_audit is append-only' using errcode = '23514';
end;
$$;
create trigger guard_ai_routing_lifecycle_audit
before update or delete on public.ai_routing_lifecycle_audit
for each row execute function public.guard_ai_routing_lifecycle_audit();
revoke execute on function public.guard_ai_routing_lifecycle_audit()
  from public, anon, authenticated, service_role;

-- Lifecycle tables remain readable to service_role where their prior grants
-- allowed it, but direct control-plane mutation is replaced by audited RPCs.
revoke insert, update, delete on public.ai_feature_config,
  public.ai_routing_policy_versions,
  public.ai_provider_profiles,
  public.ai_provider_profile_versions,
  public.ai_price_versions,
  public.ai_price_components,
  public.ai_legal_bundle_versions,
  public.ai_legal_bundle_manifests,
  public.ai_legal_manifest_versions,
  public.ai_service_runtime_contract_versions,
  public.ai_service_runtime_target_versions,
  public.ai_service_runtime_contract_targets
from service_role;
grant update (ai_polish_enabled, global_daily_limit, enabled_user_allowlist)
  on public.ai_feature_config to service_role;

-- Runtime ledger DML remains a service-role capability. Its security-invoker
-- route guard must preserve current_user because DB-012 admits its private
-- historical backfill only for the exact function owner. PostgreSQL row locks
-- also require some UPDATE authority after the broad catalog grants above are
-- revoked, so grant only columns whose table guards make direct changes
-- structurally unforgeable.
alter function public.guard_ai_request_route_snapshot() security invoker;
grant update (display_disclosure_key)
  on public.ai_provider_profile_versions to service_role;
grant update (components_sealed_at)
  on public.ai_price_versions to service_role;

create function public.assert_ai_routing_lifecycle_evidence_v1(
  p_runtime_contract_id text, p_runtime_contract_sha256 text,
  p_actor text, p_reason text, p_reviewed_source_commit_oid text,
  p_reviewed_source_sha256 text, p_rechecked_at timestamptz,
  p_rechecked_sha256 text, p_at timestamptz
) returns void language plpgsql security definer set search_path = '' as $$
declare v_root public.ai_service_runtime_contract_versions%rowtype;
begin
  if p_runtime_contract_id is null or p_runtime_contract_id !~ '^[a-z0-9][a-z0-9._-]{0,199}$'
     or p_runtime_contract_sha256 is null or p_runtime_contract_sha256 !~ '^[0-9a-f]{64}$'
     or p_actor is null or p_actor <> pg_catalog.btrim(p_actor) or pg_catalog.length(p_actor) not between 1 and 128
     or p_reason is null or p_reason <> pg_catalog.btrim(p_reason) or pg_catalog.length(p_reason) not between 1 and 500
     or p_reviewed_source_commit_oid is null or p_reviewed_source_commit_oid !~ '^sha1:[0-9a-f]{40}$'
     or p_reviewed_source_sha256 is null or p_reviewed_source_sha256 !~ '^[0-9a-f]{64}$'
     or p_rechecked_at is null or p_rechecked_at > p_at
     or p_rechecked_sha256 is null or p_rechecked_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid routing lifecycle evidence' using errcode = '23514';
  end if;
  select * into v_root from public.ai_service_runtime_contract_versions
  where runtime_contract_id=p_runtime_contract_id and runtime_contract_sha256=p_runtime_contract_sha256
  for share;
  if not found or v_root.sealed_at is null
     or v_root.reviewed_source_commit_oid is distinct from p_reviewed_source_commit_oid
     or p_reviewed_source_sha256 is distinct from p_runtime_contract_sha256
     or p_rechecked_at < v_root.created_at then
    raise exception 'routing lifecycle runtime evidence mismatch' using errcode = '23514';
  end if;
end; $$;
revoke execute on function public.assert_ai_routing_lifecycle_evidence_v1(text,text,text,text,text,text,timestamptz,text,timestamptz)
  from public, anon, authenticated, service_role;

create function public.assert_ai_routing_lifecycle_no_policy_reference_v1(
  p_reference_kind text, p_reference_id uuid, p_at timestamptz
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_policy public.ai_routing_policy_versions%rowtype;
  v_candidate public.ai_routing_policy_versions%rowtype;
  v_phase text;
  v_value text;
begin
  if p_reference_kind not in ('profile_version','price') or p_reference_id is null or p_at is null then
    raise exception 'routing lifecycle reference scan requires one typed target' using errcode='23514';
  end if;
  for v_policy in select * from public.ai_routing_policy_versions where status<>'retired' order by id for share loop
    v_candidate:=v_policy;
    v_phase:=case v_policy.status when 'draft' then 'validated' else v_policy.status end;
    if v_policy.status='draft' then
      v_candidate.status:='validated';
      begin
        perform public.validate_ai_routing_policy_row_v1(v_candidate,v_phase,p_at,true);
      exception when check_violation then
        -- An ineligible draft is inert immutable history and can never become a
        -- current route.  It must not block retirement of an unrelated target.
        continue;
      end;
    else
      perform public.validate_ai_routing_policy_row_v1(v_candidate,v_phase,p_at,true);
    end if;
    v_value:=case when p_reference_kind='profile_version' then v_policy.rules->'defaultRoute'->>'profileVersionId' else v_policy.rules->'defaultRoute'->>'priceVersionId' end;
    if v_value=p_reference_id::text or exists(
      select 1 from pg_catalog.jsonb_array_elements(v_policy.rules->'windows') as window_entry(value)
      where (case when p_reference_kind='profile_version' then window_entry.value->'route'->>'profileVersionId' else window_entry.value->'route'->>'priceVersionId' end)=p_reference_id::text
    ) then
      raise exception 'routing lifecycle target has a current policy reference' using errcode='23514';
    end if;
  end loop;
end; $$;
revoke execute on function public.assert_ai_routing_lifecycle_no_policy_reference_v1(text,uuid,timestamptz)
  from public, anon, authenticated, service_role;

create function public.assert_ai_routing_lifecycle_selected_price_evidence_v1(
  p_policy public.ai_routing_policy_versions,
  p_rechecked_at timestamptz
) returns void language plpgsql security definer set search_path = '' as $$
declare v_price record;
begin
  -- The DB-007 validator is called first by every caller.  Its strict parser
  -- makes these UUID casts safe and has already taken the canonical price locks.
  for v_price in
    select price.id, price.source_checked_at
    from public.ai_price_versions as price
    where price.id in (
      select (p_policy.rules->'defaultRoute'->>'priceVersionId')::uuid
      union
      select (window_entry.value->'route'->>'priceVersionId')::uuid
      from pg_catalog.jsonb_array_elements(p_policy.rules->'windows') as window_entry(value)
    )
    order by price.id
    for share
  loop
    if v_price.source_checked_at is null or v_price.source_checked_at > p_rechecked_at then
      raise exception 'routing lifecycle selected price evidence is stale' using errcode='23514';
    end if;
  end loop;
end; $$;
revoke execute on function public.assert_ai_routing_lifecycle_selected_price_evidence_v1(
  public.ai_routing_policy_versions, timestamptz
) from public, anon, authenticated, service_role;

create function public.lock_ai_routing_lifecycle_profile_prices_v1(
  p_profile_id uuid, p_profile_version_id uuid, p_rechecked_at timestamptz
) returns void language plpgsql security definer set search_path = '' as $$
declare v_price record;
begin
  if p_profile_id is null or p_rechecked_at is null then
    raise exception 'routing lifecycle profile price lock requires typed target and evidence time' using errcode='23514';
  end if;
  for v_price in
    select price.id, price.source_checked_at
    from public.ai_price_versions as price
    join public.ai_provider_profile_versions as version on version.id=price.profile_version_id
    where version.profile_id=p_profile_id
      and (p_profile_version_id is null or version.id=p_profile_version_id)
    order by price.id
    for share of price
  loop
    if v_price.source_checked_at is null or v_price.source_checked_at>p_rechecked_at then
      raise exception 'routing lifecycle profile price evidence is stale' using errcode='23514';
    end if;
  end loop;
end; $$;
revoke execute on function public.lock_ai_routing_lifecycle_profile_prices_v1(uuid,uuid,timestamptz)
  from public, anon, authenticated, service_role;

create function public.insert_ai_routing_lifecycle_audit_v1(
  p_operation text, p_policy uuid, p_profile uuid, p_profile_version uuid, p_price uuid,
  p_from text, p_to text, p_old_pointer uuid, p_new_pointer uuid, p_old_generation bigint, p_new_generation bigint,
  p_old_retired timestamptz, p_new_retired timestamptz, p_old_valid_to timestamptz, p_new_valid_to timestamptz,
  p_runtime_id text,p_runtime_hash text,p_actor text,p_reason text,p_commit text,p_source_hash text,p_rechecked timestamptz,p_rechecked_hash text,p_at timestamptz
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
 insert into public.ai_routing_lifecycle_audit(operation,policy_version_id,profile_id,profile_version_id,price_version_id,from_status,to_status,old_active_policy_version_id,new_active_policy_version_id,old_config_generation,new_config_generation,old_retired_at,new_retired_at,old_valid_to,new_valid_to,runtime_contract_id,runtime_contract_sha256,actor,reason,reviewed_source_commit_oid,reviewed_source_sha256,rechecked_at,rechecked_sha256,occurred_at,transaction_id)
 values(p_operation,p_policy,p_profile,p_profile_version,p_price,p_from,p_to,p_old_pointer,p_new_pointer,p_old_generation,p_new_generation,p_old_retired,p_new_retired,p_old_valid_to,p_new_valid_to,p_runtime_id,p_runtime_hash,p_actor,p_reason,p_commit,p_source_hash,p_rechecked,p_rechecked_hash,p_at,pg_catalog.txid_current()) returning audit_id into v_id;
 return v_id;
end; $$;
revoke execute on function public.insert_ai_routing_lifecycle_audit_v1(text,uuid,uuid,uuid,uuid,text,text,uuid,uuid,bigint,bigint,timestamptz,timestamptz,timestamptz,timestamptz,text,text,text,text,text,text,timestamptz,text,timestamptz)
 from public, anon, authenticated, service_role;

create function public.transition_ai_routing_policy_v2(p_policy_version_id uuid,p_to_status text,p_runtime_contract_id text,p_runtime_contract_sha256 text,p_actor text,p_reason text,p_reviewed_source_commit_oid text,p_reviewed_source_sha256 text,p_rechecked_at timestamptz,p_rechecked_sha256 text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_policy public.ai_routing_policy_versions%rowtype; v_candidate public.ai_routing_policy_versions%rowtype; v_at timestamptz:=pg_catalog.clock_timestamp(); v_id uuid;
begin
 perform pg_catalog.set_config('lock_timeout','5s',true); perform 1 from public.ai_feature_config where id=true for update;
 if not found then raise exception 'ai feature config singleton is missing' using errcode='23514'; end if;
 select * into v_policy from public.ai_routing_policy_versions where id=p_policy_version_id for update;
 if not found or p_to_status is null or p_to_status=v_policy.status then raise exception 'invalid routing lifecycle transition' using errcode='23514'; end if;
 if (p_runtime_contract_id,p_runtime_contract_sha256) is distinct from (v_policy.runtime_contract_id,v_policy.runtime_contract_sha256) then raise exception 'routing lifecycle runtime pair mismatch' using errcode='23514'; end if;
 perform public.assert_ai_routing_lifecycle_evidence_v1(p_runtime_contract_id,p_runtime_contract_sha256,p_actor,p_reason,p_reviewed_source_commit_oid,p_reviewed_source_sha256,p_rechecked_at,p_rechecked_sha256,v_at);
 if (v_policy.status,p_to_status) not in (('draft','validated'),('draft','retired'),('validated','canary'),('validated','active'),('validated','retired'),('canary','active'),('canary','retired'),('active','retired')) then raise exception 'invalid routing lifecycle transition' using errcode='23514'; end if;
 v_candidate:=v_policy;
 if p_to_status='retired' then
   if v_policy.status in ('draft','validated') then
     v_candidate.status:='validated';
   end if;
 else
   v_candidate.status:=p_to_status;
 end if;
 perform public.lock_and_validate_ai_routing_policy_row_v1(v_candidate,case when p_to_status='retired' then case when v_policy.status in ('draft','validated') then 'validated' else v_policy.status end else p_to_status end,v_at);
 if p_to_status='retired' and (exists(select 1 from public.ai_feature_config where id=true and active_routing_policy_version_id=v_policy.id)
    or exists(select 1 from public.ai_request_ledger where routing_policy_version_id=v_policy.id and state <> 'finalized')) then
   raise exception 'routing lifecycle target has a current pointer or unfinished request' using errcode='23514';
 end if;
 perform public.assert_ai_routing_lifecycle_selected_price_evidence_v1(v_policy,p_rechecked_at);
 insert into public.ai_routing_policy_transition_intents (
   policy_version_id, from_status, to_status, requested_at, requested_txid
 ) values (v_policy.id,v_policy.status,p_to_status,v_at,pg_catalog.txid_current());
 update public.ai_routing_policy_versions set status=p_to_status where id=v_policy.id;
 if exists(select 1 from public.ai_routing_policy_transition_intents where policy_version_id=v_policy.id) then
   raise exception 'routing policy transition intent was not consumed' using errcode='23514';
 end if;
 select public.insert_ai_routing_lifecycle_audit_v1('policy_transition',v_policy.id,null,null,null,v_policy.status,p_to_status,null,null,null,null,null,null,null,null,p_runtime_contract_id,p_runtime_contract_sha256,p_actor,p_reason,p_reviewed_source_commit_oid,p_reviewed_source_sha256,p_rechecked_at,p_rechecked_sha256,v_at) into v_id; return v_id;
end; $$;
revoke all on function public.transition_ai_routing_policy_v2(uuid,text,text,text,text,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
grant execute on function public.transition_ai_routing_policy_v2(uuid,text,text,text,text,text,text,text,timestamptz,text) to service_role;

create function public.set_ai_routing_policy_pointer_v1(p_policy_version_id uuid,p_runtime_contract_id text,p_runtime_contract_sha256 text,p_actor text,p_reason text,p_reviewed_source_commit_oid text,p_reviewed_source_sha256 text,p_rechecked_at timestamptz,p_rechecked_sha256 text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_config public.ai_feature_config%rowtype; v_updated public.ai_feature_config%rowtype; v_policy public.ai_routing_policy_versions%rowtype; v_at timestamptz:=pg_catalog.clock_timestamp(); v_id uuid;
begin
 perform pg_catalog.set_config('lock_timeout','5s',true); select * into v_config from public.ai_feature_config where id=true for update;
 if not found then raise exception 'ai feature config singleton is missing' using errcode='23514'; end if;
 select * into v_policy from public.ai_routing_policy_versions where id=p_policy_version_id for update;
 if not found or v_policy.status not in ('canary','active') or v_config.active_routing_policy_version_id is not distinct from p_policy_version_id then raise exception 'invalid routing pointer target' using errcode='23514'; end if;
 if (p_runtime_contract_id,p_runtime_contract_sha256) is distinct from (v_policy.runtime_contract_id,v_policy.runtime_contract_sha256) then raise exception 'routing lifecycle runtime pair mismatch' using errcode='23514'; end if;
 perform public.assert_ai_routing_lifecycle_evidence_v1(p_runtime_contract_id,p_runtime_contract_sha256,p_actor,p_reason,p_reviewed_source_commit_oid,p_reviewed_source_sha256,p_rechecked_at,p_rechecked_sha256,v_at);
 perform public.lock_and_validate_ai_routing_policy_row_v1(v_policy,v_policy.status,v_at);
 perform public.assert_ai_routing_lifecycle_selected_price_evidence_v1(v_policy,p_rechecked_at);
 update public.ai_feature_config set active_routing_policy_version_id=v_policy.id,routing_updated_by=p_actor,routing_change_reason=p_reason where id=true returning * into v_updated;
 if not found or v_updated.active_routing_policy_version_id is distinct from v_policy.id
    or v_updated.config_generation <> v_config.config_generation + 1 then
   raise exception 'routing pointer update did not preserve its guarded generation' using errcode='23514';
 end if;
 select public.insert_ai_routing_lifecycle_audit_v1('pointer_set',v_policy.id,null,null,null,null,null,v_config.active_routing_policy_version_id,v_updated.active_routing_policy_version_id,v_config.config_generation,v_updated.config_generation,null,null,null,null,p_runtime_contract_id,p_runtime_contract_sha256,p_actor,p_reason,p_reviewed_source_commit_oid,p_reviewed_source_sha256,p_rechecked_at,p_rechecked_sha256,v_at) into v_id; return v_id;
end; $$;
revoke all on function public.set_ai_routing_policy_pointer_v1(uuid,text,text,text,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
grant execute on function public.set_ai_routing_policy_pointer_v1(uuid,text,text,text,text,text,text,timestamptz,text) to service_role;

create function public.clear_ai_routing_policy_pointer_v1(p_expected_policy_version_id uuid,p_runtime_contract_id text,p_runtime_contract_sha256 text,p_actor text,p_reason text,p_reviewed_source_commit_oid text,p_reviewed_source_sha256 text,p_rechecked_at timestamptz,p_rechecked_sha256 text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_config public.ai_feature_config%rowtype; v_updated public.ai_feature_config%rowtype; v_policy public.ai_routing_policy_versions%rowtype; v_at timestamptz:=pg_catalog.clock_timestamp(); v_id uuid;
begin
 perform pg_catalog.set_config('lock_timeout','5s',true); select * into v_config from public.ai_feature_config where id=true for update;
 if not found or p_expected_policy_version_id is null or v_config.active_routing_policy_version_id is distinct from p_expected_policy_version_id then raise exception 'stale or absent routing pointer' using errcode='23514'; end if;
 select * into v_policy from public.ai_routing_policy_versions where id=p_expected_policy_version_id for update;
 if not found then raise exception 'routing policy does not exist' using errcode='23514'; end if;
 if (p_runtime_contract_id,p_runtime_contract_sha256) is distinct from (v_policy.runtime_contract_id,v_policy.runtime_contract_sha256) then raise exception 'routing lifecycle runtime pair mismatch' using errcode='23514'; end if;
 perform public.assert_ai_routing_lifecycle_evidence_v1(p_runtime_contract_id,p_runtime_contract_sha256,p_actor,p_reason,p_reviewed_source_commit_oid,p_reviewed_source_sha256,p_rechecked_at,p_rechecked_sha256,v_at);
 perform public.lock_and_validate_ai_routing_policy_row_v1(v_policy,v_policy.status,v_at);
 perform public.assert_ai_routing_lifecycle_selected_price_evidence_v1(v_policy,p_rechecked_at);
 update public.ai_feature_config set active_routing_policy_version_id=null,routing_updated_by=p_actor,routing_change_reason=p_reason where id=true returning * into v_updated;
 if not found or v_updated.active_routing_policy_version_id is not null
    or v_updated.config_generation <> v_config.config_generation + 1 then
   raise exception 'routing pointer clear did not preserve its guarded generation' using errcode='23514';
 end if;
 select public.insert_ai_routing_lifecycle_audit_v1('pointer_clear',v_policy.id,null,null,null,null,null,v_config.active_routing_policy_version_id,v_updated.active_routing_policy_version_id,v_config.config_generation,v_updated.config_generation,null,null,null,null,p_runtime_contract_id,p_runtime_contract_sha256,p_actor,p_reason,p_reviewed_source_commit_oid,p_reviewed_source_sha256,p_rechecked_at,p_rechecked_sha256,v_at) into v_id; return v_id;
end; $$;
revoke all on function public.clear_ai_routing_policy_pointer_v1(uuid,text,text,text,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
grant execute on function public.clear_ai_routing_policy_pointer_v1(uuid,text,text,text,text,text,text,timestamptz,text) to service_role;

create function public.retire_ai_provider_profile_version_v1(p_profile_version_id uuid,p_runtime_contract_id text,p_runtime_contract_sha256 text,p_actor text,p_reason text,p_reviewed_source_commit_oid text,p_reviewed_source_sha256 text,p_rechecked_at timestamptz,p_rechecked_sha256 text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v public.ai_provider_profile_versions%rowtype; v_parent public.ai_provider_profiles%rowtype; v_updated public.ai_provider_profile_versions%rowtype; v_at timestamptz:=pg_catalog.clock_timestamp(); v_id uuid;
begin
 perform pg_catalog.set_config('lock_timeout','5s',true); perform 1 from public.ai_feature_config where id=true for update; if not found then raise exception 'ai feature config singleton is missing' using errcode='23514'; end if;
 select profile_id into v_parent.id from public.ai_provider_profile_versions where id=p_profile_version_id; if not found then raise exception 'invalid profile version retirement' using errcode='23514'; end if;
 perform public.assert_ai_routing_lifecycle_no_policy_reference_v1('profile_version',p_profile_version_id,v_at);
 perform public.assert_ai_routing_lifecycle_evidence_v1(p_runtime_contract_id,p_runtime_contract_sha256,p_actor,p_reason,p_reviewed_source_commit_oid,p_reviewed_source_sha256,p_rechecked_at,p_rechecked_sha256,v_at);
 select * into v_parent from public.ai_provider_profiles where id=v_parent.id for update; if not found or v_parent.retired_at is not null then raise exception 'profile version parent is unavailable' using errcode='23514'; end if;
 select * into v from public.ai_provider_profile_versions where id=p_profile_version_id for update; if not found or v.profile_id is distinct from v_parent.id or v.retired_at is not null or v.status='retired' then raise exception 'profile version lifecycle drift' using errcode='23514'; end if;
 perform public.lock_ai_routing_lifecycle_profile_prices_v1(v_parent.id,v.id,p_rechecked_at);
 if exists(select 1 from public.ai_request_ledger where profile_version_id=v.id and state<>'finalized') then raise exception 'profile version has unfinished requests' using errcode='23514'; end if;
 update public.ai_provider_profile_versions set status='retired' where id=v.id returning * into v_updated;
 if not found or v_updated.retired_at is null or v_updated.status<>'retired' then raise exception 'profile version retirement was not trigger-managed' using errcode='23514'; end if;
 select public.insert_ai_routing_lifecycle_audit_v1('profile_version_retire',null,null,v.id,null,null,null,null,null,null,null,v.retired_at,v_updated.retired_at,null,null,p_runtime_contract_id,p_runtime_contract_sha256,p_actor,p_reason,p_reviewed_source_commit_oid,p_reviewed_source_sha256,p_rechecked_at,p_rechecked_sha256,v_at) into v_id; return v_id;
end; $$;
revoke all on function public.retire_ai_provider_profile_version_v1(uuid,text,text,text,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
grant execute on function public.retire_ai_provider_profile_version_v1(uuid,text,text,text,text,text,text,timestamptz,text) to service_role;

create function public.retire_ai_provider_profile_v1(p_profile_id uuid,p_runtime_contract_id text,p_runtime_contract_sha256 text,p_actor text,p_reason text,p_reviewed_source_commit_oid text,p_reviewed_source_sha256 text,p_rechecked_at timestamptz,p_rechecked_sha256 text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v public.ai_provider_profiles%rowtype; v_updated public.ai_provider_profiles%rowtype; v_child public.ai_provider_profile_versions%rowtype; v_at timestamptz:=pg_catalog.clock_timestamp(); v_id uuid;
begin
 perform pg_catalog.set_config('lock_timeout','5s',true); perform 1 from public.ai_feature_config where id=true for update; if not found then raise exception 'ai feature config singleton is missing' using errcode='23514'; end if;
 select id into v.id from public.ai_provider_profiles where id=p_profile_id; if not found then raise exception 'invalid profile retirement' using errcode='23514'; end if;
 for v_child in select * from public.ai_provider_profile_versions where profile_id=v.id order by id loop
   perform public.assert_ai_routing_lifecycle_no_policy_reference_v1('profile_version',v_child.id,v_at);
 end loop;
 perform public.assert_ai_routing_lifecycle_evidence_v1(p_runtime_contract_id,p_runtime_contract_sha256,p_actor,p_reason,p_reviewed_source_commit_oid,p_reviewed_source_sha256,p_rechecked_at,p_rechecked_sha256,v_at);
 select * into v from public.ai_provider_profiles where id=v.id for update; if not found or v.retired_at is not null then raise exception 'invalid profile retirement' using errcode='23514'; end if;
 for v_child in select * from public.ai_provider_profile_versions where profile_id=v.id order by id for update loop
   if v_child.status<>'retired' or v_child.retired_at is null then raise exception 'profile has non-retired versions' using errcode='23514'; end if;
   if exists(select 1 from public.ai_request_ledger where profile_version_id=v_child.id and state<>'finalized') then
     raise exception 'profile has unfinished requests' using errcode='23514';
   end if;
 end loop;
 perform public.lock_ai_routing_lifecycle_profile_prices_v1(v.id,null,p_rechecked_at);
 update public.ai_provider_profiles set retired_at=v_at where id=v.id returning * into v_updated;
 if not found or v_updated.retired_at is null then raise exception 'profile retirement did not persist' using errcode='23514'; end if;
 select public.insert_ai_routing_lifecycle_audit_v1('profile_retire',null,v.id,null,null,null,null,null,null,null,null,v.retired_at,v_updated.retired_at,null,null,p_runtime_contract_id,p_runtime_contract_sha256,p_actor,p_reason,p_reviewed_source_commit_oid,p_reviewed_source_sha256,p_rechecked_at,p_rechecked_sha256,v_at) into v_id; return v_id;
end; $$;
revoke all on function public.retire_ai_provider_profile_v1(uuid,text,text,text,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
grant execute on function public.retire_ai_provider_profile_v1(uuid,text,text,text,text,text,text,timestamptz,text) to service_role;

create function public.close_ai_price_version_v1(p_price_version_id uuid,p_valid_to timestamptz,p_successor_price_version_id uuid,p_runtime_contract_id text,p_runtime_contract_sha256 text,p_actor text,p_reason text,p_reviewed_source_commit_oid text,p_reviewed_source_sha256 text,p_rechecked_at timestamptz,p_rechecked_sha256 text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v public.ai_price_versions%rowtype; s public.ai_price_versions%rowtype; v_locked public.ai_price_versions%rowtype; v_updated public.ai_price_versions%rowtype; v_profile_version public.ai_provider_profile_versions%rowtype; v_profile public.ai_provider_profiles%rowtype; v_at timestamptz:=pg_catalog.clock_timestamp(); v_id uuid;
begin
 perform pg_catalog.set_config('lock_timeout','5s',true); perform 1 from public.ai_feature_config where id=true for update; if not found then raise exception 'ai feature config singleton is missing' using errcode='23514'; end if;
 select profile_version_id into v_profile_version.id from public.ai_price_versions where id=p_price_version_id; if not found then raise exception 'invalid price closure' using errcode='23514'; end if;
 perform public.assert_ai_routing_lifecycle_no_policy_reference_v1('price',p_price_version_id,v_at);
 perform public.assert_ai_routing_lifecycle_evidence_v1(p_runtime_contract_id,p_runtime_contract_sha256,p_actor,p_reason,p_reviewed_source_commit_oid,p_reviewed_source_sha256,p_rechecked_at,p_rechecked_sha256,v_at);
 select profile_id into v_profile.id from public.ai_provider_profile_versions where id=v_profile_version.id; if not found then raise exception 'price profile version is missing' using errcode='23503'; end if;
 select * into v_profile from public.ai_provider_profiles where id=v_profile.id for share; if not found then raise exception 'price parent profile is missing' using errcode='23503'; end if;
 select * into v_profile_version from public.ai_provider_profile_versions where id=v_profile_version.id for share; if not found or v_profile_version.profile_id is distinct from v_profile.id then raise exception 'price profile lifecycle drift' using errcode='23514'; end if;
 if p_successor_price_version_id is null then
   select * into v from public.ai_price_versions where id=p_price_version_id for update;
 else
   for v_locked in select * from public.ai_price_versions where id=any(array[p_price_version_id,p_successor_price_version_id]) order by id for update loop
     if v_locked.id=p_price_version_id then v:=v_locked; else s:=v_locked; end if;
   end loop;
 end if;
 if v.id is null or v.profile_version_id is distinct from v_profile_version.id or v.valid_to is not null or p_valid_to is null then raise exception 'invalid price closure' using errcode='23514'; end if;
 if p_valid_to <= v.valid_from then raise exception 'price close must be after valid_from' using errcode='23514'; end if;
 if v.source_checked_at is null or p_rechecked_at<v.source_checked_at or exists(select 1 from public.ai_request_ledger where price_version_id=v.id and state<>'finalized') then raise exception 'price closure has stale evidence or unfinished requests' using errcode='23514'; end if;
 if p_successor_price_version_id is null then
   null;
 else
   if s.id is null or s.id=v.id or s.components_sealed_at is null or s.profile_version_id<>v.profile_version_id
      or s.pricing_lane<>v.pricing_lane or s.valid_from<p_valid_to or s.source_checked_at is null
      or p_rechecked_at<s.source_checked_at then
     raise exception 'invalid price closure successor' using errcode='23514';
   end if;
   perform public.assert_ai_price_structure_v1(s.id);
 end if;
 update public.ai_price_versions set valid_to=p_valid_to where id=v.id and valid_to is null returning * into v_updated;
 if not found or v_updated.valid_to is distinct from p_valid_to then raise exception 'price close was not applied exactly once' using errcode='23514'; end if;
 select public.insert_ai_routing_lifecycle_audit_v1('price_close',null,null,null,v.id,null,null,null,null,null,null,null,null,v.valid_to,v_updated.valid_to,p_runtime_contract_id,p_runtime_contract_sha256,p_actor,p_reason,p_reviewed_source_commit_oid,p_reviewed_source_sha256,p_rechecked_at,p_rechecked_sha256,v_at) into v_id; return v_id;
end; $$;
revoke all on function public.close_ai_price_version_v1(uuid,timestamptz,uuid,text,text,text,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
grant execute on function public.close_ai_price_version_v1(uuid,timestamptz,uuid,text,text,text,text,text,text,timestamptz,text) to service_role;

-- The new activation edges share one narrow projection check.  This is not a
-- runtime selector: callers must supply an already sealed exact root, and the
-- helper only proves that that root covers the locked profile-version's legal
-- manifest. The common evidence helper already holds that exact root FOR
-- SHARE; sealed memberships are immutable and their projection FK already
-- points at the immutable exact runtime target. Therefore this narrow helper
-- need not repeat a target join. DB-007's policy validator still explicitly
-- joins the target projection when it validates a full routing policy.
create function public.assert_ai_routing_lifecycle_runtime_profile_coverage_v1(
  p_runtime_contract_id text,
  p_runtime_contract_sha256 text,
  p_profile_id uuid,
  p_profile_version_id uuid
) returns void language plpgsql security definer set search_path='' as $$
declare v_profile public.ai_provider_profiles%rowtype; v_version public.ai_provider_profile_versions%rowtype; v_manifest_sha256 text;
begin
  select * into v_profile from public.ai_provider_profiles where id=p_profile_id;
  select * into v_version from public.ai_provider_profile_versions where id=p_profile_version_id;
  select manifest_sha256 into v_manifest_sha256 from public.ai_legal_manifest_versions where legal_manifest_id=v_version.legal_manifest_id;
  if not found or v_profile.id is null or v_version.id is null or v_version.profile_id is distinct from v_profile.id
     or not exists (
       select 1
       from public.ai_service_runtime_contract_versions as root
       join public.ai_legal_bundle_versions as bundle
         on bundle.legal_bundle_version=root.legal_bundle_version
        and bundle.bundle_contract_sha256=root.bundle_contract_sha256
       join public.ai_legal_bundle_manifests as bundle_manifest
         on bundle_manifest.legal_bundle_version=root.legal_bundle_version
       join public.ai_service_runtime_contract_targets as membership
         on membership.runtime_contract_id=root.runtime_contract_id
        and membership.runtime_contract_sha256=root.runtime_contract_sha256
        and membership.profile_key=v_profile.profile_key
        and membership.legal_manifest_id=bundle_manifest.legal_manifest_id
        and membership.manifest_sha256=bundle_manifest.manifest_sha256
       where root.runtime_contract_id=p_runtime_contract_id
         and root.runtime_contract_sha256=p_runtime_contract_sha256
         and root.sealed_at is not null
         and bundle.sealed_at is not null
         and bundle_manifest.legal_manifest_id=v_version.legal_manifest_id
         and bundle_manifest.manifest_sha256=v_manifest_sha256
     ) then
    raise exception 'routing lifecycle runtime does not cover the exact profile legal manifest' using errcode='23514';
  end if;
end; $$;
revoke execute on function public.assert_ai_routing_lifecycle_runtime_profile_coverage_v1(text,text,uuid,uuid)
  from public, anon, authenticated, service_role;

create function public.seal_ai_price_for_activation_v1(
  p_price_version_id uuid,
  p_rechecked_source_url text,
  p_rechecked_currency text,
  p_rechecked_calculator_kind text,
  p_rechecked_provider_effective_from timestamptz,
  p_rechecked_provider_effective_to timestamptz,
  p_rechecked_parameters jsonb,
  p_rechecked_components jsonb,
  p_runtime_contract_id text,
  p_runtime_contract_sha256 text,
  p_actor text,
  p_reason text,
  p_reviewed_source_commit_oid text,
  p_reviewed_source_sha256 text,
  p_rechecked_at timestamptz,
  p_rechecked_sha256 text
) returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_price public.ai_price_versions%rowtype;
  v_version public.ai_provider_profile_versions%rowtype;
  v_profile public.ai_provider_profiles%rowtype;
  v_component record;
  v_component_count bigint;
  v_rechecked_component_count bigint;
  v_sealed_at timestamptz;
  v_at timestamptz:=pg_catalog.clock_timestamp();
  v_id uuid;
begin
  perform pg_catalog.set_config('lock_timeout','5s',true);
  perform 1 from public.ai_feature_config where id=true for update;
  if not found then raise exception 'ai feature config singleton is missing' using errcode='23514'; end if;
  if p_price_version_id is null or p_rechecked_components is null or pg_catalog.jsonb_typeof(p_rechecked_components)<>'object' then
    raise exception 'price activation requires an exact component object' using errcode='23514';
  end if;
  perform public.assert_ai_routing_lifecycle_evidence_v1(p_runtime_contract_id,p_runtime_contract_sha256,p_actor,p_reason,p_reviewed_source_commit_oid,p_reviewed_source_sha256,p_rechecked_at,p_rechecked_sha256,v_at);
  select profile_version_id into v_version.id from public.ai_price_versions where id=p_price_version_id;
  if not found then raise exception 'activation price does not exist' using errcode='23503'; end if;
  select profile_id into v_profile.id from public.ai_provider_profile_versions where id=v_version.id;
  if not found then raise exception 'activation price profile version does not exist' using errcode='23503'; end if;
  select * into v_profile from public.ai_provider_profiles where id=v_profile.id for share;
  select * into v_version from public.ai_provider_profile_versions where id=v_version.id for share;
  if not found or v_profile.retired_at is not null or v_version.profile_id is distinct from v_profile.id
     or v_version.retired_at is not null or v_version.status='retired' then
    raise exception 'activation price profile is retired or inconsistent' using errcode='23514';
  end if;
  perform public.assert_ai_routing_lifecycle_runtime_profile_coverage_v1(p_runtime_contract_id,p_runtime_contract_sha256,v_profile.id,v_version.id);
  select * into v_price from public.ai_price_versions where id=p_price_version_id for update;
  if not found or v_price.profile_version_id is distinct from v_version.id or v_price.pricing_lane='legacy'
     or v_price.valid_to is not null or v_price.components_sealed_at is not null
     or v_price.source_checked_at is null or p_rechecked_at<v_price.source_checked_at
     or p_rechecked_source_url is distinct from v_price.source_url
     or p_rechecked_currency is distinct from v_price.currency
     or p_rechecked_calculator_kind is distinct from v_price.calculator_kind
     or p_rechecked_provider_effective_from is distinct from v_price.provider_effective_from
     or p_rechecked_provider_effective_to is distinct from v_price.provider_effective_to
     or p_rechecked_parameters is distinct from v_price.parameters then
    raise exception 'activation price facts do not exactly match the immutable price version' using errcode='23514';
  end if;
  select count(*) into v_component_count from public.ai_price_components where price_version_id=v_price.id;
  select count(*) into v_rechecked_component_count from pg_catalog.jsonb_each(p_rechecked_components);
  if v_rechecked_component_count<>v_component_count then
    raise exception 'activation price components are missing or extra' using errcode='23514';
  end if;
  for v_component in select key,value from pg_catalog.jsonb_each(p_rechecked_components) loop
    if pg_catalog.jsonb_typeof(v_component.value)<>'string'
       or (v_component.value #>> '{}') !~ '^(0|[1-9][0-9]*)$'
       or pg_catalog.length(v_component.value #>> '{}')>19
       or (pg_catalog.length(v_component.value #>> '{}')=19 and (v_component.value #>> '{}')>'9223372036854775807')
       or not exists (
         select 1 from public.ai_price_components as component
         where component.price_version_id=v_price.id and component.component=v_component.key
           and component.nanos_per_million::text=(v_component.value #>> '{}')
       ) then
      raise exception 'activation price components do not exactly match the locked component set' using errcode='23514';
    end if;
  end loop;
  perform public.assert_ai_price_structure_v1(v_price.id);
  perform public.seal_ai_price_components_v1(array[v_price.id],greatest(pg_catalog.clock_timestamp(),v_price.created_at));
  select components_sealed_at into v_sealed_at from public.ai_price_versions where id=v_price.id;
  if v_sealed_at is null then raise exception 'activation price seal was not persisted' using errcode='23514'; end if;
  insert into public.ai_routing_lifecycle_audit(
    operation,price_version_id,old_components_sealed_at,new_components_sealed_at,
    runtime_contract_id,runtime_contract_sha256,actor,reason,reviewed_source_commit_oid,reviewed_source_sha256,
    rechecked_at,rechecked_sha256,occurred_at,transaction_id
  ) values (
    'price_seal',v_price.id,null,v_sealed_at,p_runtime_contract_id,p_runtime_contract_sha256,p_actor,p_reason,
    p_reviewed_source_commit_oid,p_reviewed_source_sha256,p_rechecked_at,p_rechecked_sha256,v_at,pg_catalog.txid_current()
  ) returning audit_id into v_id;
  return v_id;
end; $$;
revoke all on function public.seal_ai_price_for_activation_v1(uuid,text,text,text,timestamptz,timestamptz,jsonb,jsonb,text,text,text,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
grant execute on function public.seal_ai_price_for_activation_v1(uuid,text,text,text,timestamptz,timestamptz,jsonb,jsonb,text,text,text,text,text,text,timestamptz,text) to service_role;

create function public.transition_ai_provider_profile_version_v1(
  p_profile_version_id uuid,p_to_status text,p_runtime_contract_id text,p_runtime_contract_sha256 text,
  p_actor text,p_reason text,p_reviewed_source_commit_oid text,p_reviewed_source_sha256 text,
  p_rechecked_at timestamptz,p_rechecked_sha256 text
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_profile public.ai_provider_profiles%rowtype; v_version public.ai_provider_profile_versions%rowtype; v_updated public.ai_provider_profile_versions%rowtype; v_at timestamptz:=pg_catalog.clock_timestamp(); v_id uuid;
begin
  perform pg_catalog.set_config('lock_timeout','5s',true);
  perform 1 from public.ai_feature_config where id=true for update;
  if not found then raise exception 'ai feature config singleton is missing' using errcode='23514'; end if;
  perform public.assert_ai_routing_lifecycle_evidence_v1(p_runtime_contract_id,p_runtime_contract_sha256,p_actor,p_reason,p_reviewed_source_commit_oid,p_reviewed_source_sha256,p_rechecked_at,p_rechecked_sha256,v_at);
  select profile_id into v_profile.id from public.ai_provider_profile_versions where id=p_profile_version_id;
  if not found then raise exception 'profile promotion target does not exist' using errcode='23503'; end if;
  select * into v_profile from public.ai_provider_profiles where id=v_profile.id for share;
  select * into v_version from public.ai_provider_profile_versions where id=p_profile_version_id for update;
  if not found or v_profile.retired_at is not null or v_version.profile_id is distinct from v_profile.id
     or v_version.retired_at is not null or v_version.status='retired'
     or (v_version.status,p_to_status) not in (('draft','validated'),('validated','canary'),('validated','active'),('canary','active')) then
    raise exception 'invalid non-retirement profile version promotion' using errcode='23514';
  end if;
  perform public.assert_ai_routing_lifecycle_runtime_profile_coverage_v1(p_runtime_contract_id,p_runtime_contract_sha256,v_profile.id,v_version.id);
  update public.ai_provider_profile_versions set status=p_to_status where id=v_version.id returning * into v_updated;
  if not found or v_updated.status is distinct from p_to_status then raise exception 'profile version promotion was not applied exactly once' using errcode='23514'; end if;
  select public.insert_ai_routing_lifecycle_audit_v1('profile_version_transition',null,null,v_version.id,null,v_version.status,p_to_status,null,null,null,null,null,null,null,null,p_runtime_contract_id,p_runtime_contract_sha256,p_actor,p_reason,p_reviewed_source_commit_oid,p_reviewed_source_sha256,p_rechecked_at,p_rechecked_sha256,v_at) into v_id;
  return v_id;
end; $$;
revoke all on function public.transition_ai_provider_profile_version_v1(uuid,text,text,text,text,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
grant execute on function public.transition_ai_provider_profile_version_v1(uuid,text,text,text,text,text,text,text,timestamptz,text) to service_role;

create function public.create_ai_routing_policy_version_v1(
  p_policy_version_id uuid,p_policy_key text,p_version integer,p_timezone text,p_rules jsonb,p_default_profile_version_id uuid,
  p_legal_bundle_version text,p_config_sha256 text,p_runtime_contract_id text,p_runtime_contract_sha256 text,
  p_actor text,p_reason text,p_reviewed_source_commit_oid text,p_reviewed_source_sha256 text,p_rechecked_at timestamptz,p_rechecked_sha256 text
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_candidate public.ai_routing_policy_versions%rowtype; v_persisted public.ai_routing_policy_versions%rowtype; v_at timestamptz:=pg_catalog.clock_timestamp(); v_id uuid;
begin
  perform pg_catalog.set_config('lock_timeout','5s',true);
  perform 1 from public.ai_feature_config where id=true for update;
  if not found then raise exception 'ai feature config singleton is missing' using errcode='23514'; end if;
  if p_policy_version_id is null or p_policy_key is null or p_policy_key !~ '^[a-z0-9][a-z0-9._-]*$'
     or p_version is null or p_version<=0 or p_timezone is distinct from 'Asia/Shanghai'
     or p_rules is null or pg_catalog.jsonb_typeof(p_rules)<>'object' or p_default_profile_version_id is null
     or p_legal_bundle_version is null or pg_catalog.length(pg_catalog.btrim(p_legal_bundle_version))=0
     or p_config_sha256 is null or p_config_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid draft routing policy authoring input' using errcode='23514';
  end if;
  perform public.assert_ai_routing_lifecycle_evidence_v1(p_runtime_contract_id,p_runtime_contract_sha256,p_actor,p_reason,p_reviewed_source_commit_oid,p_reviewed_source_sha256,p_rechecked_at,p_rechecked_sha256,v_at);
  v_candidate.id:=p_policy_version_id;
  v_candidate.policy_key:=p_policy_key;
  v_candidate.version:=p_version;
  v_candidate.status:='validated';
  v_candidate.timezone:=p_timezone;
  v_candidate.rules:=p_rules;
  v_candidate.default_profile_version_id:=p_default_profile_version_id;
  v_candidate.legal_bundle_version:=p_legal_bundle_version;
  v_candidate.config_sha256:=p_config_sha256;
  v_candidate.runtime_contract_id:=p_runtime_contract_id;
  v_candidate.runtime_contract_sha256:=p_runtime_contract_sha256;
  v_candidate.created_at:=v_at;
  perform public.lock_and_validate_ai_routing_policy_row_v1(v_candidate,'validated',v_at);
  perform public.assert_ai_routing_lifecycle_selected_price_evidence_v1(v_candidate,p_rechecked_at);
  insert into public.ai_routing_policy_versions(
    id,policy_key,version,status,timezone,rules,default_profile_version_id,legal_bundle_version,config_sha256,runtime_contract_id,runtime_contract_sha256,created_at
  ) values (
    p_policy_version_id,p_policy_key,p_version,'draft',p_timezone,p_rules,p_default_profile_version_id,p_legal_bundle_version,p_config_sha256,p_runtime_contract_id,p_runtime_contract_sha256,v_at
  ) returning * into v_persisted;
  select * into v_persisted from public.ai_routing_policy_versions where id=p_policy_version_id for update;
  if not found or v_persisted.status<>'draft'
     or (v_persisted.id,v_persisted.policy_key,v_persisted.version,v_persisted.timezone,v_persisted.rules,v_persisted.default_profile_version_id,v_persisted.legal_bundle_version,v_persisted.config_sha256,v_persisted.runtime_contract_id,v_persisted.runtime_contract_sha256,v_persisted.created_at)
        is distinct from (p_policy_version_id,p_policy_key,p_version,p_timezone,p_rules,p_default_profile_version_id,p_legal_bundle_version,p_config_sha256,p_runtime_contract_id,p_runtime_contract_sha256,v_at) then
    raise exception 'persisted draft policy differs from the validated authored candidate' using errcode='23514';
  end if;
  select public.insert_ai_routing_lifecycle_audit_v1('policy_create',v_persisted.id,null,null,null,null,null,null,null,null,null,null,null,null,null,p_runtime_contract_id,p_runtime_contract_sha256,p_actor,p_reason,p_reviewed_source_commit_oid,p_reviewed_source_sha256,p_rechecked_at,p_rechecked_sha256,v_at) into v_id;
  return v_id;
end; $$;
revoke all on function public.create_ai_routing_policy_version_v1(uuid,text,integer,text,jsonb,uuid,text,text,text,text,text,text,text,text,timestamptz,text) from public,anon,authenticated,service_role;
grant execute on function public.create_ai_routing_policy_version_v1(uuid,text,integer,text,jsonb,uuid,text,text,text,text,text,text,text,text,timestamptz,text) to service_role;

commit;
