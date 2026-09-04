-- ADM-I06A: authenticated Admin write primitives. No business mutation is
-- exposed here and the control plane remains in legacy/read-only mode.
begin;

create table public.admin_committed_operations (
  id uuid primary key default extensions.gen_random_uuid(),
  actor_user_id uuid not null references public.admin_principals(user_id) on delete restrict,
  operation_kind text not null,
  idempotency_key uuid not null,
  canonical_payload_sha256 text not null,
  committed_result jsonb not null,
  domain_audit_id uuid not null references public.admin_audit_events(id) on delete restrict,
  committed_at timestamptz not null default clock_timestamp(),

  constraint admin_committed_operations_kind_check
    check (operation_kind ~ '^[a-z][a-z0-9_]{0,99}$'),
  constraint admin_committed_operations_payload_hash_check
    check (canonical_payload_sha256 ~ '^[0-9a-f]{64}$'),
  constraint admin_committed_operations_result_check
    check (jsonb_typeof(committed_result) = 'object'
      and octet_length(convert_to(committed_result::text, 'UTF8')) between 2 and 32768),
  constraint admin_committed_operations_actor_key_unique
    unique (actor_user_id, operation_kind, idempotency_key),
  constraint admin_committed_operations_id_actor_unique
    unique (id, actor_user_id)
);

alter table public.admin_committed_operations enable row level security;
revoke all on public.admin_committed_operations
  from public, anon, authenticated, service_role;

create function public.admin_guard_committed_operation_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'committed Admin operations are append-only'
    using errcode = '23514';
end;
$$;

create trigger admin_committed_operation_append_only
before update or delete on public.admin_committed_operations
for each row execute function public.admin_guard_committed_operation_v1();

