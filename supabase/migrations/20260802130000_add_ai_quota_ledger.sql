-- AI polish quota ledger and runtime feature switch (roadmap: "模型与配额",
-- "用量记录与日志", "功能开关").
--
-- Contents:
--   * ai_feature_config      - single-row runtime switch (kill switch +
--                              global daily limit + user allowlist), read
--                              atomically by every reserve call so changes take
--                              effect without a redeploy.
--   * ai_request_ledger      - per-request ledger with state machine
--                              reserved -> provider_started -> finalized and
--                              unique (user_id, client_request_id) dedup.
--   * ai_usage_daily         - per-user per-day request count and token usage
--                              (cached vs uncached input tokens kept separate -
--                              DeepSeek prices them 50x apart).
--   * ai_rate_minutes        - per-user fixed-window per-minute counters.
--   * ai_global_usage_daily  - global per-day provider_started counter + token
--                              cost totals. Never decremented: user quota may
--                              be refunded, global cost records may not
--                              (roadmap invariant 7).
--   * reserve/finalize/mark_provider_started RPCs implementing the roadmap
--                             settlement table, a stale-reservation
--                             reconciler, a retention cleanup function, and
--                             pg_cron schedules for both.
--
-- Access model: all tables are service_role only (RLS enabled, no policies,
-- privileges revoked from public/anon/authenticated). End users never read
-- them directly; remaining quota is exposed via GET /api/polish/quota which
-- uses the service_role admin client server-side. All functions pin
-- search_path = '' per repo convention.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.ai_feature_config (
  -- Singleton row; the boolean pk pattern keeps it to exactly one row.
  id boolean primary key default true check (id),
  ai_polish_enabled boolean not null default false,
  -- Global circuit breaker on provider_started requests per UTC day. The
  -- roadmap fixes the per-user free tier (20/day, 3/min) but leaves this
  -- value to operations; it is runtime-tunable here without a redeploy.
  global_daily_limit integer not null default 2000 check (global_daily_limit >= 0),
  -- Empty array = no restriction (all users allowed when enabled).
  enabled_user_allowlist uuid[] not null default '{}',
  updated_at timestamptz not null default now()
);

insert into public.ai_feature_config (ai_polish_enabled)
values (false);

create trigger set_ai_feature_config_updated_at
before update on public.ai_feature_config
for each row
execute function public.set_updated_at();

create table public.ai_request_ledger (
  reservation_id uuid primary key default extensions.gen_random_uuid(),
  -- Server-generated request id used in logs / responses / X-Request-Id.
  request_id uuid not null,
  -- Client-generated dedup key; unique per user. Never sent to the provider.
  client_request_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Metadata columns are filled at finalize time (reserve only knows user +
  -- ids). Metadata only: original text, polished output, style instructions
  -- and provider error bodies are never stored (roadmap 禁存清单).
  granularity text check (granularity in ('item', 'entry', 'section')),
  item_count integer check (item_count is null or item_count >= 0),
  context_level smallint check (context_level in (0, 1, 2)),
  language text check (language in ('zh', 'en')),
  model text,
  prompt_version text,
  validator_version text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  provider_request_id text,
  finish_reason text,
  failure_stage text check (failure_stage in (
    'terms', 'quota', 'request_validation', 'provider_http',
    'provider_timeout', 'json_parse', 'schema_validation',
    'semantic_validation', 'canceled'
  )),
  input_cached_tokens bigint check (input_cached_tokens is null or input_cached_tokens >= 0),
  input_uncached_tokens bigint check (input_uncached_tokens is null or input_uncached_tokens >= 0),
  output_tokens bigint check (output_tokens is null or output_tokens >= 0),
  -- Settlement outcome, set exactly once when state reaches 'finalized'.
  status text check (status in (
    'succeeded',        -- charged, all attempt tokens recorded
    'canceled',         -- user canceled after provider start: charged + billed
    'failed_upstream',  -- all attempts 5xx/timeout: refunded, usage recorded
    'invalid_output',   -- both validations failed: refunded, usage recorded
    'released',         -- never reached provider (validation fail or stale)
    'abandoned'         -- provider started, process died: refunded, billable unknown
  )),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  -- quota_charged (user quota) and provider_billable (real cost) are
  -- independent on purpose; provider_billable null = unknown (abandoned).
  quota_charged boolean,
  provider_billable boolean,
  usage_complete boolean not null default false,
  state text not null default 'reserved' check (state in (
    'reserved', 'provider_started', 'finalized'
  )),
  reserved_at timestamptz not null default now(),
  provider_started_at timestamptz,
  finalized_at timestamptz,

  constraint ai_request_ledger_state_consistency check (
    (
      state = 'finalized'
      and status is not null
      and finalized_at is not null
      and quota_charged is not null
    )
    or
    (
      state <> 'finalized'
      and status is null
      and finalized_at is null
      and quota_charged is null
    )
  ),
  constraint ai_request_ledger_provider_started_consistency check (
    (state = 'reserved' and provider_started_at is null)
    or (state = 'provider_started' and provider_started_at is not null)
    -- Finalized rows may or may not have reached the provider.
    or (state = 'finalized')
  )
);

