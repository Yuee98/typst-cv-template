begin;
set local search_path = '';
create function common.jwt ()
  returns jsonb
  language sql
  stable
  security invoker
  set search_path = '' as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb, '{}'::jsonb) $$;
create function common.uid ()
  returns uuid
  language sql
  stable
  security invoker
  set search_path = '' as $$select nullif(common.jwt()->>'sub','')::uuid$$;
create function common.auth_user_active (p_user uuid)
  returns boolean
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    exists (
      select
        1
      from
        auth.users
      where
        id = p_user
        and deleted_at is null
        and (banned_until is null
          or banned_until < clock_timestamp()))
$$;
create function common.auth_session_valid (p_user uuid, p_session uuid)
  returns boolean
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    exists (
      select
        1
      from
        auth.sessions
      where
        id = p_session
        and user_id = p_user
        and (not_after is null
          or not_after > clock_timestamp()))
$$;
create function common.auth_user_page (p_limit integer, p_after text)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = ''
  as $$
  select
    coalesce(jsonb_agg(jsonb_build_object('auth_user_id', id, 'email', email, 'deleted_at', deleted_at, 'banned_until', banned_until)), '[]')
  from (
    select
      id,
      email,
      deleted_at,
      banned_until
    from
      auth.users
    where (p_after is null
      or id::text > p_after)
    and p_limit between 1 and 100
  order by
    id
  limit greatest (0, least (p_limit, 100))) x
$$;
create function common.user_id ()
  returns uuid
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  u uuid := common.uid ();
begin
  if u is null or not common.auth_user_active (u) then
    perform
      common.fail ('UNAUTHORIZED');
  end if;
  return u;
end
$$;
create function common.service_user (p_input jsonb)
  returns uuid
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  u uuid;
begin
  perform
    common.guard (p_input);
    u = (p_input ->> 'owner_auth_user_id')::uuid;
    if u is null or not common.auth_user_active (u) then
      perform
        common.fail ('UNAUTHORIZED');
    end if;
    return u;
end
$$;
create function common.admin_id ()
  returns uuid
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  u uuid;
  j jsonb;
begin
  perform
    1
  from
    admin.environment
  where
    id = 1
  for update;
  u = common.user_id ();
  j = common.jwt ();
  perform
    1
  from
    admin.members
  where
    auth_user_id = u
    and time_revoked is null
  for update;
  if not found then
    perform
      common.fail ('FORBIDDEN', 'ADMIN_REQUIRED');
  end if;
  if not common.auth_session_valid (u, (j ->> 'session_id')::uuid) then
    perform
      common.fail ('UNAUTHORIZED', 'SESSION_EXPIRED');
  end if;
  return u;
end
$$;
create function common.client_user (p_input jsonb)
  returns uuid
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
declare
  u uuid := common.user_id ();
begin
  if p_input ->> 'expected_auth_user_id' is distinct from u::text then
    perform
      common.fail ('CLIENT_UPDATE_REQUIRED', 'ACCOUNT_CHANGED');
  end if;
  return u;
end
$$;
create function common.matches_schema (p_value jsonb, p_schema jsonb)
  returns boolean
  language plpgsql
  immutable
  security invoker
  set search_path = ''
  as $$
declare
  k text;
  v jsonb;
  t text := p_schema ->> 'type';
