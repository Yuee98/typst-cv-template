begin;
set local search_path = '';
create function ai.execution_contract (p_adapter smallint)
  returns text
  language sql
  immutable
  set search_path = ''
  as $$
  select
    case p_adapter
    when 1 then
      'deepseek_responses_v1'
    when 2 then
      'mimo_responses_v1'
    when 3 then
      'gemini_interactions_v1'
    end
$$;
create function ai.price_json (p_config bigint)
  returns jsonb
  language sql
  stable
  set search_path = ''
  as $$
  select
    common.api_json (to_jsonb (p) - 'config_id')
  from
    ai.prices p
  where
    config_id = p_config
$$;
create function ai.quota (p_user uuid)
  returns jsonb
  language plpgsql
  set search_path = ''
  as $$
declare
  c ai.runtime_control;
  q ai.user_quota_daily;
  d date := (common.now() at time zone 'UTC')::date;
begin
  select
    *
  into
    c
  from
    ai.runtime_control
  where
    id = 1;
  select
    *
  into
    q
  from
    ai.user_quota_daily
  where
    auth_user_id = p_user
    and day = d;
  return common.api_json (jsonb_build_object('day', d, 'limit', c.user_daily_limit, 'reserved', coalesce(q.reserved_count, 0), 'charged', coalesce(q.charged_count, 0), 'remaining', greatest (0, c.user_daily_limit - coalesce(q.reserved_count, 0) - coalesce(q.charged_count, 0)), 'minute_limit', c.user_minute_limit, 'reset_at', (d + 1)::timestamp at time zone 'UTC'));
end
$$;
create function ai.current_rule (p_time timestamptz)
  returns bigint
  language sql
  stable
  set search_path = ''
  as $$
  select
    id
  from
    ai.routing_rules
  where
    enabled
    and (weekday is null
      or (weekday = extract(isodow from p_time at time zone 'Asia/Shanghai')
        and extract(hour from p_time at time zone 'Asia/Shanghai') * 60 + extract(minute from p_time at time zone 'Asia/Shanghai') >= start_minute
        and extract(hour from p_time at time zone 'Asia/Shanghai') * 60 + extract(minute from p_time at time zone 'Asia/Shanghai') < end_minute))
  order by
    weekday nulls last,
    id
  limit 1
$$;
create function ai.allowed (p_user uuid)
  returns boolean
  language sql
  stable
  set search_path = ''
  as $$
  select
    audience = 'ALL'
    or exists (
      select
        1
      from
        ai.allowed_users
      where
        auth_user_id = p_user)
  from
    ai.runtime_control
  where
    id = 1
$$;
create function ai.configuration_ready (p_config bigint)
  returns boolean
  language sql
  stable
  set search_path = ''
  as $$
  select
    exists (
      select
        1
      from
        ai.configurations c
        join legal.documents d on d.id = c.legal_document_id
        join ai.prices p on p.config_id = c.id
      where
        c.id = p_config
        and d.enabled
        and d.kind = 'AI_PROVIDER')
