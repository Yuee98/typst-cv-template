begin;
set local search_path = '';
create function admin.receipt (p_id bigint)
  returns jsonb
  language sql
  stable
  set search_path = ''
  as $$
  select
    common.api_json (jsonb_build_object('operation_id', id, 'operation', operation, 'entity_kind', entity_kind, 'entity_id', entity_id, 'revision', revision, 'time_committed', time_committed))
  from
    admin.operations
  where
    id = p_id
$$;
create function admin.begin_operation (p_operation text, p_input jsonb, p_step_up boolean default true)
  returns admin.operations
  language plpgsql
  set search_path = ''
  as $$
declare
  u uuid;
  o admin.operations;
  d text;
begin
  perform
    common.guard (p_input);
  u = common.admin_id (p_step_up);
  perform
    1
  from
    ai.runtime_control
  where
    id = 1
  for update;
  perform
    common.required (p_input, array['operation_key', 'reason']);
  if length(btrim(p_input ->> 'reason'))
    not between 3 and 500 then
    perform
      common.fail ('INVALID_REQUEST', 'REASON_REQUIRED');
  end if;
  d = common.digest(p_input);
  select
    *
  into
    o
  from
    admin.operations
  where
    actor_auth_user_id = u
    and operation_key = (p_input ->> 'operation_key')::uuid;
  if o.id is not null then
    if o.operation <> p_operation or o.payload_digest <> d then
      perform
        common.fail ('CONFLICT', 'IDEMPOTENCY_MISMATCH');
    end if;
    return o;
  end if;
  insert into admin.operations (actor_auth_user_id, operation_key, operation, payload_digest)
    values (u, (p_input ->> 'operation_key')::uuid, p_operation, d)
  returning
    *
  into
    o;
  perform
    common.audit_context (o.id, u, p_input ->> 'reason');
  return o;
end
$$;
create function admin.configuration_json (p_id bigint)
  returns jsonb
  language sql
  stable
  set search_path = ''
  as $$
  select
    common.api_json (to_jsonb (c) || jsonb_build_object('price', ai.price_json (c.id)))
  from
    ai.configurations c
  where
    id = p_id
$$;
create function admin.rule_json (p_id bigint)
  returns jsonb
  language sql
  stable
  set search_path = ''
  as $$
  select
    common.api_json (to_jsonb (r) || jsonb_build_object('members', coalesce((
          select
            jsonb_agg(jsonb_build_object('config_id', config_id, 'is_default', is_default)
          order by config_id)
          from ai.routing_rule_configurations
          where
            rule_id = r.id), '[]')))
  from
    ai.routing_rules r
  where
    id = p_id
$$;
create function admin.validate_runtime ()
  returns void
  language plpgsql
  set search_path = ''
  as $$
begin
  if not exists (
    select
      1
    from
      legal.documents
    where
      kind = 'AI_COMMON'
      and enabled)
    or not exists (
      select
        1
      from
        legal.documents
      where
        kind = 'TERMS'
        and enabled) then
    perform
      common.fail ('INVALID_REQUEST', 'LEGAL_UNAVAILABLE');
end if;
  if not exists (
    select
      1
    from
      ai.routing_rules
    where
      weekday is null
      and enabled) then
  perform
    common.fail ('INVALID_REQUEST', 'FALLBACK_REQUIRED');
end if;
  if exists (
    select
      1
    from
      ai.routing_rules r
    where
      r.enabled
      and (
        select
          count(*)
        from
          ai.routing_rule_configurations
        where
          rule_id = r.id
          and is_default) <> 1)
    or exists (
      select
        1
      from
        ai.routing_rules r
        join ai.routing_rule_configurations m on m.rule_id = r.id
        join ai.configurations c on c.id = m.config_id
      where
        r.enabled
        and (not c.enabled
          or not ai.scope_valid (c.id))) then
    perform
      common.fail ('INVALID_REQUEST', 'INVALID_ROUTING_GRAPH');
end if;
end
$$;
create function admin.apply (p_operation text, p_input jsonb)
  returns jsonb
  language plpgsql
  set search_path = ''
  as $$