-- Only outer, typed business RPCs may construct this payload. The browser
-- never supplies a hash. jsonb::text gives PostgreSQL's stable canonical key
-- ordering while length framing prevents operation/payload ambiguity.
create function public.admin_canonical_operation_payload_sha256_v1(
  p_operation_kind text,
  p_payload jsonb
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_payload text;
begin
  if p_operation_kind is null
     or p_operation_kind !~ '^[a-z][a-z0-9_]{0,99}$'
     or jsonb_typeof(p_payload) is distinct from 'object'
     or octet_length(convert_to(p_payload::text, 'UTF8')) > 32768 then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  v_payload := p_payload::text;
  return encode(extensions.digest(convert_to(
    octet_length(convert_to(p_operation_kind, 'UTF8'))::text || ':' || p_operation_kind
      || E'\n' || octet_length(convert_to(v_payload, 'UTF8'))::text || ':' || v_payload,
    'UTF8'
  ), 'sha256'), 'hex');
end;
$$;

-- A high-risk action needs all three views to agree: signed JWT claims, the
-- live Auth session, and its currently verified TOTP factor. An access-token
-- refresh does not create a new TOTP AMR timestamp.
create function public.admin_has_recent_totp_v1(p_actor uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_jwt jsonb := auth.jwt();
  v_session_id text := auth.jwt() ->> 'session_id';
  v_mfa_at timestamptz;
  v_factor_challenged_at timestamptz;
begin
  if p_actor is null
     or p_actor is distinct from auth.uid()
     or auth.role() is distinct from 'authenticated'
     or v_jwt ->> 'aal' is distinct from 'aal2'
     or jsonb_typeof(v_jwt -> 'amr') is distinct from 'array'
     or v_session_id is null
     or v_session_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;

  select max(to_timestamp((entry.value ->> 'timestamp')::double precision))
  into v_mfa_at
  from jsonb_array_elements(v_jwt -> 'amr') as entry(value)
  where entry.value ->> 'method' = 'totp'
    and entry.value ->> 'timestamp' ~ '^[0-9]{1,12}([.][0-9]{1,6})?$';

  if v_mfa_at is null
     or v_mfa_at < clock_timestamp() - interval '10 minutes'
     or v_mfa_at > clock_timestamp() + interval '30 seconds' then
    return false;
  end if;

  select factor.last_challenged_at
  into v_factor_challenged_at
  from auth.sessions as session
  join auth.mfa_factors as factor
    on factor.id = session.factor_id
   and factor.user_id = session.user_id
  where session.id = v_session_id::uuid
    and session.user_id = p_actor
    and session.aal::text = 'aal2'
    and (session.not_after is null or session.not_after > clock_timestamp())
    and factor.factor_type::text = 'totp'
    and factor.status::text = 'verified';

  return v_factor_challenged_at is not null
    and v_factor_challenged_at >= clock_timestamp() - interval '10 minutes'
    and v_factor_challenged_at <= clock_timestamp() + interval '30 seconds'
    and abs(extract(epoch from (v_factor_challenged_at - v_mfa_at))) <= 120;
exception
  when others then
    return false;
end;
$$;

-- Every future outer mutation calls this first. The exclusive membership lock
-- serializes revoke/grant and operation replay under one actor authority.
create function public.admin_assert_write_actor_v1(
  p_environment text,
  p_project_ref text,
  p_require_recent_totp boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_environment public.admin_environment%rowtype;
  v_session_id text := auth.jwt() ->> 'session_id';
begin
  if v_actor is null
     or auth.role() is distinct from 'authenticated'
     or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
     or v_session_id is null
     or v_session_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_environment
  from public.admin_environment where id = true for update;
  if not found then
    raise exception 'UNAVAILABLE' using errcode = 'P0001';
  end if;
  if v_environment.environment is distinct from p_environment
     or v_environment.project_ref is distinct from p_project_ref
     or v_environment.auth_issuer is distinct from auth.jwt() ->> 'iss' then
    raise exception 'ENVIRONMENT_MISMATCH' using errcode = '42501';
  end if;
  perform 1
  from public.admin_principals
  where user_id = v_actor and revoked_at is null
  for update;
  if not found then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (
    select 1 from auth.users
    where id = v_actor
      and deleted_at is null
      and not coalesce(is_anonymous, false)
      and (banned_until is null or banned_until <= clock_timestamp())
      and (email_confirmed_at is not null or phone_confirmed_at is not null)
  ) or not exists (
    select 1 from auth.sessions
    where id = v_session_id::uuid
      and user_id = v_actor
      and (not_after is null or not_after > clock_timestamp())
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if coalesce(p_require_recent_totp, false)
     and not public.admin_has_recent_totp_v1(v_actor) then
    raise exception 'STEP_UP_REQUIRED' using errcode = '42501';
  end if;
  return v_actor;
end;
$$;

-- Serialize an operation before mutable target/report/TOTP checks. Existing
-- same-payload results are replayable; a reused key with a different typed
-- payload is always a conflict.
create function public.admin_lock_committed_operation_v1(
  p_actor uuid,
  p_operation_kind text,
  p_idempotency_key uuid,
  p_typed_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text;
  v_existing public.admin_committed_operations%rowtype;
begin
  if p_actor is null or p_idempotency_key is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  v_hash := public.admin_canonical_operation_payload_sha256_v1(
    p_operation_kind, p_typed_payload
  );
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_actor::text || ':' || p_operation_kind || ':' || p_idempotency_key::text,
    7106
  ));
  select * into v_existing
  from public.admin_committed_operations
  where actor_user_id = p_actor
    and operation_kind = p_operation_kind
    and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.canonical_payload_sha256 is distinct from v_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'found', true,
      'operationId', v_existing.id,
      'result', v_existing.committed_result,
      'auditId', v_existing.domain_audit_id,
      'committedAt', v_existing.committed_at
    );
  end if;
  return jsonb_build_object('found', false, 'payloadSha256', v_hash);
end;
$$;

create function public.admin_commit_operation_v1(
  p_actor uuid,
  p_operation_kind text,
  p_idempotency_key uuid,
  p_typed_payload jsonb,
  p_committed_result jsonb,
  p_domain_audit_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text;
  v_operation public.admin_committed_operations%rowtype;
begin
  if p_actor is null or p_idempotency_key is null or p_domain_audit_id is null
     or jsonb_typeof(p_committed_result) is distinct from 'object'
     or octet_length(convert_to(p_committed_result::text, 'UTF8')) > 32768 then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  v_hash := public.admin_canonical_operation_payload_sha256_v1(
    p_operation_kind, p_typed_payload
  );
  if not exists (
    select 1 from public.admin_audit_events
    where id = p_domain_audit_id and actor = p_actor::text
  ) then
    raise exception 'INVALID_AUDIT_LINK' using errcode = '23514';
  end if;
  insert into public.admin_committed_operations(
    actor_user_id, operation_kind, idempotency_key,
    canonical_payload_sha256, committed_result, domain_audit_id
  ) values (
    p_actor, p_operation_kind, p_idempotency_key,
    v_hash, p_committed_result, p_domain_audit_id
  ) returning * into v_operation;
  return jsonb_build_object(
    'schemaVersion', 'admin_committed_operation_v1',
    'operationId', v_operation.id,
    'operationKind', v_operation.operation_kind,
    'idempotencyKey', v_operation.idempotency_key,
    'result', v_operation.committed_result,
    'auditId', v_operation.domain_audit_id,
    'committedAt', v_operation.committed_at
  );
exception
  when unique_violation then
    -- Outer RPCs must call lock first. Fail closed if a caller violates the
    -- protocol rather than guessing whether a concurrent result is equivalent.
    raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '23505';
end;
$$;

-- Used after an ambiguous HTTP outcome. It authenticates current membership
-- before returning this actor's committed result and cannot enumerate keys.
create function public.admin_get_committed_operation_v1(
  p_environment text,
  p_project_ref text,
  p_operation_kind text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_operation public.admin_committed_operations%rowtype;
begin
  v_actor := public.admin_assert_actor_v1(p_environment, p_project_ref);
  if p_operation_kind is null
     or p_operation_kind !~ '^[a-z][a-z0-9_]{0,99}$'
     or p_idempotency_key is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  select * into v_operation
  from public.admin_committed_operations
  where actor_user_id = v_actor
    and operation_kind = p_operation_kind
    and idempotency_key = p_idempotency_key;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'schemaVersion', 'admin_committed_operation_v1',
    'operationId', v_operation.id,
    'operationKind', v_operation.operation_kind,
    'idempotencyKey', v_operation.idempotency_key,
    'result', v_operation.committed_result,
    'auditId', v_operation.domain_audit_id,
    'committedAt', v_operation.committed_at
  );
end;
$$;

-- A read-only capability receipt for the Admin shell/security settings. It
-- does not enable writes or weaken the independent per-mutation checks.
create function public.admin_get_write_authority_v1(
  p_environment text,
  p_project_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_mode text;
begin
  v_actor := public.admin_assert_actor_v1(p_environment, p_project_ref);
  select control_plane_mode into v_mode
  from public.admin_environment where id = true;
  return jsonb_build_object(
    'schemaVersion', 'admin_write_authority_v1',
    'actorUserId', v_actor,
    'writesEnabled', v_mode = 'jwt_v1',
    'recentTotp', public.admin_has_recent_totp_v1(v_actor)
  );
end;
$$;

revoke all on function public.admin_guard_committed_operation_v1(),
  public.admin_canonical_operation_payload_sha256_v1(text, jsonb),
  public.admin_has_recent_totp_v1(uuid),
  public.admin_assert_write_actor_v1(text, text, boolean),
  public.admin_lock_committed_operation_v1(uuid, text, uuid, jsonb),
  public.admin_commit_operation_v1(uuid, text, uuid, jsonb, jsonb, uuid),
  public.admin_get_committed_operation_v1(text, text, text, uuid),
  public.admin_get_write_authority_v1(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_get_committed_operation_v1(text, text, text, uuid),
  public.admin_get_write_authority_v1(text, text)
  to authenticated;

commit;