create unique index ai_request_ledger_user_client_request_idx
on public.ai_request_ledger (user_id, client_request_id);

-- The reconciler only scans unfinished rows; keep that scan cheap.
create index ai_request_ledger_unfinished_idx
on public.ai_request_ledger (reserved_at)
where state <> 'finalized';

create table public.ai_usage_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- UTC calendar day, always derived from DB time.
  day date not null,
  request_count integer not null default 0 check (request_count >= 0),
  input_cached_tokens bigint not null default 0 check (input_cached_tokens >= 0),
  input_uncached_tokens bigint not null default 0 check (input_uncached_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),

  primary key (user_id, day)
);

create table public.ai_rate_minutes (
  user_id uuid not null references auth.users(id) on delete cascade,
  minute_bucket timestamptz not null,
  count integer not null default 0 check (count >= 0),

  primary key (user_id, minute_bucket)
);

create table public.ai_global_usage_daily (
  day date primary key,
  -- Incremented once per provider attempt (mark_provider_started), never
  -- decremented, so refunded/failed requests still count against the global
  -- daily circuit breaker.
  provider_started_count integer not null default 0 check (provider_started_count >= 0),
  input_cached_tokens bigint not null default 0 check (input_cached_tokens >= 0),
  input_uncached_tokens bigint not null default 0 check (input_uncached_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0)
);

alter table public.ai_feature_config enable row level security;
alter table public.ai_request_ledger enable row level security;
alter table public.ai_usage_daily enable row level security;
alter table public.ai_rate_minutes enable row level security;
alter table public.ai_global_usage_daily enable row level security;

-- No RLS policies on purpose: anon/authenticated are denied every operation
-- (and their table privileges are revoked below). service_role bypasses RLS
-- and is the only role with table grants.
revoke all on public.ai_feature_config from public, anon, authenticated;
revoke all on public.ai_request_ledger from public, anon, authenticated;
revoke all on public.ai_usage_daily from public, anon, authenticated;
revoke all on public.ai_rate_minutes from public, anon, authenticated;
revoke all on public.ai_global_usage_daily from public, anon, authenticated;

grant select, insert, update, delete on public.ai_feature_config to service_role;
grant select, insert, update, delete on public.ai_request_ledger to service_role;
grant select, insert, update, delete on public.ai_usage_daily to service_role;
grant select, insert, update, delete on public.ai_rate_minutes to service_role;
grant select, insert, update, delete on public.ai_global_usage_daily to service_role;