declare
  o admin.operations;
  c ai.runtime_control;
  d legal.documents;
  m admin.members;
  i bigint;
  rev bigint;
  kind text;
  item jsonb;
  price jsonb;
  tries integer := 0;
  cn text;
begin
  o = admin.begin_operation (p_operation, p_input, p_operation <> 'ai_disable');
  if o.entity_id is not null then
    return admin.receipt (o.id);
  end if;
  select
    *
  into
    c
  from
    ai.runtime_control
  where
    id = 1;
  if p_operation = 'configuration_save' then
    perform
      common.required (p_input, array['name', 'adapter_id', 'endpoint_url', 'model_id', 'credential_ref', 'legal_document_id', 'enabled', 'price']);
    i = (p_input ->> 'id')::bigint;
    price = p_input -> 'price';
    perform
      common.required (price, array['currency', 'input_standard_nanos_per_million', 'input_cache_read_nanos_per_million', 'input_cache_write_nanos_per_million', 'output_nanos_per_million']);
    select
      *
    into
      d
    from
      legal.documents
    where
      id = (p_input ->> 'legal_document_id')::bigint;
    if d.id is null or d.kind <> 'AI_PROVIDER' or d.adapter_id is distinct from (p_input ->> 'adapter_id')::smallint or d.endpoint_url is distinct from p_input ->> 'endpoint_url' or d.model_id is distinct from p_input ->> 'model_id' or ((p_input ->> 'enabled')::boolean and not d.enabled) then
      perform
        common.fail ('INVALID_REQUEST', 'LEGAL_SCOPE_MISMATCH');
    end if;
    if i is null then
      if p_input ->> 'expected_revision' is not null then
        perform
          common.fail ('CONFLICT', 'EXPECTED_NEW_ENTITY');
      end if;
      insert into ai.configurations (name, adapter_id, endpoint_url, model_id, credential_ref, legal_document_id, enabled)
        values (p_input ->> 'name', (p_input ->> 'adapter_id')::smallint, p_input ->> 'endpoint_url', p_input ->> 'model_id', p_input ->> 'credential_ref', d.id, (p_input ->> 'enabled')::boolean)
      returning
        id, revision
      into
        i, rev;
    else
      update
        ai.configurations
      set
        name = p_input ->> 'name',
        adapter_id = (p_input ->> 'adapter_id')::smallint,
        endpoint_url = p_input ->> 'endpoint_url',
        model_id = p_input ->> 'model_id',
        credential_ref = p_input ->> 'credential_ref',
        legal_document_id = d.id,
        enabled = (p_input ->> 'enabled')::boolean,
        revision = revision + 1
      where
        id = i
        and revision = (p_input ->> 'expected_revision')::bigint
      returning
        revision
      into
        rev;
      if not found then
        perform
          common.fail ('CONFLICT', 'REVISION_CHANGED');
      end if;
    end if;
    insert into ai.prices (config_id, currency, input_standard_nanos_per_million, input_cache_read_nanos_per_million, input_cache_write_nanos_per_million, output_nanos_per_million)
      values (i, price ->> 'currency', (price ->> 'input_standard_nanos_per_million')::bigint, (price ->> 'input_cache_read_nanos_per_million')::bigint, (price ->> 'input_cache_write_nanos_per_million')::bigint, (price ->> 'output_nanos_per_million')::bigint)
    on conflict (config_id)
      do update set
        currency = excluded.currency,
        input_standard_nanos_per_million = excluded.input_standard_nanos_per_million,
        input_cache_read_nanos_per_million = excluded.input_cache_read_nanos_per_million,
        input_cache_write_nanos_per_million = excluded.input_cache_write_nanos_per_million,
        output_nanos_per_million = excluded.output_nanos_per_million;
    if not (p_input ->> 'enabled')::boolean then
      update ai.requests request_row
      set
        time_canceled = coalesce(request_row.time_canceled, common.now())
      where
        request_row.state <> 'FINALIZED'
        and exists (
          select
            1
          from
            ai.request_snapshots s
          where
            s.request_id = request_row.id
            and s.config_id = i);
    end if;
    kind = 'configurations';
    update
      ai.runtime_control
    set
      revision = revision + 1
    where
      id = 1;
  elsif p_operation = 'rule_save' then
    i = (p_input ->> 'id')::bigint;
    if jsonb_typeof(p_input -> 'members') is distinct from 'array' or jsonb_array_length(p_input -> 'members')
      not between 1 and 32 or (
      select
        count(*)
      from
        jsonb_array_elements(p_input -> 'members') e
      where (e ->> 'is_default')::boolean) <> 1 then
      perform
        common.fail ('INVALID_REQUEST', 'EXACTLY_ONE_DEFAULT_REQUIRED');
    end if;
    if i is null then
      if p_input ->> 'expected_revision' is not null then
        perform
          common.fail ('CONFLICT', 'EXPECTED_NEW_ENTITY');
      end if;
      insert into ai.routing_rules (weekday, start_minute, end_minute, enabled)
        values ((p_input ->> 'weekday')::smallint, (p_input ->> 'start_minute')::integer, (p_input ->> 'end_minute')::integer, (p_input ->> 'enabled')::boolean)
      returning
        id, revision
      into
        i, rev;
    else
      update
        ai.routing_rules
      set
        weekday = (p_input ->> 'weekday')::smallint,
        start_minute = (p_input ->> 'start_minute')::integer,
        end_minute = (p_input ->> 'end_minute')::integer,
        enabled = (p_input ->> 'enabled')::boolean,
        revision = revision + 1
      where
        id = i
        and revision = (p_input ->> 'expected_revision')::bigint
      returning
        revision
      into
        rev;
      if not found then
        perform
          common.fail ('CONFLICT', 'REVISION_CHANGED');
      end if;
      delete from ai.routing_rule_configurations
      where rule_id = i;
    end if;
    for item in
    select
      value
    from
      jsonb_array_elements(p_input -> 'members')
      loop
        insert into ai.routing_rule_configurations (rule_id, config_id, is_default)
          values (i, (item ->> 'config_id')::bigint, (item ->> 'is_default')::boolean);
      end loop;
    kind = 'rules';
    update
      ai.runtime_control
    set
      revision = revision + 1
    where
      id = 1;
  elsif p_operation in ('ai_update', 'ai_disable', 'allowed_user_set') then
    if p_operation <> 'ai_disable' and p_input ->> 'expected_revision' is distinct from c.revision::text then
      perform
        common.fail ('CONFLICT', 'REVISION_CHANGED');
    end if;
    if p_operation = 'ai_update' then
      update
        ai.runtime_control
      set
        enabled = (p_input ->> 'enabled')::boolean,
        audience = p_input ->> 'audience',
        user_daily_limit = (p_input ->> 'user_daily_limit')::bigint,
        global_daily_limit = (p_input ->> 'global_daily_limit')::bigint,
        user_minute_limit = (p_input ->> 'user_minute_limit')::bigint,
        revision = revision + 1
      where
        id = 1
      returning
        revision
      into
        rev;
      if (p_input ->> 'enabled')::boolean then
        perform
          admin.validate_runtime ();
      end if;
    elsif p_operation = 'ai_disable' then
      update
        ai.runtime_control
      set
        enabled = false,
        revision = revision + 1
      where
        id = 1
      returning
        revision
      into
        rev;
    else
      if not common.auth_user_active ((p_input ->> 'auth_user_id')::uuid) then
        perform
          common.fail ('INVALID_REQUEST', 'INVALID_AUTH_USER');
      end if;
      if (p_input ->> 'allowed')::boolean then
        insert into ai.allowed_users (auth_user_id)
          values ((p_input ->> 'auth_user_id')::uuid)
        on conflict
          do nothing;
      else
        delete from ai.allowed_users
        where auth_user_id = (p_input ->> 'auth_user_id')::uuid;
      end if;
      update
        ai.runtime_control
      set
        revision = revision + 1
      where
        id = 1
      returning
        revision
      into
        rev;
    end if;
    if p_operation = 'ai_disable' or (p_operation = 'ai_update' and not (p_input ->> 'enabled')::boolean) then
      update ai.requests request_row
      set
        time_canceled = coalesce(request_row.time_canceled, common.now())
      where
        request_row.state <> 'FINALIZED';
    elsif p_operation = 'allowed_user_set'
        and not (p_input ->> 'allowed')::boolean then
        update ai.requests request_row
      set
          time_canceled = coalesce(request_row.time_canceled, common.now())
        where
          request_row.state <> 'FINALIZED'
          and request_row.owner_auth_user_id = (p_input ->> 'auth_user_id')::uuid;
    elsif p_operation = 'ai_update'
        and p_input ->> 'audience' = 'ALLOWLIST' then
        update ai.requests request_row
      set
          time_canceled = coalesce(request_row.time_canceled, common.now())
        where
          request_row.state <> 'FINALIZED'
          and not exists (
            select
              1
            from
              ai.allowed_users
            where
              auth_user_id = request_row.owner_auth_user_id);
    end if;
    i = 1;
    kind = 'runtime_control';
  elsif p_operation = 'member_grant' then
    if not common.auth_user_active ((p_input ->> 'auth_user_id')::uuid) then
      perform
        common.fail ('INVALID_REQUEST', 'INVALID_AUTH_USER');
    end if;
    select
      *
    into
      m
    from
      admin.members
    where
      auth_user_id = (p_input ->> 'auth_user_id')::uuid;
    if m.id is null then
      if p_input ->> 'expected_revision' is not null then
        perform
          common.fail ('CONFLICT', 'REVISION_CHANGED');
      end if;
      insert into admin.members (auth_user_id)
        values ((p_input ->> 'auth_user_id')::uuid)
      returning
        id, revision
      into
        i, rev;
    else
      if m.time_revoked is null or p_input ->> 'expected_revision' is distinct from m.revision::text then
        perform
          common.fail ('CONFLICT', 'REVISION_CHANGED');
      end if;
      update
        admin.members
      set
        time_revoked = null,
        revision = revision + 1
      where
        id = m.id
      returning
        id,
        revision
      into
        i,
        rev;
    end if;
    kind = 'members';
  elsif p_operation = 'member_revoke' then
    select
      *
    into
      m
    from
      admin.members
    where
      id = (p_input ->> 'id')::bigint;
    if m.id is null or m.time_revoked is not null or p_input ->> 'expected_revision' is distinct from m.revision::text then
      perform
        common.fail ('CONFLICT', 'REVISION_CHANGED');
    end if;
    if (
      select
        count(*)
      from
        admin.members
      where
        time_revoked is null) <= 1 then
      perform
        common.fail ('FORBIDDEN', 'LAST_ADMIN');
    end if;
    update
      admin.members
    set
      time_revoked = common.now(),
      revision = revision + 1
    where
      id = m.id
    returning
      id,
      revision
    into
      i,
      rev;
    kind = 'members';
  elsif p_operation = 'legal_document_save' then
    i = (p_input ->> 'id')::bigint;
    perform
      common.required (p_input, array['kind', 'zh_title', 'en_title', 'zh_body', 'en_body', 'effective_date', 'enabled']);
    if i is null then
      if p_input ->> 'expected_revision' is not null then
        perform
          common.fail ('CONFLICT', 'EXPECTED_NEW_ENTITY');
      end if;
      loop
        begin
          insert into legal.documents (kind, zh_title, en_title, zh_body, en_body, effective_date, recipient_name, adapter_id, endpoint_url, model_id, enabled, content_digest)
            values (p_input ->> 'kind', p_input ->> 'zh_title', p_input ->> 'en_title', p_input ->> 'zh_body', p_input ->> 'en_body', (p_input ->> 'effective_date')::date, p_input ->> 'recipient_name', (p_input ->> 'adapter_id')::smallint, p_input ->> 'endpoint_url', p_input ->> 'model_id', (p_input ->> 'enabled')::boolean, '')
          returning
            id, revision
          into
            i, rev;
          exit;
        exception
          when unique_violation then
            get stacked diagnostics cn = constraint_name;
            tries = tries + 1;
            if cn <> 'uq_legal_documents_external_id' or tries >= 5 then
              raise;
              end if;
        end;
      end loop;
    else
      update
        legal.documents
      set
        kind = p_input ->> 'kind',
        zh_title = p_input ->> 'zh_title',
        en_title = p_input ->> 'en_title',
        zh_body = p_input ->> 'zh_body',
        en_body = p_input ->> 'en_body',
        effective_date = (p_input ->> 'effective_date')::date,
        recipient_name = p_input ->> 'recipient_name',
        adapter_id = (p_input ->> 'adapter_id')::smallint,
        endpoint_url = p_input ->> 'endpoint_url',
        model_id = p_input ->> 'model_id',
        enabled = (p_input ->> 'enabled')::boolean,
        revision = revision + 1
      where
        id = i
        and revision = (p_input ->> 'expected_revision')::bigint
      returning
        revision
      into
        rev;
        if not found then
          perform
            common.fail ('CONFLICT', 'REVISION_CHANGED');
          end if;
    end if;
    kind = 'documents';
    update
      ai.runtime_control
    set
      revision = revision + 1
    where
      id = 1;
    else
      perform
        common.fail ('INVALID_REQUEST', 'UNKNOWN_ADMIN_OPERATION');
  end if;
  update
    admin.operations
  set
    entity_kind = kind,
    entity_id = i,
    revision = rev,
    time_committed = common.now()
  where
    id = o.id;
    return admin.receipt (o.id);