begin
  if p_value is null then
    return false;
  end if;
  if p_schema ? 'const' and p_value <> p_schema -> 'const' then
    return false;
  end if;
  if p_schema ? 'enum' and not exists (
    select
      1
    from
      jsonb_array_elements(p_schema -> 'enum') x
    where
      x = p_value) then
    return false;
  end if;
  if t = 'object' then
    if jsonb_typeof(p_value) <> 'object' then
      return false;
    end if;
    for k in
    select
      jsonb_array_elements_text(coalesce(p_schema -> 'required', '[]'))
      loop
        if not p_value ? k then
          return false;
        end if;
      end loop;
    for k in
    select
      jsonb_object_keys(p_value)
      loop
        if not (p_schema -> 'properties') ? k then
          if p_schema -> 'additionalProperties' = 'false'::jsonb then
            return false;
          end if;
        elsif not common.matches_schema (p_value -> k, p_schema -> 'properties' -> k) then
          return false;
        end if;
      end loop;
  elsif t = 'array' then
    if jsonb_typeof(p_value) <> 'array' then
      return false;
    end if;
    for v in
    select
      *
    from
      jsonb_array_elements(p_value)
      loop
        if not common.matches_schema (v, p_schema -> 'items') then
          return false;
        end if;
      end loop;
  elsif t = 'integer' then
    if jsonb_typeof(p_value) <> 'number' or p_value::numeric <> trunc(p_value::numeric) then
      return false;
    end if;
  elsif t is not null
      and jsonb_typeof(p_value) <> t then
      return false;
  end if;
  if p_schema ? 'minLength' and length(p_value #>> '{}') < (p_schema ->> 'minLength')::integer then
    return false;
  end if;
  return true;
end
$$;
create function common.cv_schema ()
  returns jsonb
  language sql
  immutable
  security invoker
  set search_path = ''
  as $schema$
  select
    '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"schemaVersion":{"type":"number","const":7},"sectionOrder":{"type":"array","items":{"type":"string","enum":["profile","skills","experience","education","research","publications","additional"]}},"typstLang":{"type":"string","enum":["zh","en"]},"bodyFont":{"type":"string"},"header":{"type":"object","properties":{"name":{"type":"string"},"subtitle":{"type":"string"},"email":{"type":"string"},"phone":{"type":"string"},"selfName":{"type":"string"}},"required":["name","subtitle","email","phone","selfName"],"additionalProperties":false},"sectionTitles":{"type":"object","properties":{"profile":{"type":"object","properties":{"title":{"type":"string"},"isDisplay":{"type":"boolean"},"pageBreakBefore":{"type":"boolean"}},"required":["title","isDisplay","pageBreakBefore"],"additionalProperties":false},"skills":{"type":"object","properties":{"title":{"type":"string"},"isDisplay":{"type":"boolean"},"pageBreakBefore":{"type":"boolean"}},"required":["title","isDisplay","pageBreakBefore"],"additionalProperties":false},"experience":{"type":"object","properties":{"title":{"type":"string"},"isDisplay":{"type":"boolean"},"pageBreakBefore":{"type":"boolean"}},"required":["title","isDisplay","pageBreakBefore"],"additionalProperties":false},"education":{"type":"object","properties":{"title":{"type":"string"},"isDisplay":{"type":"boolean"},"pageBreakBefore":{"type":"boolean"}},"required":["title","isDisplay","pageBreakBefore"],"additionalProperties":false},"research":{"type":"object","properties":{"title":{"type":"string"},"isDisplay":{"type":"boolean"},"pageBreakBefore":{"type":"boolean"}},"required":["title","isDisplay","pageBreakBefore"],"additionalProperties":false},"publications":{"type":"object","properties":{"title":{"type":"string"},"isDisplay":{"type":"boolean"},"pageBreakBefore":{"type":"boolean"}},"required":["title","isDisplay","pageBreakBefore"],"additionalProperties":false},"additional":{"type":"object","properties":{"title":{"type":"string"},"isDisplay":{"type":"boolean"},"pageBreakBefore":{"type":"boolean"}},"required":["title","isDisplay","pageBreakBefore"],"additionalProperties":false}},"required":["profile","skills","experience","education","research","publications","additional"],"additionalProperties":false},"profile":{"type":"array","items":{"type":"object","properties":{"body":{"type":"string"}},"required":["body"],"additionalProperties":false}},"skills":{"type":"array","items":{"type":"object","properties":{"label":{"type":"string"},"body":{"type":"string"}},"required":["label","body"],"additionalProperties":false}},"experience":{"type":"array","items":{"type":"object","properties":{"org":{"type":"string"},"date":{"type":"string"},"projects":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"},"detail":{"type":"string"},"date":{"type":"string"},"bullets":{"type":"array","items":{"type":"object","properties":{"body":{"type":"string"}},"required":["body"],"additionalProperties":false}}},"required":["title","detail","date","bullets"],"additionalProperties":false}}},"required":["org","date","projects"],"additionalProperties":false}},"education":{"type":"array","items":{"type":"object","properties":{"org":{"type":"string"},"title":{"type":"string"},"detail":{"type":"string"},"date":{"type":"string"},"bullets":{"type":"array","items":{"type":"object","properties":{"body":{"type":"string"}},"required":["body"],"additionalProperties":false}}},"required":["org","title","detail","date","bullets"],"additionalProperties":false}},"research":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"},"date":{"type":"string"},"bullets":{"type":"array","items":{"type":"object","properties":{"body":{"type":"string"}},"required":["body"],"additionalProperties":false}}},"required":["title","date","bullets"],"additionalProperties":false}},"publications":{"type":"array","items":{"type":"object","properties":{"authors":{"type":"string"},"title":{"type":"string"},"venue":{"type":"string"},"year":{"type":"string"},"url":{"type":"string"}},"required":["authors","title","venue","year","url"],"additionalProperties":false}},"additional":{"type":"array","items":{"type":"object","properties":{"label":{"type":"string"},"body":{"type":"string"}},"required":["label","body"],"additionalProperties":false}}},"required":["schemaVersion","sectionOrder","typstLang","header","sectionTitles","profile","skills","experience","education","research","publications","additional"],"additionalProperties":false}'::jsonb
$schema$;
create function common.cv_payload (p_input jsonb)
  returns void
  language plpgsql
  stable
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  d jsonb;
  k text;
begin
  perform
    common.required (p_input, array['storage_mode', 'document_schema_version']);
    if p_input ->> 'document_schema_version' <> '7' then
      perform
        common.fail ('INVALID_REQUEST', 'UNSUPPORTED_CV_FORMAT');
    end if;
    if p_input ->> 'storage_mode' = 'PLAIN' then
      d = p_input -> 'data';
      if not common.matches_schema (d, common.cv_schema ()) then
        perform
          common.fail ('INVALID_REQUEST', 'INVALID_CV');
      end if;
      if d is null or jsonb_typeof(d) <> 'object' or d ->> 'schemaVersion' is distinct from '7' or d ->> 'typstLang' not in ('zh', 'en') or jsonb_typeof(d -> 'header') is distinct from 'object' or jsonb_typeof(d -> 'sectionTitles') is distinct from 'object' then
        perform
          common.fail ('INVALID_REQUEST', 'INVALID_CV');
      end if;
      foreach k in array array['sectionOrder', 'profile', 'skills', 'experience', 'education', 'research', 'publications', 'additional'] loop
        if jsonb_typeof(d -> k) is distinct from 'array' then
          perform
            common.fail ('INVALID_REQUEST', 'INVALID_CV_' || k);
        end if;
      end loop;
      if p_input -> 'encrypted_payload' is not null and p_input -> 'encrypted_payload' <> 'null'::jsonb then
        perform
          common.fail ('INVALID_REQUEST', 'EXCLUSIVE_PAYLOAD');
      end if;
    elsif p_input ->> 'storage_mode' = 'ENCRYPTED' then
      d = p_input -> 'encrypted_payload';
      if jsonb_typeof(d) is distinct from 'object' or jsonb_typeof(d -> 'version') is distinct from 'number' or jsonb_typeof(d -> 'iterations') is distinct from 'number' or exists (
        select
          1
        from
          jsonb_object_keys(d)
          key
        where
          key not in ('version', 'algorithm', 'kdf', 'iterations', 'salt', 'iv', 'ciphertext')) or d ->> 'version' is distinct from '1' or d ->> 'algorithm' is distinct from 'AES-GCM' or d ->> 'kdf' is distinct from 'PBKDF2-SHA-256' or not (d ->> 'iterations' ~ '^[1-9][0-9]*$') then
        perform
          common.fail ('INVALID_REQUEST', 'INVALID_ENCRYPTION_ENVELOPE');
      end if;
      foreach k in array array['salt', 'iv', 'ciphertext'] loop
        if jsonb_typeof(d -> k) is distinct from 'string' or length(d ->> k) = 0 then
          perform
            common.fail ('INVALID_REQUEST', 'INVALID_ENCRYPTION_ENVELOPE');
        end if;
      end loop;
      if p_input -> 'data' is not null and p_input -> 'data' <> 'null'::jsonb then
        perform
          common.fail ('INVALID_REQUEST', 'EXCLUSIVE_PAYLOAD');
      end if;
    else
      perform
        common.fail ('INVALID_REQUEST', 'INVALID_STORAGE_MODE');
    end if;
    if octet_length(d::text) > 2097152 then
      perform
        common.fail ('INVALID_REQUEST', 'PAYLOAD_TOO_LARGE');
    end if;
end
$$;
create function common.auth_user_exists (p_user uuid)
  returns boolean
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    exists (
      select
        1
      from
        auth.users
      where
        id = p_user)
$$;
comment on function common.auth_user_exists (uuid) is 'Private postgres-owned fixed-UUID existence projection used only by irreversible Auth-deletion anonymization.';
create function common.now ()
  returns timestamptz
  language sql
  volatile
  security invoker
  set search_path = ''
  as $$
  select
    clock_timestamp()
$$;
create function common.guard (p_input jsonb)
  returns void
  language plpgsql
  stable
  security invoker
  set search_path = ''
  as $$
declare
  e admin.environment;
begin
  select
    *
  into
    e
  from
    admin.environment
  where
    id = 1;
  if not found then
    perform
      common.fail ('NOT_READY', 'ENVIRONMENT_NOT_INITIALIZED');
  end if;
  if p_input ->> 'contract_code' is distinct from e.contract_code or p_input ->> 'database_instance_id' is distinct from e.database_instance_id::text then
    perform
      common.fail ('CLIENT_UPDATE_REQUIRED', 'DATABASE_INSTANCE_OR_CONTRACT_CHANGED');
  end if;
end
$$;
create function common.api_json (p_value jsonb)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = ''
  as $$
declare
  r jsonb := '{}'::jsonb;
  v record;
  k text;
begin
  if jsonb_typeof(p_value) = 'array' then
    select
      coalesce(jsonb_agg(common.api_json (value)), '[]')
    into
      r
    from
      jsonb_array_elements(p_value);
    return r;
  elsif jsonb_typeof(p_value) = 'object' then
    for v in
    select
      *
    from
      jsonb_each(p_value)
      loop
        k = v.key;
        if jsonb_typeof(v.value) = 'number' and k not in ('adapter_id', 'weekday', 'start_minute', 'end_minute', 'attempt_no', 'cv_schema_version', 'encrypted_envelope_version', 'days') then
          r = r || jsonb_build_object(k, v.value #>> '{}');
        else
          r = r || jsonb_build_object(k, common.api_json (v.value));
        end if;
      end loop;
    return r;
  end if;
  return p_value;
end
$$;
create function common.require_terms (p_user uuid)
  returns void
  language plpgsql
  stable
  security invoker
  set search_path = ''
  as $$
begin
  if not exists (
    select
      1
    from
      legal.documents d
      join legal.acceptances a on a.document_id = d.id
        and a.owner_auth_user_id = p_user
      join audit.documents h on h.audit_id = a.document_audit_id
    where
      d.kind = 'TERMS'
      and d.enabled
      and h.enabled
      and h.content_digest = d.content_digest) then
  perform
    common.fail ('FORBIDDEN', 'TERMS_REQUIRED');
end if;
end
$$;
create function common.audit_context (p_operation bigint, p_actor uuid, p_reason text, p_kind text default 'USER')
  returns void
  language plpgsql
  volatile
  security invoker
  set search_path = '' as $$ begin perform set_config('app.operation_id',coalesce(p_operation::text,''), true);
perform
  set_config('app.actor_id', coalesce(p_actor::text, ''), true);
perform
  set_config('app.actor_kind', p_kind, true);
perform
  set_config('app.reason', coalesce(p_reason, ''), true);
end $$;
create function common.reject_history_mutation ()
  returns trigger
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
declare
  before_row jsonb;
  after_row jsonb;
  k text;
  changed boolean := false;
begin
  if tg_op = 'UPDATE' then
    before_row = to_jsonb (old);
    after_row = to_jsonb (new);
    foreach k in array array['actor_auth_user_id', 'owner_auth_user_id', 'auth_user_id'] loop
      if before_row ? k and before_row -> k is distinct from after_row -> k then
        if before_row ->> k is null or after_row ->> k is not null or common.auth_user_exists ((before_row ->> k)::uuid) then
          perform
            common.fail ('INVALID_REQUEST', 'IMMUTABLE_HISTORY');
        end if;
        changed = true;
      end if;
      before_row = before_row - k;
      after_row = after_row - k;
    end loop;
    if changed and before_row = after_row then
      return new;
    end if;
  end if;
  perform
    common.fail ('INVALID_REQUEST', 'IMMUTABLE_HISTORY');
  return null;
end
$$;
create function common.anonymize_request ()
  returns trigger
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
begin
  if new.owner_auth_user_id is null then
    new.client_request_key = null;
    new.request_fingerprint = null;
  end if;
  return new;
end
$$;
create trigger anonymize_owner
  before update of owner_auth_user_id on ai.requests for each row
  execute function common.anonymize_request ();
create function common.touch ()
  returns trigger
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
begin
  if new.id <> old.id or (pg_catalog.to_jsonb (old) ? 'external_id' and pg_catalog.to_jsonb (new) ->> 'external_id' is distinct from pg_catalog.to_jsonb (old) ->> 'external_id') then
    perform
      common.fail ('INVALID_REQUEST', 'IMMUTABLE_ID');
  end if;
  new.time_updated = pg_catalog.clock_timestamp();
  new.revision = old.revision + 1;
  return new;
end
$$;
create trigger maintain_revision
  before update on cv.documents for each row
  execute function common.touch ();
create function audit.capture_configurations ()
  returns trigger
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
declare
  v ai.configurations;
  a bigint;
begin
  if tg_op = 'DELETE' then
    v = old;
  else
    v = new;
  end if;
  insert into audit.configurations (operation_id, actor_kind, actor_auth_user_id, reason, action, id, name, display_name, adapter_id, endpoint_url, model_id, credential_ref, legal_document_id, enabled, revision)
    values (nullif (current_setting('app.operation_id', true), '')::bigint, coalesce(nullif (current_setting('app.actor_kind', true), ''), 'MIGRATION'), case when common.auth_user_exists (nullif (current_setting('app.actor_id', true), '')::uuid) then nullif(current_setting('app.actor_id',true),'')::uuid
      end, coalesce(current_setting('app.reason', true), ''), tg_op, v.id, v.name, v.display_name, v.adapter_id, v.endpoint_url, v.model_id, v.credential_ref, v.legal_document_id, v.enabled, v.revision)
    returning
      audit_id
    into
      a;
  return coalesce(new, old);
end
$$;
create trigger record_history
  after insert or update or delete on ai.configurations for each row
  execute function audit.capture_configurations ();
create trigger immutable_history
  before update or delete on audit.configurations for each row
  execute function common.reject_history_mutation ();
create function audit.capture_prices ()
  returns trigger
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
declare
  v ai.prices;
  a bigint;
begin
  if tg_op = 'DELETE' then
    v = old;
  else
    v = new;
  end if;
  insert into audit.prices (operation_id, actor_kind, actor_auth_user_id, reason, action, config_id, currency, input_standard_nanos_per_million, input_cache_read_nanos_per_million, input_cache_write_nanos_per_million, output_nanos_per_million)
    values (nullif (current_setting('app.operation_id', true), '')::bigint,coalesce(nullif(current_setting('app.actor_kind',true),''), 'MIGRATION'), case when common.auth_user_exists (nullif (current_setting('app.actor_id', true), '')::uuid) then nullif(current_setting('app.actor_id',true),'')::uuid
    end, coalesce(current_setting('app.reason', true), ''), tg_op, v.config_id, v.currency, v.input_standard_nanos_per_million, v.input_cache_read_nanos_per_million, v.input_cache_write_nanos_per_million, v.output_nanos_per_million)
  returning
    audit_id
  into
    a;
  return coalesce(new, old);
end
$$;
create trigger record_history
  after insert or update or delete on ai.prices for each row
  execute function audit.capture_prices ();
create trigger immutable_history
  before update or delete on audit.prices for each row
  execute function common.reject_history_mutation ();
create function audit.capture_rules ()
  returns trigger
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
declare
  v ai.routing_rules;
  a bigint;
begin
  if tg_op = 'DELETE' then
    v = old;
  else
    v = new;
  end if;
  insert into audit.rules (operation_id, actor_kind, actor_auth_user_id, reason, action, id, weekday, start_minute, end_minute, enabled, revision)
    values (nullif (current_setting('app.operation_id', true), '')::bigint,coalesce(nullif(current_setting('app.actor_kind',true),''), 'MIGRATION'), case when common.auth_user_exists (nullif (current_setting('app.actor_id', true), '')::uuid) then nullif(current_setting('app.actor_id',true),'')::uuid
    end, coalesce(current_setting('app.reason', true), ''), tg_op, v.id, v.weekday, v.start_minute, v.end_minute, v.enabled, v.revision)
  returning
    audit_id
  into
    a;
  return coalesce(new, old);
end
$$;
create trigger record_history
  after insert or update or delete on ai.routing_rules for each row
  execute function audit.capture_rules ();
create trigger immutable_history
  before update or delete on audit.rules for each row
  execute function common.reject_history_mutation ();
create function audit.capture_rule_members ()
  returns trigger
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
declare
  v ai.routing_rule_configurations;
  a bigint;
begin
  if tg_op = 'DELETE' then
    v = old;
  else
    v = new;
  end if;
  insert into audit.rule_members (operation_id, actor_kind, actor_auth_user_id, reason, action, rule_id, config_id, is_default)
    values (nullif (current_setting('app.operation_id', true), '')::bigint,coalesce(nullif(current_setting('app.actor_kind',true),''), 'MIGRATION'), case when common.auth_user_exists (nullif (current_setting('app.actor_id', true), '')::uuid) then nullif(current_setting('app.actor_id',true),'')::uuid
    end, coalesce(current_setting('app.reason', true), ''), tg_op, v.rule_id, v.config_id, v.is_default)
  returning
    audit_id
  into
    a;
  return coalesce(new, old);
end
$$;
create trigger record_history
  after insert or update or delete on ai.routing_rule_configurations for each row
  execute function audit.capture_rule_members ();
create trigger immutable_history
  before update or delete on audit.rule_members for each row
  execute function common.reject_history_mutation ();
create function audit.capture_runtime_control ()
  returns trigger
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
declare
  v ai.runtime_control;
  a bigint;
begin
  if tg_op = 'DELETE' then
    v = old;
  else
    v = new;
  end if;
  insert into audit.runtime_control (operation_id, actor_kind, actor_auth_user_id, reason, action, id, enabled, audience, user_daily_limit, global_daily_limit, user_minute_limit, revision)
    values (nullif (current_setting('app.operation_id', true), '')::bigint,coalesce(nullif(current_setting('app.actor_kind',true),''), 'MIGRATION'), case when common.auth_user_exists (nullif (current_setting('app.actor_id', true), '')::uuid) then nullif(current_setting('app.actor_id',true),'')::uuid
    end, coalesce(current_setting('app.reason', true), ''), tg_op, v.id, v.enabled, v.audience, v.user_daily_limit, v.global_daily_limit, v.user_minute_limit, v.revision)
  returning
    audit_id
  into
    a;
  return coalesce(new, old);
end
$$;
create trigger record_history
  after insert or update or delete on ai.runtime_control for each row
  execute function audit.capture_runtime_control ();
create trigger immutable_history
  before update or delete on audit.runtime_control for each row
  execute function common.reject_history_mutation ();
create function audit.capture_allowed_users ()
  returns trigger
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
declare
  v ai.allowed_users;
  a bigint;
begin
  if tg_op = 'DELETE' then
    v = old;
  else
    v = new;
  end if;
  insert into audit.allowed_users (operation_id, actor_kind, actor_auth_user_id, reason, action, auth_user_id)
    values (nullif (current_setting('app.operation_id', true), '')::bigint,coalesce(nullif(current_setting('app.actor_kind',true),''), 'MIGRATION'), case when common.auth_user_exists (nullif (current_setting('app.actor_id', true), '')::uuid) then nullif(current_setting('app.actor_id',true),'')::uuid
    end, coalesce(current_setting('app.reason', true), ''), tg_op, case when common.auth_user_exists (v.auth_user_id) then
      v.auth_user_id
    end)
  returning
    audit_id
  into
    a;
  return coalesce(new, old);
end
$$;
create trigger record_history
  after insert or update or delete on ai.allowed_users for each row
  execute function audit.capture_allowed_users ();
create trigger immutable_history
  before update or delete on audit.allowed_users for each row
  execute function common.reject_history_mutation ();
create function audit.capture_documents ()
  returns trigger
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
declare
  v legal.documents;
  a bigint;
begin
  if tg_op = 'UPDATE' and row (new.id,
    new.external_id,
    new.kind,
    new.zh_title,
    new.en_title,
    new.zh_body,
    new.en_body,
    new.effective_date,
    new.recipient_name,
    new.enabled,
    new.revision,
    new.content_digest) is not distinct from row (old.id,
  old.external_id,
  old.kind,
  old.zh_title,
  old.en_title,
  old.zh_body,
  old.en_body,
  old.effective_date,
  old.recipient_name,
  old.enabled,
  old.revision,
  old.content_digest) then
    return new;
  end if;
  if tg_op = 'DELETE' then
    v = old;
  else
    v = new;
  end if;
  insert into audit.documents (operation_id, actor_kind, actor_auth_user_id, reason, action, id, external_id, kind, zh_title, en_title, zh_body, en_body, effective_date, recipient_name, enabled, revision, content_digest)
    values (nullif (current_setting('app.operation_id', true), '')::bigint, coalesce(nullif (current_setting('app.actor_kind', true), ''), 'MIGRATION'), case when common.auth_user_exists (nullif (current_setting('app.actor_id', true), '')::uuid) then nullif(current_setting('app.actor_id',true),'')::uuid
      end, coalesce(current_setting('app.reason', true), ''), tg_op, v.id, v.external_id, v.kind, v.zh_title, v.en_title, v.zh_body, v.en_body, v.effective_date, v.recipient_name, v.enabled, v.revision, v.content_digest)
    returning
      audit_id
    into
      a;
  if tg_op <> 'DELETE' then
    update
      legal.documents
    set
      document_audit_id = a
    where
      id = v.id;
  end if;
  return coalesce(new, old);
end
$$;
create trigger record_history
  after insert or update or delete on legal.documents for each row
  execute function audit.capture_documents ();
create trigger immutable_history
  before update or delete on audit.documents for each row
  execute function common.reject_history_mutation ();
create function audit.capture_acceptances ()
  returns trigger
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
declare
  v legal.acceptances;
  a bigint;
begin
  if tg_op = 'DELETE' then
    v = old;
  else
    v = new;
  end if;
  insert into audit.acceptances (operation_id, actor_kind, actor_auth_user_id, reason, action, id, owner_auth_user_id, document_id, document_audit_id, time_accepted)
    values (nullif (current_setting('app.operation_id', true), '')::bigint,coalesce(nullif(current_setting('app.actor_kind',true),''), 'MIGRATION'), case when common.auth_user_exists (nullif (current_setting('app.actor_id', true), '')::uuid) then nullif(current_setting('app.actor_id',true),'')::uuid
    end, coalesce(current_setting('app.reason', true), ''), tg_op, v.id, case when common.auth_user_exists (v.owner_auth_user_id) then
      v.owner_auth_user_id
    end, v.document_id, v.document_audit_id, v.time_accepted)
  returning
    audit_id
  into
    a;
  return coalesce(new, old);
end
$$;
create trigger record_history
  after insert or update or delete on legal.acceptances for each row
  execute function audit.capture_acceptances ();
create trigger immutable_history
  before update or delete on audit.acceptances for each row
  execute function common.reject_history_mutation ();
create function audit.capture_members ()
  returns trigger
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
declare
  v admin.members;
  a bigint;
begin
  if tg_op = 'DELETE' then
    v = old;
  else
    v = new;
  end if;
  insert into audit.members (operation_id, actor_kind, actor_auth_user_id, reason, action, id, auth_user_id, time_revoked, revision)
    values (nullif (current_setting('app.operation_id', true), '')::bigint,coalesce(nullif(current_setting('app.actor_kind',true),''), 'MIGRATION'), case when common.auth_user_exists (nullif (current_setting('app.actor_id', true), '')::uuid) then nullif(current_setting('app.actor_id',true),'')::uuid
    end, coalesce(current_setting('app.reason', true), ''), tg_op, v.id, case when common.auth_user_exists (v.auth_user_id) then
      v.auth_user_id
    end, v.time_revoked, v.revision)
  returning
    audit_id
  into
    a;
  return coalesce(new, old);
end
$$;
create trigger record_history
  after insert or update or delete on admin.members for each row
  execute function audit.capture_members ();
create trigger immutable_history
  before update or delete on audit.members for each row
  execute function common.reject_history_mutation ();
create function audit.capture_environment ()
  returns trigger
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
declare
  v admin.environment;
  a bigint;
begin
  if tg_op = 'DELETE' then
    v = old;
  else
    v = new;
  end if;
  insert into audit.environment (operation_id, actor_kind, actor_auth_user_id, reason, action, id, name, database_instance_id, contract_code)
    values (nullif (current_setting('app.operation_id', true), '')::bigint,coalesce(nullif(current_setting('app.actor_kind',true),''), 'MIGRATION'), case when common.auth_user_exists (nullif (current_setting('app.actor_id', true), '')::uuid) then nullif(current_setting('app.actor_id',true),'')::uuid
    end, coalesce(current_setting('app.reason', true), ''), tg_op, v.id, v.name, v.database_instance_id, v.contract_code)
  returning
    audit_id
  into
    a;
  return coalesce(new, old);
end
$$;
create trigger record_history
  after insert or update or delete on admin.environment for each row
  execute function audit.capture_environment ();
create trigger immutable_history
  before update or delete on audit.environment for each row
  execute function common.reject_history_mutation ();
create trigger immutable_snapshot
  before update on ai.request_snapshots for each row
  execute function common.reject_history_mutation ();
grant usage on schema common, admin, ai, legal, cv, audit, extensions, public to app_api_owner;
revoke all on all functions in schema common, audit from public, anon, authenticated, service_role;
grant execute on all functions in schema common, audit to app_api_owner;
revoke all on function common.assert_api_owner_safe () from app_api_owner;
grant create on schema audit to app_api_owner;
alter function audit.capture_configurations () owner to app_api_owner;
revoke create on schema audit from app_api_owner;
grant create on schema audit to app_api_owner;
alter function audit.capture_prices () owner to app_api_owner;
revoke create on schema audit from app_api_owner;
grant create on schema audit to app_api_owner;
alter function audit.capture_rules () owner to app_api_owner;
revoke create on schema audit from app_api_owner;
grant create on schema audit to app_api_owner;
alter function audit.capture_rule_members () owner to app_api_owner;
revoke create on schema audit from app_api_owner;
grant create on schema audit to app_api_owner;
alter function audit.capture_runtime_control () owner to app_api_owner;
revoke create on schema audit from app_api_owner;
grant create on schema audit to app_api_owner;
alter function audit.capture_allowed_users () owner to app_api_owner;
revoke create on schema audit from app_api_owner;
grant create on schema audit to app_api_owner;
alter function audit.capture_documents () owner to app_api_owner;
revoke create on schema audit from app_api_owner;
grant create on schema audit to app_api_owner;
alter function audit.capture_acceptances () owner to app_api_owner;
revoke create on schema audit from app_api_owner;
grant create on schema audit to app_api_owner;
alter function audit.capture_members () owner to app_api_owner;
revoke create on schema audit from app_api_owner;
grant create on schema audit to app_api_owner;
alter function audit.capture_environment () owner to app_api_owner;
revoke create on schema audit from app_api_owner;
commit;