$$;
create function public.ai_quota (p_input jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  u uuid;
begin
  u = common.service_user (p_input);
  return ai.quota (u);
end
$$;
create function public.ai_availability (p_input jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  u uuid;
  c ai.runtime_control;
  r bigint;
  v record;
  common_doc bigint;
  items jsonb := '[]'::jsonb;
  why text;
  def bigint;
  q jsonb;
begin
  u = common.service_user (p_input);
  select
    *
  into
    c
  from
    ai.runtime_control
  where
    id = 1 for share;
  r = ai.current_rule (common.now());
  q = ai.quota (u);
  select
    id
  into
    common_doc
  from
    legal.documents
  where
    kind = 'AI_COMMON'
    and enabled;
  why = case when not c.enabled then
    'AI_DISABLED'
  when not ai.allowed (u) then
    'NOT_ALLOWED'
  when (q ->> 'remaining')::bigint <= 0 then
    'USER_DAILY_LIMIT'
  when r is null then
    'NO_ACTIVE_RULE'
  when common_doc is null then
    'LEGAL_UNAVAILABLE'
  else
    null
  end;
  for v in
  select
    x.*,
    m.is_default
  from
    ai.routing_rule_configurations m
    join ai.configurations x on x.id = m.config_id
  where
    m.rule_id = r
  order by
    m.is_default desc,
    x.id loop
      if v.enabled and ai.configuration_ready (v.id) and common_doc is not null then
        items = items || jsonb_build_array(common.api_json (jsonb_build_object('config_id', v.id, 'name', v.name, 'display_name', v.display_name, 'revision', v.revision, 'adapter_id', v.adapter_id, 'execution_contract', ai.execution_contract (v.adapter_id), 'endpoint_url', v.endpoint_url, 'model_id', v.model_id, 'credential_ref', v.credential_ref, 'eligible', why is null, 'reason', why, 'consent_required', legal.acceptance_for (u, common_doc) is null
              or legal.acceptance_for (u, v.legal_document_id) is null, 'legal_display', jsonb_build_object('contract', 'cv_app_db_2', 'common', legal.document_json ((
                  select
                    document_audit_id
                  from legal.documents
                  where
                    id = common_doc)), 'provider', legal.document_json ((
                  select
                    document_audit_id
                  from legal.documents
                  where
                    id = v.legal_document_id))))));
        if v.is_default then
          def = v.id;
        end if;
      end if;
    end loop;
  if def is null and jsonb_array_length(items) > 0 then
    def = (items #>> '{0,config_id}')::bigint;
  end if;
  return common.api_json (jsonb_build_object('contract_code', 'cv_app_db_2', 'database_instance_id', (
        select
          database_instance_id
        from admin.environment
        where
          id = 1), 'enabled', why is null
      and jsonb_array_length(items) > 0, 'reason', coalesce(why, case when jsonb_array_length(items) = 0 then
          'NO_CONFIGURATIONS'
        end), 'control_revision', c.revision, 'default_config_id', def, 'quota', q, 'configurations', items));
end
$$;
create function ai.lock_request (p_input jsonb, p_active boolean default true)
  returns ai.requests
  language plpgsql
  set search_path = ''
  as $$
declare
  u uuid;
  r ai.requests;
begin
  perform
    common.guard (p_input);
  u = (p_input ->> 'owner_auth_user_id')::uuid;
  if u is null then
    perform
      common.fail ('UNAUTHORIZED');
  end if;
  if p_active and not common.auth_user_active (u) then
    perform
      common.fail ('UNAUTHORIZED');
  end if;
  select
    *
  into
    r
  from
    ai.requests
  where
    external_id = p_input ->> 'request_id'
  for update;
  if r.id is null or (r.owner_auth_user_id is distinct from u and not (not p_active and r.owner_auth_user_id is null)) then
    perform
      common.fail ('NOT_FOUND', 'REQUEST_NOT_FOUND');
  end if;
  return r;
end
$$;
create function public.ai_reserve (p_input jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  u uuid;
  c ai.runtime_control;
  x ai.configurations;
  r ai.requests;
  q ai.user_quota_daily;
  m ai.rate_minutes;
  tm timestamptz;
  d date;
  b timestamptz;
  ca bigint;
  pa bigint;
  cd bigint;
  rid bigint;
  tries integer := 0;
  cn text;
begin
  u = common.service_user (p_input);
  select
    *
  into
    c
  from
    ai.runtime_control
  where
    id = 1
  for update;
  tm = common.now();
  d = (tm at time zone 'UTC')::date;
  b = date_trunc('minute', tm);
  if p_input ->> 'request_fingerprint' is null or p_input ->> 'request_fingerprint' !~ '^[a-f0-9]{64}$' then
    perform
      common.fail ('INVALID_REQUEST', 'INVALID_FINGERPRINT');
  end if;
  select
    *
  into
    r
  from
    ai.requests
  where
    owner_auth_user_id = u
    and client_request_key = (p_input ->> 'client_request_key')::uuid;
  if r.id is not null then
    if r.request_fingerprint <> p_input ->> 'request_fingerprint' then
      perform
        common.fail ('CONFLICT', 'IDEMPOTENCY_MISMATCH');
    end if;
    return jsonb_build_object('request_id', r.external_id, 'state', r.state, 'replayed', true, 'quota', ai.quota (u));
  end if;
  if not c.enabled or not ai.allowed (u) then
    perform
      common.fail ('UNAVAILABLE', 'DISABLED');
  end if;
  perform
    common.require_terms (u);
  if p_input ->> 'expected_control_revision' is distinct from c.revision::text then
    perform
      common.fail ('CONFLICT', 'CONFIG_CHANGED');
  end if;
  select
    *
  into
    x
  from
    ai.configurations
  where
    id = (p_input ->> 'config_id')::bigint;
  if x.id is null or not x.enabled or not ai.configuration_ready (x.id) or p_input ->> 'expected_config_revision' is distinct from x.revision::text or not exists (
    select
      1
    from
      ai.routing_rule_configurations
    where
      rule_id = ai.current_rule (tm) and config_id = x.id) then
    perform
      common.fail ('CONFLICT', 'OPTION_UNAVAILABLE');
  end if;
  select
    id
  into
    cd
  from
    legal.documents
  where
    kind = 'AI_COMMON'
    and enabled;
  ca = legal.acceptance_for (u, cd, (p_input ->> 'common_document_audit_id')::bigint);
  pa = legal.acceptance_for (u, x.legal_document_id, (p_input ->> 'provider_document_audit_id')::bigint);
  if ca is null or pa is null then
    perform
      common.fail ('FORBIDDEN', 'CONSENT_REQUIRED');
  end if;
  insert into ai.user_quota_daily (auth_user_id, day)
    values (u, d)
  on conflict
    do nothing;
  select
    *
  into
    q
  from
    ai.user_quota_daily
  where
    auth_user_id = u
    and day = d
  for update;
  if q.reserved_count + q.charged_count >= c.user_daily_limit then
    perform
      common.fail ('QUOTA_EXCEEDED', 'USER_DAILY_LIMIT');
  end if;
  insert into ai.rate_minutes (auth_user_id, minute_bucket)
    values (u, b)
  on conflict
    do nothing;
  select
    *
  into
    m
  from
    ai.rate_minutes
  where
    auth_user_id = u
    and minute_bucket = b
  for update;
  if m.request_count >= c.user_minute_limit then
    perform
      common.fail ('RATE_LIMITED', 'USER_MINUTE_LIMIT');
  end if;
  loop
    begin
      insert into ai.requests (owner_auth_user_id, client_request_key, request_fingerprint, control_revision, reserve_day, time_reserved, time_progress)
        values (u, (p_input ->> 'client_request_key')::uuid, p_input ->> 'request_fingerprint', c.revision, d, tm, tm)
      returning
        *
      into
        r;
      exit;
    exception
      when unique_violation then
        get stacked diagnostics cn = constraint_name;
        tries = tries + 1;
        if cn <> 'uq_ai_requests_external_id' or tries >= 5 then
          raise;
          end if;
    end;
  end loop;
  select
    audit_id
  into
    rid
  from
    audit.configurations
  where
    id = x.id
    and revision = x.revision
  order by
    audit_id desc
  limit 1;
insert into ai.request_snapshots (request_id, config_id, config_audit_id, config_name, config_display_name, config_revision, adapter_id, execution_contract, endpoint_url, model_id, credential_ref, currency, input_standard_nanos_per_million, input_cache_read_nanos_per_million, input_cache_write_nanos_per_million, output_nanos_per_million, common_acceptance_audit_id, provider_acceptance_audit_id)
select
  r.id,
  x.id,
  rid,
  x.name,
  x.display_name,
  x.revision,
  x.adapter_id,
  ai.execution_contract (x.adapter_id),
  x.endpoint_url,
  x.model_id,
  x.credential_ref,
  p.currency,
  p.input_standard_nanos_per_million,
  p.input_cache_read_nanos_per_million,
  p.input_cache_write_nanos_per_million,
  p.output_nanos_per_million,
  ca,
  pa
from
  ai.prices p
where
  config_id = x.id;
  update
    ai.user_quota_daily
  set
    reserved_count = reserved_count + 1
  where
    auth_user_id = u
    and day = d;
    update
      ai.rate_minutes
    set
      request_count = request_count + 1
    where
      auth_user_id = u
      and minute_bucket = b;
      return jsonb_build_object('request_id', r.external_id, 'state', r.state, 'replayed', false, 'quota', ai.quota (u));
end
$$;
create function public.ai_execution_snapshot (p_input jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  r ai.requests;
  s ai.request_snapshots;
  d audit.acceptances;
begin
  r = ai.lock_request (p_input);
  select
    *
  into
    s
  from
    ai.request_snapshots
  where
    request_id = r.id;
  select
    *
  into
    d
  from
    audit.acceptances
  where
    audit_id = s.provider_acceptance_audit_id;
  return common.api_json (jsonb_build_object('request_id', r.external_id, 'state', r.state, 'config_id', s.config_id, 'config_name', s.config_name, 'config_display_name', s.config_display_name, 'config_revision', s.config_revision, 'adapter_id', s.adapter_id, 'execution_contract', s.execution_contract, 'endpoint_url', s.endpoint_url, 'model_id', s.model_id, 'credential_ref', s.credential_ref, 'price', jsonb_build_object('currency', s.currency, 'input_standard_nanos_per_million', s.input_standard_nanos_per_million, 'input_cache_read_nanos_per_million', s.input_cache_read_nanos_per_million, 'input_cache_write_nanos_per_million', s.input_cache_write_nanos_per_million, 'output_nanos_per_million', s.output_nanos_per_million), 'common_acceptance_audit_id', s.common_acceptance_audit_id, 'provider_acceptance_audit_id', s.provider_acceptance_audit_id, 'provider_document_id', d.document_id, 'provider_document_audit_id', d.document_audit_id, 'time_canceled', r.time_canceled, 'attempts', coalesce((
        select
          jsonb_agg(jsonb_build_object('attempt_no', attempt_no, 'state', state, 'retry_allowed', retry_allowed, 'transmitted', transmitted)
        order by attempt_no)
        from ai.attempts
        where
          request_id = r.id), '[]')));
end
$$;
create function public.ai_attempt_start (p_input jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  r ai.requests;
  c ai.runtime_control;
  a ai.attempts;
  n smallint := (p_input ->> 'attempt_no')::smallint;
  tm timestamptz;
  d date;
  g bigint;
begin
  perform
    common.service_user (p_input);
  select
    *
  into
    c
  from
    ai.runtime_control
  where
    id = 1
  for update;
  r = ai.lock_request (p_input);
  tm = common.now();
  d = (tm at time zone 'UTC')::date;
  select
    *
  into
    a
  from
    ai.attempts
  where
    request_id = r.id
    and attempt_no = n;
  if a.request_id is not null then
    return jsonb_build_object('request_id', r.external_id, 'attempt_no', n, 'state', a.state, 'may_transmit', false);
  end if;
  if n not in (1, 2) or n is null then
    perform
      common.fail ('INVALID_REQUEST', 'INVALID_ATTEMPT');
  end if;
  if not c.enabled or not ai.allowed (r.owner_auth_user_id) or r.time_canceled is not null or r.state = 'FINALIZED' then
    perform
      common.fail ('UNAVAILABLE', 'ADMISSION_CLOSED');
  end if;
  if n = 2 and not exists (
    select
      1
    from
      ai.attempts
    where
      request_id = r.id and attempt_no = 1 and state in ('FAILED_UPSTREAM', 'TIMED_OUT', 'INVALID_OUTPUT') and retry_allowed = true and transmitted is not null) or n = 1 and exists (
  select
    1
  from
    ai.attempts
  where
    request_id = r.id) then
    perform
      common.fail ('CONFLICT', 'INVALID_ATTEMPT_ORDER');
  end if;
  if n = 1 then
    insert into ai.global_quota_daily (day)
      values (d)
    on conflict
      do nothing;
    select
      admitted_count
    into
      g
    from
      ai.global_quota_daily
    where
      day = d
    for update;
    if g >= c.global_daily_limit then
      perform
        common.fail ('QUOTA_EXCEEDED', 'GLOBAL_DAILY_LIMIT');
    end if;
    update
      ai.global_quota_daily
    set
      admitted_count = admitted_count + 1
    where
      day = d;
    update
      ai.requests
    set
      provider_admission_day = d
    where
      id = r.id;
  end if;
  insert into ai.attempts (request_id, attempt_no, time_started)
    values (r.id, n, tm);
  update
    ai.requests
  set
    state = 'RUNNING',
    time_progress = tm
  where
    id = r.id;
  return jsonb_build_object('request_id', r.external_id, 'attempt_no', n, 'state', 'STARTED', 'may_transmit', true);
end
$$;
create function public.ai_attempt_complete (p_input jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  r ai.requests;
  a ai.attempts;
  s ai.request_snapshots;
  u jsonb := p_input -> 'usage';
  n smallint := (p_input ->> 'attempt_no')::smallint;
  st text := p_input ->> 'state';
  it bigint;
  ins bigint;
  cr bigint;
  cw bigint;
  o bigint;
  re bigint;
  num numeric := 0;
  known bigint;
  fullcost bigint;
  incomplete boolean := false;
  overflowed boolean := false;
  dig text;
  bill boolean;
begin
  r = ai.lock_request (p_input, false);
  select
    *
  into
    a
  from
    ai.attempts
  where
    request_id = r.id
    and attempt_no = n
  for update;
  if a.request_id is null then
    perform
      common.fail ('NOT_FOUND', 'ATTEMPT_NOT_FOUND');
  end if;
  dig = common.digest(p_input - 'contract_code' - 'database_instance_id' - 'owner_auth_user_id');
  if a.state <> 'STARTED' then
    if a.fact_digest is distinct from dig then
      perform
        common.fail ('CONFLICT', 'TERMINAL_FACT_CHANGED');
    end if;
    return jsonb_build_object('request_id', r.external_id, 'attempt_no', n, 'state', a.state, 'replayed', true);
  end if;
  if (st = 'SUCCEEDED' and (p_input ->> 'transmitted')::boolean is distinct from true) or ((p_input ->> 'transmitted')::boolean = false and (p_input ->> 'provider_billable')::boolean = true) or st is null or st not in ('SUCCEEDED', 'CANCELED', 'FAILED_UPSTREAM', 'TIMED_OUT', 'INVALID_OUTPUT', 'UNKNOWN') or jsonb_typeof(u) <> 'object' or jsonb_typeof(p_input -> 'retry_allowed') <> 'boolean' or jsonb_typeof(p_input -> 'usage_complete') <> 'boolean' then
    perform
      common.fail ('INVALID_REQUEST', 'INVALID_ATTEMPT_FACT');
  end if;
  it = (u ->> 'input_total')::bigint;
  ins = (u ->> 'input_standard')::bigint;
  cr = (u ->> 'cache_read')::bigint;
  cw = (u ->> 'cache_write')::bigint;
  o = (u ->> 'output')::bigint;
  re = (u ->> 'reasoning')::bigint;
  if least (it, ins, cr, cw, o, re) < 0 or re > o or (it is not null and coalesce(ins, 0)::numeric + coalesce(cr, 0) + coalesce(cw, 0) > it) or (it is not null and ins is not null and cr is not null and cw is not null and ins::numeric + cr + cw <> it) then
    perform
      common.fail ('INVALID_REQUEST', 'INCONSISTENT_USAGE');
  end if;
  if (p_input ->> 'usage_complete')::boolean and (it is null or ins is null or cr is null or o is null) then
    perform
      common.fail ('INVALID_REQUEST', 'INCOMPLETE_USAGE_MARKED_COMPLETE');
  end if;
  select
    *
  into
    s
  from
    ai.request_snapshots
  where
    request_id = r.id;
  bill = (p_input ->> 'provider_billable')::boolean;
  if bill = false then
    known = 0;
    fullcost = 0;
    incomplete = false;
  else
    num = coalesce(ins, 0)::numeric * s.input_standard_nanos_per_million + coalesce(cr, 0)::numeric * s.input_cache_read_nanos_per_million + coalesce(cw, 0)::numeric * s.input_cache_write_nanos_per_million + coalesce(o, 0)::numeric * s.output_nanos_per_million;
    incomplete = not (p_input ->> 'usage_complete')::boolean
      or (ins is null
        and s.input_standard_nanos_per_million > 0)
      or (cr is null
        and s.input_cache_read_nanos_per_million > 0)
      or (cw is null
        and s.input_cache_write_nanos_per_million > 0)
      or (o is null
        and s.output_nanos_per_million > 0)
      or bill is null;
    if ceil(num / 1000000) > 9223372036854775807::numeric then
      overflowed = true;
      incomplete = true;
      known = null;
      fullcost = null;
    else
      known = case when bill is null then
        0
      else
        ceil(num / 1000000)::bigint
      end;
      fullcost = case when incomplete then
        null
      else
        known
      end;
    end if;
  end if;
  update
    ai.attempts
  set
    state = st,
    time_terminal = common.now(),
    transmitted = (p_input ->> 'transmitted')::boolean,
    provider_billable = bill,
    retry_allowed = case when st in ('UNKNOWN', 'SUCCEEDED', 'CANCELED')
      or p_input ->> 'transmitted' is null then
      false
    else
      (p_input ->> 'retry_allowed')::boolean
    end,
    usage_complete = (p_input ->> 'usage_complete')::boolean,
    input_total = it,
    input_standard = ins,
    cache_read = cr,
    cache_write = cw,
    output = o,
    reasoning = re,
    estimated_cost_nanos = fullcost,
    known_estimated_cost_nanos = known,
    cost_incomplete = incomplete,
    cost_overflow = overflowed,
    fact_digest = dig
  where
    request_id = r.id
    and attempt_no = n;
  update
    ai.requests
  set
    time_progress = common.now(),
    time_canceled = case when st = 'CANCELED' then
      coalesce(time_canceled, common.now())
    else
      time_canceled
    end
  where
    id = r.id;
  return jsonb_build_object('request_id', r.external_id, 'attempt_no', n, 'state', st, 'replayed', false);
end
$$;
create function ai.finalize_locked (p_id bigint)
  returns ai.requests
  language plpgsql
  set search_path = ''
  as $$
declare
  r ai.requests;
  s ai.request_snapshots;
  n integer;
  bad boolean;
  success boolean;
  trans boolean;
  invalid boolean;
  usagebad integer;
  costbad integer;
  ins numeric;
  outs numeric;
  cost numeric;
begin
  select
    *
  into
    r
  from
    ai.requests
  where
    id = p_id
  for update;
  if r.state = 'FINALIZED' then
    return r;
  end if;
  select
    count(*),
    coalesce(bool_or(state in ('STARTED', 'UNKNOWN')
        or transmitted is null), false),
    coalesce(bool_or(state = 'SUCCEEDED'), false),
    coalesce(bool_or(transmitted = true), false),
    coalesce(bool_or(state = 'INVALID_OUTPUT'), false),
    count(*) filter (where not coalesce(usage_complete, false)),
    count(*) filter (where cost_incomplete
      or known_estimated_cost_nanos is null),
    sum(coalesce(input_total, 0)::numeric),
    sum(coalesce(output, 0)::numeric),
    sum(coalesce(known_estimated_cost_nanos, 0)::numeric)
  into
    n,
    bad,
    success,
    trans,
    invalid,
    usagebad,
    costbad,
    ins,
    outs,
    cost
  from
    ai.attempts
  where
    request_id = r.id;
  if bad then
    update
      ai.requests
    set
      state = 'HELD'
    where
      id = r.id
    returning
      *
    into
      r;
    return r;
  end if;
  r.outcome = case when n = 0 then
    'RELEASED'
  when r.time_canceled is not null then
    'CANCELED'
  when success then
    'SUCCEEDED'
  when invalid then
    'INVALID_OUTPUT'
  else
    'FAILED_UPSTREAM'
  end;
  r.charged = success
    or (r.time_canceled is not null
      and trans);
  update
    ai.requests
  set
    state = 'FINALIZED',
    outcome = r.outcome,
    charged = r.charged,
    time_finalized = common.now(),
    time_progress = common.now()
  where
    id = r.id
  returning
    *
  into
    r;
  if r.owner_auth_user_id is not null then
    update
      ai.user_quota_daily
    set
      reserved_count = reserved_count - 1,
      charged_count = charged_count + case when r.charged then
        1
      else
        0
      end
    where
      auth_user_id = r.owner_auth_user_id
      and day = r.reserve_day;
  end if;
  select
    *
  into
    s
  from
    ai.request_snapshots
  where
    request_id = r.id;
  insert into ai.configuration_usage_daily (day, config_audit_id, currency, settled_count, succeeded_count, failed_count, canceled_count, released_count, attempt_count, input_tokens, output_tokens, known_estimated_cost_nanos, incomplete_usage_count, incomplete_cost_count)
    values (r.reserve_day, s.config_audit_id, s.currency, 1, (r.outcome = 'SUCCEEDED')::integer, (r.outcome in ('FAILED_UPSTREAM', 'INVALID_OUTPUT'))::integer, (r.outcome = 'CANCELED')::integer, (r.outcome = 'RELEASED')::integer, n, least (coalesce(ins, 0), 9223372036854775807)::bigint, least (coalesce(outs, 0), 9223372036854775807)::bigint, least (coalesce(
          cost, 0), 9223372036854775807)::bigint, (usagebad > 0)::integer, (costbad > 0
        or coalesce(
          cost, 0) > 9223372036854775807)::integer)
  on conflict (day, config_audit_id, currency)
    do update set
      settled_count = ai.configuration_usage_daily.settled_count + 1,
      succeeded_count = ai.configuration_usage_daily.succeeded_count + excluded.succeeded_count,
      failed_count = ai.configuration_usage_daily.failed_count + excluded.failed_count,
      canceled_count = ai.configuration_usage_daily.canceled_count + excluded.canceled_count,
      released_count = ai.configuration_usage_daily.released_count + excluded.released_count,
      attempt_count = ai.configuration_usage_daily.attempt_count + excluded.attempt_count,
      input_tokens = least (ai.configuration_usage_daily.input_tokens::numeric + excluded.input_tokens, 9223372036854775807)::bigint,
      output_tokens = least (ai.configuration_usage_daily.output_tokens::numeric + excluded.output_tokens, 9223372036854775807)::bigint,
      known_estimated_cost_nanos = least (ai.configuration_usage_daily.known_estimated_cost_nanos::numeric + excluded.known_estimated_cost_nanos, 9223372036854775807)::bigint,
      incomplete_usage_count = ai.configuration_usage_daily.incomplete_usage_count + excluded.incomplete_usage_count,
      incomplete_cost_count = ai.configuration_usage_daily.incomplete_cost_count + excluded.incomplete_cost_count + case when ai.configuration_usage_daily.known_estimated_cost_nanos::numeric + excluded.known_estimated_cost_nanos > 9223372036854775807 then
        1
      else
        0
      end;
  return r;
end
$$;
create function public.ai_finalize (p_input jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  r ai.requests;
begin
  r = ai.lock_request (p_input, false);
  r = ai.finalize_locked (r.id);
  return jsonb_build_object('request_id', r.external_id, 'state', r.state, 'outcome', r.outcome, 'charged', r.charged, 'quota', ai.quota (r.owner_auth_user_id));
end
$$;
create function public.ai_cancel (p_input jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  r ai.requests;
begin
  r = ai.lock_request (p_input);
  if r.state = 'FINALIZED' then
    return jsonb_build_object('request_id', r.external_id, 'state', r.state, 'time_canceled', r.time_canceled, 'quota', ai.quota (r.owner_auth_user_id));
  end if;
  update
    ai.requests
  set
    time_canceled = coalesce(time_canceled, common.now())
  where
    id = r.id
  returning
    *
  into
    r;
  r = ai.finalize_locked (r.id);
  return jsonb_build_object('request_id', r.external_id, 'state', r.state, 'time_canceled', r.time_canceled, 'quota', ai.quota (r.owner_auth_user_id));
end
$$;
-- Final-state graph check runs after RPC role restoration at COMMIT.
create function ai.validate_rule_graph ()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  i bigint;
begin
  if tg_table_name = 'routing_rules' then
    i = case when tg_op = 'DELETE' then
      old.id
    else
      new.id
    end;
  else
    i = case when tg_op = 'DELETE' then
      old.rule_id
    else
      new.rule_id
    end;
  end if;
  if exists (
    select
      1
    from
      ai.routing_rules
    where
      id = i
      and enabled)
    and (
      select
        count(*)
      from
        ai.routing_rule_configurations
      where
        rule_id = i
        and is_default) <> 1 then
    perform
      common.fail ('INVALID_REQUEST', 'EXACTLY_ONE_DEFAULT_REQUIRED');
end if;
  return null;
end
$$;
create constraint trigger complete_rule
  after insert or update on ai.routing_rules deferrable initially deferred for each row
  execute function ai.validate_rule_graph ();
create constraint trigger complete_rule_members
  after insert or update or delete on ai.routing_rule_configurations deferrable initially deferred for each row
  execute function ai.validate_rule_graph ();
revoke all on function ai.validate_rule_graph () from public, anon, authenticated, service_role;
grant create on schema ai to app_api_owner;
alter function ai.validate_rule_graph () owner to app_api_owner;
revoke create on schema ai from app_api_owner;
commit;