end
$$;
create function public.admin_context ()
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  u uuid;
begin
  u = common.admin_id (false);
  return common.api_json (jsonb_build_object('ready', true, 'contract_code', 'cv_app_db_2', 'database_instance_id', (
        select
          database_instance_id
        from admin.environment
        where
          id = 1), 'environment', (
        select
          name
        from admin.environment
        where
          id = 1), 'member_id', (
        select
          id
        from admin.members
      where
        auth_user_id = u), 'control', (
      select
        jsonb_build_object('enabled', enabled, 'audience', audience, 'revision', revision, 'user_daily_limit', user_daily_limit, 'global_daily_limit', global_daily_limit, 'user_minute_limit', user_minute_limit)
      from ai.runtime_control
    where
      id = 1), 'capabilities', jsonb_build_object('cv_schema_version', 7, 'encrypted_envelope_version', 1)));
end
$$;
create function public.admin_read (p_input jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  ctx jsonb;
  section text := p_input ->> 'section';
  kind text := p_input ->> 'kind';
  i bigint := (p_input ->> 'id')::bigint;
  lim integer := coalesce((p_input ->> 'limit')::integer, 50);
  after_id bigint;
  days integer := coalesce((p_input ->> 'days')::integer, 30);
  data jsonb;
  records jsonb;
  ids bigint[];
  target text;
  key text;
begin
  ctx = public.admin_context ();
  if p_input ->> 'contract_code' is distinct from 'cv_app_db_2' or p_input ->> 'expected_environment' is distinct from ctx ->> 'environment' or (p_input ? 'database_instance_id' and p_input ->> 'database_instance_id' is distinct from ctx ->> 'database_instance_id') then
    perform
      common.fail ('CLIENT_UPDATE_REQUIRED', 'DATABASE_INSTANCE_OR_CONTRACT_CHANGED');
  end if;
  if lim not between 1 and 100 or days not between 1 and 90 then
    perform
      common.fail ('INVALID_REQUEST', 'INVALID_PAGE');
  end if;
  if section = 'controls' then
    return jsonb_build_object('context', ctx, 'data', null);
  end if;
  kind = coalesce(kind, case section
    when 'configurations' then
      'configurations'
    when 'rules' then
      'rules'
    when 'usage' then
      'requests'
    when 'users' then
      'accounts'
    when 'audit' then
      'configurations'
    end);
  if section = 'usage' and kind = 'analytics' then
    data = jsonb_build_object('day_basis', 'UTC_RESERVE_DAY', 'quota_day_basis', 'UTC_PROVIDER_ADMISSION_DAY', 'global_quota', coalesce((
        select
          jsonb_agg(common.api_json (to_jsonb (g))
        order by day)
        from ai.global_quota_daily g
        where
          day >= (common.now() at time zone 'UTC')::date - days + 1), '[]'), 'configurations', coalesce((
      select
        jsonb_agg(common.api_json (to_jsonb (m) || jsonb_build_object('config_id', h.id, 'config_name', h.name, 'config_revision', h.revision))
        order by day, m.config_audit_id, currency)
      from ai.configuration_usage_daily m
      join audit.configurations h on h.audit_id = m.config_audit_id
      where
        day >= (common.now() at time zone 'UTC')::date - days + 1), '[]'));
  elsif section = 'users'
      and kind = 'accounts' then
      if i is not null then
        perform
          common.fail ('INVALID_REQUEST', 'ACCOUNTS_LIST_ONLY');
      end if;
    records = common.auth_user_page (lim, p_input ->> 'after');
    data = jsonb_build_object('records', records, 'next_cursor', case when jsonb_array_length(records) = lim then
        records -> (lim - 1) ->> 'auth_user_id'
      end);
  elsif section = 'users'
      and kind = 'allowed_users' then
      if i is not null then
        perform
          common.fail ('INVALID_REQUEST', 'ALLOWED_USERS_LIST_ONLY');
      end if;
    select
      coalesce(jsonb_agg(to_jsonb (t)
        order by auth_user_id), '[]')
    into
      records
    from (
      select
        auth_user_id
      from
        ai.allowed_users
      where
        p_input ->> 'after' is null
        or auth_user_id::text > p_input ->> 'after'
      order by
        auth_user_id
      limit lim) t;
    data = jsonb_build_object('records', records, 'next_cursor', case when jsonb_array_length(records) = lim then
        records -> (lim - 1) ->> 'auth_user_id'
      end);
  else
    if p_input ->> 'after' is not null then
      after_id = (p_input ->> 'after')::bigint;
    end if;
    if section = 'configurations' and kind in ('configurations', 'adapters', 'legal_documents') then
      target = case kind
      when 'configurations' then
        'ai.configurations'
      when 'adapters' then
        'ai.adapters'
      else
        'legal.documents'
      end;
      key = 'id';
    elsif section = 'rules'
        and kind = 'rules' then
        target = 'ai.routing_rules';
      key = 'id';
    elsif section = 'usage'
        and kind = 'requests' then
        target = 'ai.requests';
      key = 'id';
    elsif section = 'users'
        and kind = 'members' then
        target = 'admin.members';
      key = 'id';
    elsif section = 'audit'
        and kind in ('configurations', 'prices', 'rules', 'rule_members', 'runtime_control', 'allowed_users', 'documents', 'acceptances', 'members') then
        target = 'audit.' || kind;
      key = 'audit_id';
    else
      perform
        common.fail ('INVALID_REQUEST', 'INVALID_SECTION_KIND');
    end if;
    if i is not null then
      ids = array[i];
    else
      if section = 'audit' and p_input ->> 'entity_id' is not null then
        execute format('select array_agg(v) from(select %I v from %s where %I>$1 and %I=$2 order by %I limit $3)t', key, target, key, case kind
          when 'prices' then
            'config_id'
          when 'rule_members' then
            'rule_id'
          else
            'id'
          end, key) into ids
        using coalesce(after_id, 0), (p_input ->> 'entity_id')::bigint, lim;
      else
        execute format('select array_agg(v) from(select %I v from %s where %I>$1 order by %I limit $2)t', key, target, key, key) into ids
        using coalesce(after_id, 0), lim;
      end if;
      end if;
        records = '[]';
        if ids is not null then
          foreach after_id in array ids loop
            if target = 'ai.configurations' then
              data = admin.configuration_json (after_id);
            elsif target = 'ai.routing_rules' then
              data = admin.rule_json (after_id);
            elsif target = 'legal.documents' then
              select
                legal.document_json (document_audit_id)
              into
                data
              from
                legal.documents
              where
                id = after_id;
            elsif target = 'ai.requests'
                and i is not null then
                data = jsonb_build_object('request', (
                    select
                      common.api_json (to_jsonb (t))
                    from ai.requests t
                    where
                      id = after_id), 'snapshot', (
                      select
                        common.api_json (to_jsonb (t))
                      from ai.request_snapshots t
                      where
                        request_id = after_id), 'attempts', coalesce((
                        select
                          jsonb_agg(common.api_json (to_jsonb (t))
                        order by attempt_no)
                        from ai.attempts t
                      where
                        request_id = after_id), '[]'));
            else
              execute format('select to_jsonb(t)%s from %s t where %I=$1', case when target = 'admin.members' then
                  '-''active_auth_user_id'''
                else
                  ''
                end, target, key) into data
              using after_id;
              if target <> 'ai.adapters' then
                data = common.api_json (data);
              end if;
            end if;
              if data is not null then
                records = records || jsonb_build_array(data);
              end if;
            end loop;
          end if;
          if i is not null then
            if jsonb_array_length(records) = 0 then
              perform
                common.fail ('NOT_FOUND');
            end if;
            data = records -> 0;
          else
            data = jsonb_build_object('records', records, 'next_cursor', case when coalesce(array_length(ids, 1), 0) = lim then
                ids[lim]::text
              end);
          end if;
        end if;
        return jsonb_build_object('context', ctx, 'data', data);
end
$$;
create function admin.initialize (p_name text, p_admin_user uuid)
  returns void
  language plpgsql
  set search_path = ''
  as $$
declare
  e admin.environment;
begin
  perform
    common.assert_api_owner_safe ();
  if p_name not in ('LOCAL', 'PREVIEW', 'PRODUCTION') then
    perform
      common.fail ('INVALID_REQUEST', 'INVALID_ENVIRONMENT');
  end if;
  perform
    pg_advisory_xact_lock(327845321);
  select
    *
  into
    e
  from
    admin.environment
  where
    id = 1;
  if e.id is not null then
    if e.name <> p_name or not exists (
      select
        1
      from
        admin.members
      where
        auth_user_id = p_admin_user and time_revoked is null) then
      perform
        common.fail ('CONFLICT', 'ENVIRONMENT_ALREADY_INITIALIZED');
    end if;
    return;
  end if;
  perform
    1
  from
    auth.users
  where
    id = p_admin_user
    and deleted_at is null
    and (banned_until is null
      or banned_until < clock_timestamp())
  for key share;
  if not found then
    perform
      common.fail ('INVALID_REQUEST', 'INVALID_ADMIN_USER');
  end if;
  perform
    common.audit_context (null, null, 'Initial environment and first administrator', 'SYSTEM');
  insert into admin.environment (id, name, database_instance_id, contract_code)
    values (1, p_name, extensions.gen_random_uuid (), 'cv_app_db_2');
  insert into admin.members (auth_user_id)
    values (p_admin_user);
  update
    ai.runtime_control
  set
    enabled = false,
    revision = revision + 1
  where
    id = 1;
end
$$;
create function public.admin_configuration_save (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.apply ('configuration_save', p_input)
$$;
create function public.admin_rule_save (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.apply ('rule_save', p_input)
$$;
create function public.admin_ai_update (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.apply ('ai_update', p_input)
$$;
create function public.admin_ai_disable (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.apply ('ai_disable', p_input)
$$;
create function public.admin_allowed_user_set (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.apply ('allowed_user_set', p_input)
$$;
create function public.admin_member_grant (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.apply ('member_grant', p_input)
$$;
create function public.admin_member_revoke (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.apply ('member_revoke', p_input)
$$;
create function public.admin_legal_document_save (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.apply ('legal_document_save', p_input)
$$;
commit;