-- ---------------------------------------------------------------------------
-- reserve: atomic switch read + dedup + global daily limit + per-user daily
-- quota + per-minute rate limit + ledger insert.
--
-- Returns a jsonb object; 'allowed' false carries a 'reason' matching the
-- API contract error codes. All times are DB time; resetAt is the next UTC
-- midnight.
--
-- Dedup serialization (relay #9): a transaction-scoped advisory lock on
-- (user_id, client_request_id) is taken BEFORE the dedup lookup, so a
-- concurrent duplicate always observes the winner's committed ledger row and
-- returns REQUEST_IN_PROGRESS/DUPLICATE_REQUEST — never a misleading
-- QUOTA_EXCEEDED/RATE_LIMITED from a check that raced the winner's insert.
--
-- The global daily check here is a cheap pre-filter ONLY; the authoritative
-- atomic gate (config re-read + FOR UPDATE counter lock) lives in
-- mark_ai_polish_provider_started (relay #2).
-- ---------------------------------------------------------------------------

create or replace function public.reserve_ai_polish_request(
  p_user_id uuid,
  p_request_id uuid,
  p_client_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Free-tier limits fixed by the roadmap ("每日 20 次/用户 + 每分钟 3 次").
  c_daily_limit constant integer := 20;
  c_minute_limit constant integer := 3;
  v_config public.ai_feature_config%rowtype;
  v_existing_state text;
  v_today date := (now() at time zone 'utc')::date;
  v_reset_at timestamptz := (((now() at time zone 'utc')::date + 1) at time zone 'utc');
  v_minute timestamptz := date_trunc('minute', now());
  v_global_count integer;
  v_daily_count integer;
  v_minute_count integer;
  v_new_count integer;
  v_reservation_id uuid;
begin
  select * into v_config from public.ai_feature_config limit 1;
  if not found then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'INTERNAL_ERROR',
      'message', 'AI feature config row is missing.'
    );
  end if;

  -- Runtime kill switch (instant, no redeploy).
  if not v_config.ai_polish_enabled then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'AI_DISABLED',
      'message', 'AI polish is currently disabled.'
    );
  end if;

  -- Gradual-rollout allowlist: non-empty means only listed users pass.
  if cardinality(v_config.enabled_user_allowlist) > 0
     and not (p_user_id = any(v_config.enabled_user_allowlist)) then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'AI_DISABLED',
      'message', 'AI polish is not enabled for this account.'
    );
  end if;

  -- Serialize dedup on (user, client_request_id) BEFORE any quota/rate
  -- evaluation (relay #9): a concurrent duplicate waits here, then observes
  -- the winner's committed ledger row below and gets the correct 409 code.
  -- Released automatically at transaction end.
  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || p_client_request_id::text, 0)
  );

  -- Dedup (under the advisory lock): in-flight reservation ->
  -- REQUEST_IN_PROGRESS; settled row -> DUPLICATE_REQUEST. The unique index
  -- below still guards as a backstop.
  select state into v_existing_state
  from public.ai_request_ledger
  where user_id = p_user_id and client_request_id = p_client_request_id;
  if found then
    if v_existing_state = 'finalized' then
      return jsonb_build_object(
        'allowed', false,
        'reason', 'DUPLICATE_REQUEST',
        'message', 'This request was already processed.'
      );
    end if;
    return jsonb_build_object(
      'allowed', false,
      'reason', 'REQUEST_IN_PROGRESS',
      'message', 'An identical request is already in progress.'
    );
  end if;

  -- Global daily circuit breaker: CHEAP PRE-FILTER only. The count moves in
  -- mark_ai_polish_provider_started, which re-checks this atomically under a
  -- row lock (relay #2), so concurrent overshoot is impossible there even
  -- though it is possible here.
  select provider_started_count into v_global_count
  from public.ai_global_usage_daily
  where day = v_today;
  if coalesce(v_global_count, 0) >= v_config.global_daily_limit then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'SERVICE_UNAVAILABLE',
      'message', 'AI polish is temporarily unavailable (daily capacity reached).'
    );
  end if;

  -- Per-user daily quota. The row lock serializes concurrent reserves of the
  -- same user so the limit cannot be overshot.
  insert into public.ai_usage_daily (user_id, day)
  values (p_user_id, v_today)
  on conflict do nothing;

  select request_count into v_daily_count
  from public.ai_usage_daily
  where user_id = p_user_id and day = v_today
  for update;

  if v_daily_count >= c_daily_limit then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'QUOTA_EXCEEDED',
      'message', 'Daily AI polish quota exhausted.',
      'remaining', 0,
      'resetAt', v_reset_at
    );
  end if;

  -- Per-minute fixed-window rate limit (3/min; boundary bursts accepted).
  insert into public.ai_rate_minutes (user_id, minute_bucket)
  values (p_user_id, v_minute)
  on conflict do nothing;

  select count into v_minute_count
  from public.ai_rate_minutes
  where user_id = p_user_id and minute_bucket = v_minute
  for update;

  if v_minute_count >= c_minute_limit then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'RATE_LIMITED',
      'message', 'Too many AI polish requests; slow down.',
      'retryAfterSeconds', greatest(1, ceil(extract(epoch from (v_minute + interval '1 minute' - now())))::integer)
    );
  end if;

  -- All checks passed: consume quota + rate slot + create the reservation.
  -- The counter increments and the ledger insert share this block's implicit
  -- savepoint, so a unique_violation rollback also undoes the increments.
  begin
    update public.ai_usage_daily
    set request_count = request_count + 1
    where user_id = p_user_id and day = v_today
    returning request_count into v_new_count;

    update public.ai_rate_minutes
    set count = count + 1
    where user_id = p_user_id and minute_bucket = v_minute;

    insert into public.ai_request_ledger (request_id, client_request_id, user_id)
    values (p_request_id, p_client_request_id, p_user_id)
    returning reservation_id into v_reservation_id;
  exception
    when unique_violation then
      -- Concurrent duplicate submission slipped past the pre-check.
      return jsonb_build_object(
        'allowed', false,
        'reason', 'REQUEST_IN_PROGRESS',
        'message', 'An identical request is already in progress.'
      );
  end;

  return jsonb_build_object(
    'allowed', true,
    'reservationId', v_reservation_id,
    'limit', c_daily_limit,
    'remaining', c_daily_limit - v_new_count,
    'resetAt', v_reset_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_provider_started: reserved -> provider_started, once per provider
-- attempt. Increments attempt_count and the global daily counter (the counter
-- is never decremented - roadmap invariant 7). Returns ok=false when the
-- reservation is already finalized (caller must treat the request as dead).
--
-- This is the AUTHORITATIVE atomic gate for the global daily circuit breaker
-- (relay #2), not just a counter increment:
--   1. create + lock today's ai_global_usage_daily row FOR UPDATE;
--   2. re-read the runtime feature config;
--   3. recheck enabled state, the allowlist (if any) and
--      provider_started_count < global_daily_limit;
--   4. increment only when a slot remains;
--   5. otherwise return a structured denial (AI_DISABLED /
--      SERVICE_UNAVAILABLE) WITHOUT touching the counter.
-- Serializing on the global row means a burst racing the last slot lets
-- exactly ONE mark succeed. The reserve-time check remains only as a cheap
-- rejection path. Retries pass through the same gate, so a denied attempt 2
-- is reported to the caller, which must refund the user quota while keeping
-- the attempt-1 usage record.
-- ---------------------------------------------------------------------------

create or replace function public.mark_ai_polish_provider_started(
  p_reservation_id uuid,
  p_provider_request_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.ai_request_ledger%rowtype;
  v_config public.ai_feature_config%rowtype;
  v_today date := (now() at time zone 'utc')::date;
  v_attempt_count integer;
  v_global_count integer;
begin
  select * into v_row
  from public.ai_request_ledger
  where reservation_id = p_reservation_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'NOT_FOUND');
  end if;

  if v_row.state = 'finalized' then
    return jsonb_build_object('ok', false, 'reason', 'ALREADY_FINALIZED');
  end if;

  -- Create + lock today's global counter row. The FOR UPDATE lock serializes
  -- every concurrent provider start on the capacity check below.
  insert into public.ai_global_usage_daily (day)
  values (v_today)
  on conflict do nothing;

  select provider_started_count into v_global_count
  from public.ai_global_usage_daily
  where day = v_today
  for update;

  -- Re-read the runtime config: the state checked at reserve time may have
  -- changed (kill switch flipped, allowlist edited, limit lowered).
  select * into v_config from public.ai_feature_config limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'INTERNAL_ERROR');
  end if;

  if not v_config.ai_polish_enabled then
    return jsonb_build_object('ok', false, 'reason', 'AI_DISABLED');
  end if;

  if cardinality(v_config.enabled_user_allowlist) > 0
     and not (v_row.user_id = any(v_config.enabled_user_allowlist)) then
    return jsonb_build_object('ok', false, 'reason', 'AI_DISABLED');
  end if;

  -- The atomic gate itself: increment only while a slot remains.
  if v_global_count >= v_config.global_daily_limit then
    return jsonb_build_object('ok', false, 'reason', 'SERVICE_UNAVAILABLE');
  end if;

  update public.ai_request_ledger
  set state = 'provider_started',
      provider_started_at = coalesce(provider_started_at, now()),
      attempt_count = attempt_count + 1,
      provider_request_id = coalesce(p_provider_request_id, provider_request_id)
  where reservation_id = p_reservation_id
  returning attempt_count into v_attempt_count;

  update public.ai_global_usage_daily
  set provider_started_count = provider_started_count + 1
  where day = v_today;

  return jsonb_build_object('ok', true, 'attemptCount', v_attempt_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- finalize: idempotent settlement (roadmap settlement table).
--   * repeated call           -> no state change, no double counting
--   * quota_charged = false   -> the day's request_count is refunded once
--   * token usage             -> always recorded (per-user + global), even
--                                when the user quota is refunded
--   * quota snapshot          -> the post-settlement per-user quota
--                                (limit/remaining/resetAt) is computed in the
--                                same transaction and returned, so the route
--                                can answer WITHOUT a separate quota read
--                                after irreversible settlement (relay #8)
-- p_usage keys:    input_cached_tokens, input_uncached_tokens,
--                  output_tokens, usage_complete
-- p_metadata keys: granularity, item_count, context_level, language, model,
--                  prompt_version, validator_version, attempt_count,
--                  provider_request_id, finish_reason, failure_stage,
--                  latency_ms
--
-- Per-user token usage day attribution (relay #5): the per-user row is an
-- UPSERT on the FINALIZATION day (v_today), matching the day the global
-- totals use, so per-user and global cost totals can never disagree and a
-- request crossing UTC midnight can never drop its token record. (The quota
-- refund deliberately uses the RESERVATION day instead: that is where the
-- request consumed its slot.)
-- ---------------------------------------------------------------------------

create or replace function public.finalize_ai_polish_request(
  p_reservation_id uuid,
  p_status text,
  p_quota_charged boolean,
  p_provider_billable boolean default null,
  p_usage jsonb default null,
  p_metadata jsonb default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Kept in sync with c_daily_limit in reserve_ai_polish_request() /
  -- get_ai_polish_quota().
  c_daily_limit constant integer := 20;
  v_row public.ai_request_ledger%rowtype;
  v_today date := (now() at time zone 'utc')::date;
  v_reset_at timestamptz := (((now() at time zone 'utc')::date + 1) at time zone 'utc');
  v_quota_day date;
  v_cached bigint;
  v_uncached bigint;
  v_output bigint;
  v_usage_complete boolean;
  v_today_count integer;
  v_quota jsonb;
begin
  select * into v_row
  from public.ai_request_ledger
  where reservation_id = p_reservation_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'NOT_FOUND');
  end if;

  -- Post-settlement quota snapshot for the response (computed under the
  -- ledger row lock, in the same transaction as settlement — relay #8).
  select request_count into v_today_count
  from public.ai_usage_daily
  where user_id = v_row.user_id and day = v_today;
  v_quota := jsonb_build_object(
    'limit', c_daily_limit,
    'remaining', c_daily_limit - coalesce(v_today_count, 0),
    'resetAt', v_reset_at
  );

  -- Idempotent: a second finalize changes nothing and reports the settled
  -- outcome so the caller can log it.
  if v_row.state = 'finalized' then
    return jsonb_build_object(
      'ok', true,
      'alreadyFinalized', true,
      'status', v_row.status,
      'quotaCharged', v_row.quota_charged,
      'quota', v_quota
    );
  end if;

  -- 'abandoned' is reconciler-only; finalize may release a reservation that
  -- never reached the provider ('released', e.g. request validation failure).
  if p_status not in ('succeeded', 'canceled', 'failed_upstream', 'invalid_output', 'released') then
    return jsonb_build_object('ok', false, 'reason', 'INVALID_STATUS');
  end if;

  v_cached := coalesce((p_usage ->> 'input_cached_tokens')::bigint, 0);
  v_uncached := coalesce((p_usage ->> 'input_uncached_tokens')::bigint, 0);
  v_output := coalesce((p_usage ->> 'output_tokens')::bigint, 0);
  v_usage_complete := coalesce((p_usage ->> 'usage_complete')::boolean, false);
  v_quota_day := (v_row.reserved_at at time zone 'utc')::date;

  update public.ai_request_ledger
  set state = 'finalized',
      status = p_status,
      quota_charged = p_quota_charged,
      provider_billable = p_provider_billable,
      finalized_at = now(),
      input_cached_tokens = case when p_usage is null then null else v_cached end,
      input_uncached_tokens = case when p_usage is null then null else v_uncached end,
      output_tokens = case when p_usage is null then null else v_output end,
      usage_complete = v_usage_complete,
      granularity = coalesce(p_metadata ->> 'granularity', granularity),
      item_count = coalesce((p_metadata ->> 'item_count')::integer, item_count),
      context_level = coalesce((p_metadata ->> 'context_level')::smallint, context_level),
      language = coalesce(p_metadata ->> 'language', language),
      model = coalesce(p_metadata ->> 'model', model),
      prompt_version = coalesce(p_metadata ->> 'prompt_version', prompt_version),
      validator_version = coalesce(p_metadata ->> 'validator_version', validator_version),
      attempt_count = coalesce((p_metadata ->> 'attempt_count')::integer, attempt_count),
      provider_request_id = coalesce(p_metadata ->> 'provider_request_id', provider_request_id),
      finish_reason = coalesce(p_metadata ->> 'finish_reason', finish_reason),
      failure_stage = coalesce(p_metadata ->> 'failure_stage', failure_stage),
      latency_ms = coalesce((p_metadata ->> 'latency_ms')::integer, latency_ms)
  where reservation_id = p_reservation_id;

  -- Refund goes back to the reservation's day (a request crossing UTC
  -- midnight must not lose its refund).
  if not p_quota_charged then
    update public.ai_usage_daily
    set request_count = greatest(0, request_count - 1)
    where user_id = v_row.user_id and day = v_quota_day;
  end if;

  -- Token usage is a cost fact: recorded even when quota is refunded, and
  -- the global totals are never decremented (roadmap invariant 7). Per-user
  -- usage is attributed to the FINALIZATION day via upsert (relay #5): a
  -- request reserved before UTC midnight and finalized after it previously
  -- updated zero rows and silently dropped all known usage.
  if p_usage is not null then
    insert into public.ai_usage_daily (
      user_id,
      day,
      request_count,
      input_cached_tokens,
      input_uncached_tokens,
      output_tokens
    )
    values (
      v_row.user_id,
      v_today,
      0,
      v_cached,
      v_uncached,
      v_output
    )
    on conflict (user_id, day) do update
    set input_cached_tokens =
          ai_usage_daily.input_cached_tokens + excluded.input_cached_tokens,
        input_uncached_tokens =
          ai_usage_daily.input_uncached_tokens + excluded.input_uncached_tokens,
        output_tokens =
          ai_usage_daily.output_tokens + excluded.output_tokens;

    insert into public.ai_global_usage_daily (
      day, input_cached_tokens, input_uncached_tokens, output_tokens
    )
    values (v_today, v_cached, v_uncached, v_output)
    on conflict (day) do update
    set input_cached_tokens = ai_global_usage_daily.input_cached_tokens + excluded.input_cached_tokens,
        input_uncached_tokens = ai_global_usage_daily.input_uncached_tokens + excluded.input_uncached_tokens,
        output_tokens = ai_global_usage_daily.output_tokens + excluded.output_tokens;
  end if;

  -- The snapshot above was taken before settlement; recompute post-charge /
  -- post-refund so the response reflects the settled state.
  select request_count into v_today_count
  from public.ai_usage_daily
  where user_id = v_row.user_id and day = v_today;
  v_quota := jsonb_build_object(
    'limit', c_daily_limit,
    'remaining', c_daily_limit - coalesce(v_today_count, 0),
    'resetAt', v_reset_at
  );

  return jsonb_build_object(
    'ok', true,
    'alreadyFinalized', false,
    'status', p_status,
    'quotaCharged', p_quota_charged,
    'quota', v_quota
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- reconcile_stale_ai_polish_reservations (roadmap "崩溃 reconciliation"):
--   * 'reserved' stale          -> released: quota refunded, not billable
--   * 'provider_started' stale  -> abandoned: quota refunded,
--                                  provider_billable = null (unknown),
--                                  global counters never decremented
-- Scheduled via pg_cron below; also manually invocable.
-- ---------------------------------------------------------------------------

create or replace function public.reconcile_stale_ai_polish_reservations(
  p_stale_after interval default interval '10 minutes'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_released integer := 0;
  v_abandoned integer := 0;
begin
  with stale as (
    update public.ai_request_ledger
    set state = 'finalized',
        status = 'released',
        quota_charged = false,
        provider_billable = false,
        finalized_at = now()
    where state = 'reserved'
      and reserved_at < now() - p_stale_after
    returning user_id, (reserved_at at time zone 'utc')::date as quota_day
  ),
  refund as (
    update public.ai_usage_daily u
    set request_count = greatest(0, u.request_count - s.cnt)
    from (
      select user_id, quota_day, count(*)::integer as cnt
      from stale
      group by user_id, quota_day
    ) s
    where u.user_id = s.user_id and u.day = s.quota_day
  )
  select count(*)::integer into v_released from stale;

  with stale as (
    update public.ai_request_ledger
    set state = 'finalized',
        status = 'abandoned',
        quota_charged = false,
        provider_billable = null,
        usage_complete = false,
        finalized_at = now()
    where state = 'provider_started'
      and provider_started_at < now() - p_stale_after
    returning user_id, (reserved_at at time zone 'utc')::date as quota_day
  ),
  refund as (
    update public.ai_usage_daily u
    set request_count = greatest(0, u.request_count - s.cnt)
    from (
      select user_id, quota_day, count(*)::integer as cnt
      from stale
      group by user_id, quota_day
    ) s
    where u.user_id = s.user_id and u.day = s.quota_day
  )
  select count(*)::integer into v_abandoned from stale;

  return jsonb_build_object(
    'releasedCount', v_released,
    'abandonedCount', v_abandoned
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- cleanup_ai_polish_metadata: retention per roadmap ("保留策略与清理机制"):
--   rate_minutes 2 days, finalized ledger 90 days, usage_daily 90 days.
-- Reconciled stale reservations are ordinary finalized rows and age out with
-- the ledger. terms acceptance rows are untouched (kept until account
-- deletion).
-- ---------------------------------------------------------------------------

create or replace function public.cleanup_ai_polish_metadata()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rate integer;
  v_ledger integer;
  v_usage integer;
  v_global integer;
begin
  delete from public.ai_rate_minutes
  where minute_bucket < now() - interval '2 days';
  get diagnostics v_rate = row_count;

  delete from public.ai_request_ledger
  where state = 'finalized'
    and finalized_at < now() - interval '90 days';
  get diagnostics v_ledger = row_count;

  delete from public.ai_usage_daily
  where day < ((now() at time zone 'utc')::date - 90);
  get diagnostics v_usage = row_count;

  delete from public.ai_global_usage_daily
  where day < ((now() at time zone 'utc')::date - 90);
  get diagnostics v_global = row_count;

  return jsonb_build_object(
    'rateMinutesDeleted', v_rate,
    'ledgerDeleted', v_ledger,
    'usageDailyDeleted', v_usage,
    'globalUsageDailyDeleted', v_global
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- get_ai_polish_quota: remaining-quota read for GET /api/polish/quota
-- (service_role admin client; only login is checked at the route level).
-- ---------------------------------------------------------------------------

create or replace function public.get_ai_polish_quota(p_user_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  -- Kept in sync with c_daily_limit in reserve_ai_polish_request().
  c_daily_limit constant integer := 20;
  v_today date := (now() at time zone 'utc')::date;
  v_reset_at timestamptz := (((now() at time zone 'utc')::date + 1) at time zone 'utc');
  v_count integer;
begin
  select request_count into v_count
  from public.ai_usage_daily
  where user_id = p_user_id and day = v_today;

  return jsonb_build_object(
    'limit', c_daily_limit,
    'remaining', c_daily_limit - coalesce(v_count, 0),
    'resetAt', v_reset_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: service_role only.
-- ---------------------------------------------------------------------------

revoke execute on function public.reserve_ai_polish_request(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.mark_ai_polish_provider_started(uuid, text) from public, anon, authenticated;
revoke execute on function public.finalize_ai_polish_request(uuid, text, boolean, boolean, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.reconcile_stale_ai_polish_reservations(interval) from public, anon, authenticated;
revoke execute on function public.cleanup_ai_polish_metadata() from public, anon, authenticated;
revoke execute on function public.get_ai_polish_quota(uuid) from public, anon, authenticated;

grant execute on function public.reserve_ai_polish_request(uuid, uuid, uuid) to service_role;
grant execute on function public.mark_ai_polish_provider_started(uuid, text) to service_role;
grant execute on function public.finalize_ai_polish_request(uuid, text, boolean, boolean, jsonb, jsonb) to service_role;
grant execute on function public.reconcile_stale_ai_polish_reservations(interval) to service_role;
grant execute on function public.cleanup_ai_polish_metadata() to service_role;
grant execute on function public.get_ai_polish_quota(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- pg_cron schedules (roadmap: retention = Supabase Cron; stale reconciliation
-- is "定时" as well). No prior cron usage exists in this repo, so the
-- local/hosted difference is handled here:
--   * local dev (supabase CLI): the postgres image preloads pg_cron; this
--     migration creates the extension and both jobs automatically.
--   * hosted Supabase: enable the pg_cron extension once via
--     Dashboard -> Database -> Extensions BEFORE applying this migration;
--     the jobs are then scheduled here. If pg_cron is unavailable the
--     migration still succeeds (a warning is raised) and the two jobs must
--     be scheduled manually:
--       select cron.schedule('ai-polish-retention-cleanup', '15 3 * * *',
--         'select public.cleanup_ai_polish_metadata();');
--       select cron.schedule('ai-polish-stale-reconciliation', '*/5 * * * *',
--         'select public.reconcile_stale_ai_polish_reservations();');
-- ---------------------------------------------------------------------------

do $$
begin
  create extension if not exists pg_cron;
exception
  when insufficient_privilege or feature_not_supported or object_not_in_prerequisite_state then
    raise warning 'pg_cron unavailable; schedule ai-polish cron jobs manually (see comments in migration 20260802130000)';
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'ai-polish-retention-cleanup',
      '15 3 * * *',
      'select public.cleanup_ai_polish_metadata();'
    );
    perform cron.schedule(
      'ai-polish-stale-reconciliation',
      '*/5 * * * *',
      'select public.reconcile_stale_ai_polish_reservations();'
    );
  end if;
end;
$$;
