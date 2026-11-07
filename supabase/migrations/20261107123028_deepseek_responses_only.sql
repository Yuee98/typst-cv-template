-- DeepSeek Responses is the only supported DeepSeek execution capability.
-- Do not rewrite any referenced execution identity: an environment with old
-- profile/default references must explicitly retire/rebuild its application data
-- before applying this migration. Historical sealed legal content stays intact.
begin;
set local search_path = '';
select
  common.assert_api_owner_safe ();
-- Match owner publication ordering; block concurrent authoring and reservations.
select
  1
from
  admin.environment
where
  id = 1
for update;
select
  1
from
  ai.runtime_control
where
  id = 1
for update;
select
  1
from
  legal.current_state
where
  id = 1
for update;
lock table ai.capabilities,
ai.profile_versions,
ai.providers in share row exclusive mode;
do $cutover$
declare
  v_capability smallint;
  v_descriptor jsonb := '{"code":"DEEPSEEK_RESPONSES","adapter_kind":"deepseek_responses_v1","wire_api_kind":"responses_v1","execution_contract":"cv_polish_1","calculator_kind":"linear_token_v1","cache_policy":"automatic"}'::jsonb;
begin
  select
    id
  into
    strict v_capability
  from
    ai.capabilities
  where
    code = 'DEEPSEEK_CHAT';
  if exists (
    select
      1
    from
      ai.profile_versions
    where
      capability_id = v_capability)
    or exists (
      select
        1
      from
        ai.providers
      where
        default_capability_id = v_capability) then
    perform
      common.fail ('CONFLICT', 'DEEPSEEK_CHAT_CAPABILITY_REFERENCED_REBUILD_REQUIRED');
end if;
  -- No frozen profile/request/default can observe this replacement.
  update
    ai.capabilities
  set
    code = v_descriptor ->> 'code',
    name = 'DeepSeek Responses API',
    description = 'Official stateless Responses API; user HMAC subject; no store request parameter',
    adapter_kind = v_descriptor ->> 'adapter_kind',
    wire_api_kind = v_descriptor ->> 'wire_api_kind',
    execution_contract = v_descriptor ->> 'execution_contract',
    calculator_kind = v_descriptor ->> 'calculator_kind',
    cache_policy = v_descriptor ->> 'cache_policy',
    descriptor_digest = common.digest(v_descriptor),
    time_deprecated = null
  where
    id = v_capability;
end;
$cutover$;
create or replace function admin.apply (p_action text, p_input jsonb, p_actor uuid)
  returns jsonb
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  j jsonb;
  v jsonb;
  i bigint;
  parent bigint;
  provider bigint;
  bundle bigint;
  disclosure bigint;
  cap smallint;
  n int;
  k text;
  option_map jsonb := '{}';
  opt jsonb;
  rule jsonb;
  members jsonb;
  def_id bigint;
  c ai.runtime_control;
  r admin.readbacks;
  t timestamptz;
  newprice jsonb;
  kind text;
  tab regclass;
  pid bigint;
begin
  if p_action = 'provider_update' then
    i = admin.parent_guard ('ai.providers', p_input ->> 'external_id', p_input ->> 'expected_revision');
    select
      id
    into
      cap
    from
      ai.capabilities
    where
      code = p_input -> 'defaults' ->> 'capability_code';
      if (p_input -> 'defaults' ->> 'capability_code') is not null and cap is null then
        perform
          common.fail ('INVALID_REQUEST', 'DEFAULT_CAPABILITY');
      end if;
      if exists (
        select
          1
        from
          ai.providers
        where
          id = i
          and code = 'DEEPSEEK')
      and (((p_input -> 'defaults' ->> 'capability_code') is not null
          and (p_input -> 'defaults' ->> 'capability_code') <> 'DEEPSEEK_RESPONSES')
        or ((p_input -> 'defaults' ->> 'endpoint_url') is not null
          and (p_input -> 'defaults' ->> 'endpoint_url') <> 'https://api.deepseek.com/responses')) then
      perform
        common.fail ('INVALID_REQUEST', 'PROVIDER_CAPABILITY_OR_ENDPOINT');
  end if;
  update
    ai.providers
  set
    name = p_input ->> 'name',
    description = p_input ->> 'description',
    default_capability_id = cap,
    default_endpoint_url = p_input -> 'defaults' ->> 'endpoint_url',
    default_credential_ref = p_input -> 'defaults' ->> 'credential_ref',
    default_model_id = p_input -> 'defaults' ->> 'model_id',
    user_updated = p_actor
  where
    id = i
  returning
    to_jsonb (ai.providers.*)
  into
    j;
    return admin.project ('providers', j);
  elsif p_action in ('profile_create', 'policy_create') then
    if p_action = 'profile_create' then
      select
        id
      into
        provider
      from
        ai.providers
      where
        external_id = p_input ->> 'provider_id'
        and time_archived is null;
        if provider is null then
          perform
            common.fail ('NOT_FOUND', 'PROVIDER');
        end if;
        j = jsonb_build_object('provider_id', provider);
        kind = 'profiles';
      else
        j = '{}';
        kind = 'policies';
    end if;
    j = common.insert_entity (admin.table_for (kind), j || jsonb_build_object('code', p_input ->> 'code', 'name', p_input ->> 'name', 'description', coalesce(p_input ->> 'description', ''), 'user_created', p_actor, 'user_updated', p_actor));
    return admin.project (kind, j);
  elsif p_action = 'profile_version_create' then
    parent = admin.parent_guard ('ai.profiles', p_input ->> 'profile_id', p_input ->> 'expected_revision');
    select
      provider_id
    into
      provider
    from
      ai.profiles
    where
      id = parent;
      select
        id
      into
        cap
      from
        ai.capabilities
      where
        code = p_input ->> 'capability_code'
        and time_deprecated is null;
        select
          d.id,
          d.bundle_id
        into
          disclosure,
          bundle
        from
          legal.disclosures d
          join legal.bundles b on b.id = d.bundle_id
          join ai.providers p on p.id = d.provider_id
        where
          d.external_id = p_input ->> 'disclosure_id'
          and d.provider_id = provider
          and d.model_id = p_input ->> 'model_id'
          and d.recipient_code = p.recipient_code
          and b.time_sealed is not null;
          if disclosure is null or cap is null then
            perform
              common.fail ('INVALID_REQUEST', 'DISCLOSURE_OR_CAPABILITY_MISMATCH');
          end if;
          if not (p_input ->> 'credential_ref' ~ ('^AI_PROVIDER_KEY_' || (
            select
              code
            from
              ai.providers
            where
              id = provider) || '_[A-Z0-9_]+$')) then
            perform
              common.fail ('INVALID_REQUEST', 'CREDENTIAL_PREFIX');
          end if;
          if not exists (
            select
              1
            from
              ai.providers p
              join ai.capabilities cap_def on cap_def.id = cap
            where
              p.id = provider
              and ((p.code = 'DEEPSEEK'
                  and cap_def.code = 'DEEPSEEK_RESPONSES'
                  and p_input ->> 'endpoint_url' = 'https://api.deepseek.com/responses')
                or (p.code = 'MIMO'
                  and cap_def.code = 'MIMO_RESPONSES'
                  and p_input ->> 'endpoint_url' = 'https://api.xiaomimimo.com/v1/responses'))) then
          perform
            common.fail ('INVALID_REQUEST', 'PROVIDER_CAPABILITY_OR_ENDPOINT');
end if;
if exists (
  select
    1
  from
    ai.providers
  where
    id = provider
    and code = 'DEEPSEEK')
and (p_input -> 'adapter_config') is distinct from '{"reasoningEffort":"none","structuredOutput":"json_object","providerSubjectField":"user"}'::jsonb then
perform
  common.fail ('INVALID_REQUEST', 'ADAPTER_CONFIGURATION');
end if;
select
  coalesce(max(version), 0) + 1
into
  n
from
  ai.profile_versions
where
  profile_id = parent;
  j = common.insert_entity ('ai.profile_versions', jsonb_build_object('profile_id', parent, 'version', n, 'provider_id', provider, 'capability_id', cap, 'endpoint_url', p_input ->> 'endpoint_url', 'credential_ref', p_input ->> 'credential_ref', 'model_id', p_input ->> 'model_id', 'adapter_config', p_input -> 'adapter_config', 'config_digest', common.digest(p_input - array['contract_code', 'database_instance_id', 'operation_key', 'reason', 'expected_revision']), 'legal_disclosure_id', disclosure, 'legal_bundle_id', bundle, 'user_created', p_actor));
  update
    ai.profiles
  set
    user_updated = p_actor
  where
    id = parent;
    return admin.project ('profile_versions', j);
  elsif p_action = 'price_version_create' then
    select
      id,
      profile_id
    into
      i,
      parent
    from
      ai.profile_versions
    where
      external_id = p_input ->> 'profile_version_id';
      if i is null then
        perform
          common.fail ('NOT_FOUND');
      end if;
      perform
        admin.parent_guard ('ai.profiles', (
            select
              external_id
            from ai.profiles
            where
              id = parent), p_input ->> 'expected_revision');
        j = admin.price_create (p_input, i, p_actor);
        update
          ai.profiles
        set
          user_updated = p_actor
        where
          id = parent;
          return admin.project ('price_versions', j);
        elsif p_action = 'policy_version_create' then
          parent = admin.parent_guard ('ai.policies', p_input ->> 'policy_id', p_input ->> 'expected_revision');
          select
            id
          into
            bundle
          from
            legal.bundles
          where
            external_id = p_input ->> 'bundle_id'
            and time_sealed is not null;
            if bundle is null then
              perform
                common.fail ('INVALID_REQUEST', 'LEGAL_BUNDLE');
            end if;
            if jsonb_typeof(p_input -> 'options') is distinct from 'array' or jsonb_array_length(p_input -> 'options') < 1 or jsonb_array_length(p_input -> 'options') > 30 or jsonb_typeof(p_input -> 'rules') is distinct from 'array' or jsonb_array_length(p_input -> 'rules') > 100 then
              perform
                common.fail ('INVALID_REQUEST', 'POLICY_GRAPH');
            end if;
            select
              coalesce(max(version), 0) + 1
            into
              n
            from
              ai.policy_versions
            where
              policy_id = parent;
              j = common.insert_entity ('ai.policy_versions', jsonb_build_object('policy_id', parent, 'version', n, 'legal_bundle_id', bundle, 'config_digest', common.digest(p_input - array['contract_code', 'database_instance_id', 'operation_key', 'reason', 'expected_revision']), 'user_created', p_actor));
              i = (j ->> 'id')::bigint;
              for opt in
              select
                *
              from
                jsonb_array_elements(p_input -> 'options')
                loop
                  if opt ->> 'key' is null or option_map ? (opt ->> 'key') then
                    perform
                      common.fail ('INVALID_REQUEST', 'OPTION_KEY');
                  end if;
                  select
                    id
                  into
                    pid
                  from
                    ai.profile_versions
                  where
                    external_id = opt ->> 'profile_version_id'
                    and legal_bundle_id = bundle;
                    if pid is null then
                      perform
                        common.fail ('INVALID_REQUEST', 'OPTION_PROFILE_BUNDLE');
                    end if;
                    v = common.insert_entity ('ai.policy_options', jsonb_build_object('policy_version_id', i, 'legal_bundle_id', bundle, 'profile_version_id', pid, 'price_lane_code', opt ->> 'price_lane_code', 'display_order', (opt ->> 'display_order')::int));
                    option_map = option_map || jsonb_build_object(opt ->> 'key', (v ->> 'id')::bigint);
                end loop;
                for rule in
                select
                  *
                from
                  jsonb_array_elements(p_input -> 'rules')
                  loop
                    def_id = (option_map ->> (rule ->> 'default_option_key'))::bigint;
                    if def_id is null then
                      perform
                        common.fail ('INVALID_REQUEST', 'DEFAULT_OPTION_KEY');
                    end if;
                    insert into ai.routing_rules (policy_version_id, ordinal, is_fallback, weekday, start_minute, end_minute, default_option_id)
                      values (i, (rule ->> 'ordinal')::int,
                        (rule ->> 'is_fallback')::boolean,
                        (rule ->> 'weekday')::int,
                        (rule ->> 'start_minute')::int,
                        (rule ->> 'end_minute')::int,
                        def_id);
                      if jsonb_typeof(rule -> 'option_keys') is distinct from 'array' or jsonb_array_length(rule -> 'option_keys') = 0 then
                        perform
                          common.fail ('INVALID_REQUEST', 'EMPTY_RULE_OPTIONS');
                      end if;
                      for k in
                      select
                        jsonb_array_elements_text(rule -> 'option_keys')
                        loop
                          if not option_map ? k then
                            perform
                              common.fail ('INVALID_REQUEST', 'UNKNOWN_OPTION_KEY');
                          end if;
                          insert into ai.routing_rule_options (policy_version_id, rule_ordinal, option_id)
                            values (i, (rule ->> 'ordinal')::int,
                              (option_map ->> k)::bigint);
                        end loop;
                  end loop;
                  if (
                    select
                      count(*)
                    from
                      ai.routing_rules
                    where
                      policy_version_id = i and is_fallback) <> 1 or exists (
                  select
                    1
                  from
                    ai.policy_options o
                  where
                    o.policy_version_id = i and not exists (
                    select
                      1
                    from
                      ai.routing_rule_options m
                    where
                      m.policy_version_id = i and m.option_id = o.id)) then
                    perform
                      common.fail ('INVALID_REQUEST', 'FALLBACK_OR_UNUSED_OPTION');
                  end if;
                  update
                    ai.policies
                  set
                    user_updated = p_actor
                  where
                    id = parent;
                    return admin.project ('policy_versions', j);
                  elsif p_action in ('profile_version_publish', 'profile_version_retire', 'price_version_publish', 'price_version_retire', 'policy_version_publish', 'policy_version_retire') then
                    kind = case when p_action like 'profile_%' then
                      'profile_versions'
                    when p_action like 'price_%' then
                      'price_versions'
                    else
                      'policy_versions'
                    end;
                    tab = admin.table_for (kind);
                    execute format('select to_jsonb(x) from %s x where external_id=$1 for update', tab) into j
                    using p_input ->> 'external_id';
                    if j is null then
                      perform
                        common.fail ('NOT_FOUND');
                    end if;
                    if j ->> 'status' is distinct from p_input ->> 'expected_status' or j ->> 'config_digest' is distinct from p_input ->> 'config_digest' then
                      perform
                        common.fail ('CONFLICT', 'TARGET_CHANGED');
                    end if;
                    if kind = 'price_versions' then
                      select
                        pv.profile_id
                      into
                        parent
                      from
                        ai.profile_versions pv
                      where
                        pv.id = (j ->> 'profile_version_id')::bigint;
                      else
                        parent = coalesce((j ->> 'profile_id')::bigint, (j ->> 'policy_id')::bigint);
                    end if;
                    if kind = 'policy_versions' then
                      perform
                        admin.parent_guard ('ai.policies', (
                            select
                              external_id
                            from ai.policies
                            where
                              id = parent), p_input ->> 'expected_revision');
                      else
                        perform
                          admin.parent_guard ('ai.profiles', (
                              select
                                external_id
                              from ai.profiles
                              where
                                id = parent), p_input ->> 'expected_revision');
                    end if;
                    if p_action like '%_publish' then
                      if j ->> 'status' <> 'DRAFT' then
                        perform
                          common.fail ('CONFLICT', 'NOT_DRAFT');
                      end if;
                      perform
                        admin.report_guard (
                          case kind
                          when 'profile_versions' then
                            'PROFILE'
                          when 'price_versions' then
                            'PRICE'
                          else
                            'POLICY'
                          end, (j ->> 'id')::bigint, p_input ->> 'validation_id');
                        execute format('update %s set status=''PUBLISHED'',time_published=clock_timestamp(),user_published=$1 where id=$2 returning to_jsonb(%s.*)', tab, tab) into j
                        using p_actor, (j ->> 'id')::bigint;
                      else
                        if j ->> 'status' = 'RETIRED' then
                          perform
                            common.fail ('CONFLICT', 'ALREADY_RETIRED');
                        end if;
                        if kind = 'price_versions' and coalesce(least ((j ->> 'time_valid_until')::timestamptz, (j ->> 'time_closed')::timestamptz), 'infinity'::timestamptz) > clock_timestamp() then
                          perform
                            common.fail ('CONFLICT', 'PRICE_INTERVAL_NOT_ENDED');
                        end if;
                        execute format('update %s set status=''RETIRED'',time_retired=clock_timestamp(),user_retired=$1 where id=$2 returning to_jsonb(%s.*)', tab, tab) into j
                        using p_actor, (j ->> 'id')::bigint;
                      end if;
                      if kind = 'policy_versions' then
                        update
                          ai.policies
                        set
                          user_updated = p_actor
                        where
                          id = parent;
                        else
                          update
                            ai.profiles
                          set
                            user_updated = p_actor
                          where
                            id = parent;
                      end if;
                      return admin.project (kind, j);
                    elsif p_action in ('profile_retire', 'policy_retire') then
                      kind = case p_action
                      when 'profile_retire' then
                        'profiles'
                      else
                        'policies'
                      end;
                      tab = admin.table_for (kind);
                      i = admin.parent_guard (tab, p_input ->> 'external_id', p_input ->> 'expected_revision');
                      execute format('update %s set time_retired=clock_timestamp(),user_updated=$1 where id=$2 returning to_jsonb(%s.*)', tab, tab) into j
                      using p_actor, i;
                      return admin.project (kind, j);
                    elsif p_action in ('price_version_close', 'price_version_replace') then
                      select
                        to_jsonb (p)
                      into
                        j
                      from
                        ai.price_versions p
                      where
                        external_id = p_input ->> 'external_id'
                      for update;
                      if j is null then
                        perform
                          common.fail ('NOT_FOUND');
                      end if;
                      if j ->> 'status' <> 'PUBLISHED' or j ->> 'time_closed' is not null then
                        perform
                          common.fail ('CONFLICT', 'PRICE_NOT_OPEN');
                      end if;
                      select
                        profile_id
                      into
                        parent
                      from
                        ai.profile_versions
                      where
                        id = (j ->> 'profile_version_id')::bigint;
                        perform
                          admin.parent_guard ('ai.profiles', (
                              select
                                external_id
                              from ai.profiles
                              where
                                id = parent), p_input ->> 'expected_revision');
                          t = clock_timestamp();
                          if (j ->> 'time_valid_from')::timestamptz >= t or ((j ->> 'time_valid_until')::timestamptz is not null and (j ->> 'time_valid_until')::timestamptz <= t) then
                            perform
                              common.fail ('CONFLICT', 'PRICE_NOT_CURRENT');
                          end if;
                          if p_action = 'price_version_replace' then
                            perform
                              admin.report_guard ('PROFILE', (j ->> 'profile_version_id')::bigint, p_input ->> 'validation_id');
                          end if;
                          update
                            ai.price_versions
                          set
                            time_closed = t
                          where
                            id = (j ->> 'id')::bigint
                          returning
                            to_jsonb (ai.price_versions.*)
                          into
                            j;
                            if p_action = 'price_version_replace' then
                              newprice = admin.price_create (p_input || jsonb_build_object('lane_code', j ->> 'lane_code'), (j ->> 'profile_version_id')::bigint, p_actor, t);
                              update
                                ai.price_versions
                              set
                                status = 'PUBLISHED',
                                time_published = t,
                                user_published = p_actor
                              where
                                id = (newprice ->> 'id')::bigint
                              returning
                                to_jsonb (ai.price_versions.*)
                              into
                                newprice;
                            end if;
                            update
                              ai.profiles
                            set
                              user_updated = p_actor
                            where
                              id = parent;
                              return jsonb_build_object('closed', admin.project ('price_versions', j), 'replacement', case when newprice is not null then
                                  admin.project ('price_versions', newprice)
                                end);
                            elsif p_action like 'ai_%' then
                              select
                                *
                              into
                                c
                              from
                                ai.runtime_control
                              where
                                id = 1;
                                if c.revision::text is distinct from p_input ->> 'expected_revision' then
                                  perform
                                    common.fail ('CONFLICT', 'REVISION_CHANGED');
                                end if;
                                if p_action = 'ai_disable' then
                                  update
                                    ai.runtime_control
                                  set
                                    enabled = false,
                                    generation = generation + 1,
                                    close_cycle = close_cycle + 1,
                                    user_updated = p_actor
                                  where
                                    id = 1;
                                  elsif p_action = 'ai_set_policy' then
                                    if c.enabled then
                                      perform
                                        common.fail ('CONFLICT', 'DISABLE_FIRST');
                                    end if;
                                    select
                                      id
                                    into
                                      i
                                    from
                                      ai.policy_versions
                                    where
                                      external_id = p_input ->> 'policy_version_id'
                                      and status = 'PUBLISHED'
                                      and legal_bundle_id = (
                                        select
                                          ai_bundle_id
                                        from
                                          legal.current_state
                                        where
                                          id = 1);
                                      if p_input ->> 'policy_version_id' is not null and i is null then
                                        perform
                                          common.fail ('INVALID_REQUEST', 'PUBLISHED_POLICY_REQUIRED');
                                      end if;
                                      if i is not null then
                                        perform
                                          admin.report_guard ('POLICY', i, p_input ->> 'validation_id');
                                      end if;
                                      update
                                        ai.runtime_control
                                      set
                                        active_policy_version_id = i,
                                        generation = generation + 1,
                                        user_updated = p_actor
                                      where
                                        id = 1;
                                      elsif p_action = 'ai_reopen' then
                                        if c.enabled then
                                          perform
                                            common.fail ('CONFLICT', 'ALREADY_ENABLED');
                                        end if;
                                        select
                                          *
                                        into
                                          r
                                        from
                                          admin.readbacks
                                        where
                                          external_id = p_input ->> 'readback_id'
                                          and policy_version_id = c.active_policy_version_id
                                          and passed
                                          and time_expires > clock_timestamp()
                                          and generation = c.generation
                                          and control_revision = c.revision
                                          and close_cycle = c.close_cycle
                                          and environment_revision = (
                                            select
                                              revision
                                            from
                                              admin.environment
                                            where
                                              id = 1);
                                          if not found or r.dependency_digest <> common.digest(admin.dependencies ('POLICY', c.active_policy_version_id)) then
                                            perform
                                              common.fail ('CONFLICT', 'READBACK_EXPIRED_OR_CHANGED');
                                          end if;
                                          update
                                            ai.runtime_control
                                          set
                                            enabled = true,
                                            generation = generation + 1,
                                            user_updated = p_actor
                                          where
                                            id = 1;
                                          elsif p_action = 'ai_update_limits' then
                                            update
                                              ai.runtime_control
                                            set
                                              user_daily_limit = (p_input ->> 'user_daily_limit')::bigint,
                                              global_daily_limit = (p_input ->> 'global_daily_limit')::bigint,
                                              user_minute_limit = (p_input ->> 'user_minute_limit')::bigint,
                                              generation = generation + 1,
                                              user_updated = p_actor
                                            where
                                              id = 1;
                                            elsif p_action = 'ai_set_audience' then
                                              update
                                                ai.runtime_control
                                              set
                                                audience = p_input ->> 'audience',
                                                generation = generation + 1,
                                                user_updated = p_actor
                                              where
                                                id = 1;
                                              elsif p_action = 'ai_set_allowed_user' then
                                                if (p_input ->> 'allowed')::boolean then
                                                  insert into ai.allowed_users (auth_user_id, user_created)
                                                    values ((p_input ->> 'auth_user_id')::uuid, p_actor)
                                                  on conflict
                                                    do nothing;
                                                  else
                                                    delete from ai.allowed_users
                                                    where auth_user_id = (p_input ->> 'auth_user_id')::uuid;
                                                end if;
                                                update
                                                  ai.runtime_control
                                                set
                                                  generation = generation + 1,
                                                  user_updated = p_actor
                                                where
                                                  id = 1;
                                                else
                                                  perform
                                                    common.fail ('INVALID_REQUEST', 'UNKNOWN_OPERATION');
                                end if;
                                return (
                                  select
                                    admin.project ('control', to_jsonb (x))
                                  from
                                    ai.runtime_control x
                                  where
                                    id = 1);
                              elsif p_action in ('member_grant', 'member_revoke') then
                                if not common.auth_user_active ((p_input ->> 'auth_user_id')::uuid) then
                                  perform
                                    common.fail ('NOT_FOUND', 'AUTH_USER');
                                end if;
                                if p_action = 'member_grant' then
                                  select
                                    to_jsonb (m)
                                  into
                                    j
                                  from
                                    admin.members m
                                  where
                                    auth_user_id = (p_input ->> 'auth_user_id')::uuid
                                  for update;
                                  if j is null then
                                    j = common.insert_entity ('admin.members', jsonb_build_object('auth_user_id', p_input ->> 'auth_user_id', 'user_created', p_actor, 'user_updated', p_actor));
                                  else
                                    if j ->> 'revision' is distinct from p_input ->> 'expected_revision' then
                                      perform
                                        common.fail ('CONFLICT', 'REVISION_CHANGED');
                                    end if;
                                    update
                                      admin.members
                                    set
                                      time_revoked = null,
                                      user_updated = p_actor
                                    where
                                      id = (j ->> 'id')::bigint
                                    returning
                                      to_jsonb (admin.members.*)
                                    into
                                      j;
                                  end if;
                                else
                                  select
                                    to_jsonb (m)
                                  into
                                    j
                                  from
                                    admin.members m
                                  where
                                    auth_user_id = (p_input ->> 'auth_user_id')::uuid
                                  for update;
                                  if j is null then
                                    perform
                                      common.fail ('NOT_FOUND');
                                  end if;
                                  if j ->> 'revision' is distinct from p_input ->> 'expected_revision' then
                                    perform
                                      common.fail ('CONFLICT', 'REVISION_CHANGED');
                                  end if;
                                  if j ->> 'time_revoked' is null and (
                                    select
                                      count(*)
                                    from
                                      admin.members
                                    where
                                      time_revoked is null and common.auth_user_active (auth_user_id)) <= 1 then
                                    perform
                                      common.fail ('CONFLICT', 'LAST_ADMIN');
                                  end if;
                                  update
                                    admin.members
                                  set
                                    time_revoked = clock_timestamp(),
                                    user_updated = p_actor
                                  where
                                    id = (j ->> 'id')::bigint
                                  returning
                                    to_jsonb (admin.members.*)
                                  into
                                    j;
                                end if;
                                return admin.project ('members', j);
                              else
                                perform
                                  common.fail ('INVALID_REQUEST', 'UNKNOWN_OPERATION');
                    end if;
end
$$;
-- CREATE OR REPLACE retains ownership; reassert the private dispatcher ACL.
revoke all on function admin.apply (text, jsonb, uuid) from public, anon, authenticated, service_role;
grant execute on function admin.apply (text, jsonb, uuid) to app_api_owner;
-- The original sealed bundle/documents remain immutable. Reuse the reviewed
-- common AI terms and seal a new provider manifest + exact disclosures.
do $legal$
declare
  v_document bigint;
  v_ai_digest text;
  v_bundle jsonb;
  v_item jsonb;
  v_provider ai.providers;
  v_manifest jsonb := $manifest$ { "code" :"CV_APP_RESPONSES_20261107",
  "renderer_contract" :"legal_disclosure_1",
  "sources" :["https://api-docs.deepseek.com/quick_start/pricing/", "https://api-docs.deepseek.com/api/create-response/", "https://api-docs.deepseek.com/guides/responses_api/", "https://api-docs.deepseek.com/quick_start/rate_limit/", "https://api-docs.deepseek.com/guides/kv_cache/", "https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html", "https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html", "https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html", "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html", "https://mimo.mi.com/docs/en-US/api/chat/responses", "https://mimo.mi.com/docs/en-US/price/pay-as-you-go", "https://mimo.mi.com/docs/en-US/api/guidance/rate-limit", "https://mimo.mi.com/docs/en-US/api/guidance/error-codes", "https://mimo.mi.com/docs/quick-start/terms/user-agreement", "https://mimo.mi.com/docs/en-US/terms/privacy-policy"],
  "reviewed_provider_facts" :[{ "manifestId" :"deepseek-official-responses-2026-11-07-v1", "displayKey" :"deepseek-official-responses-v1", "reviewedAt" :"Responses API technical facts: 2026-11-07; policy evidence retained from 2026-08-23 (Asia/Shanghai)", "provider" :"Official DeepSeek Open Platform", "gatewayOperator" :"Hangzhou DeepSeek Artificial Intelligence Co., Ltd.", "modelVendor" :"DeepSeek", "models" :["deepseek-flash (Responses API profile)"], "upstream" :"Official DeepSeek Responses API (https://api.deepseek.com/responses)", "submittedData" :["The resume text selected by the user, chosen context, and style instructions", "An HMAC-SHA256 pseudonymous identifier in the Responses API user field; no email address, username, or raw account ID"], "providerSubjectId" :"An HMAC-SHA256 pseudonymous identifier is sent in the Responses API user field. DeepSeek documents it for content safety, cache isolation, and scheduling isolation.", "processingRegion" :"DeepSeek's general Privacy Policy describes processing and storage in the People's Republic of China, but it expressly excludes products and services provided by downstream users. It therefore does not establish a location for content that this service submits through the Open Platform API. The API-specific processing location and region are unverified.", "cache" :"Official API documentation states that disk context caching is enabled by default and that an unused cache is usually cleared automatically within a few hours to a few days.", "retention" :"DeepSeek describes Responses as stateless, without stored response or conversation state. The store request parameter is unsupported and is not sent; responses carry store:false. This does not establish zero retention of caches or safety logs. We found no fixed overall retention period or zero-retention commitment for API content.", "training" :"DeepSeek's Terms of Use, which defines its Services to include APIs, describes limited use of de-identified data to improve the Services. The Open Platform Terms do not grant DeepSeek training use: their model-training clause concerns what the developer may do with inputs and outputs. We found no API-specific no-training commitment or opt-out.", "transfer" :"The API-specific processing location and transfer path are unverified. Where applicable law requires it, the service operator uses an explicit-consent flow for this optional feature; this is the operator's chosen authorization flow, not a claim that API content is processed in any particular location or a universal legal conclusion for every user or transfer.", "unknowns" :["Specific retention and deletion periods for API content beyond context caching", "The API-specific processing/storage location, transfer path, and whether any opt-out covers API requests"], "sources" :["https://api-docs.deepseek.com/quick_start/pricing/", "https://api-docs.deepseek.com/api/create-response/", "https://api-docs.deepseek.com/guides/responses_api/", "https://api-docs.deepseek.com/quick_start/rate_limit/", "https://api-docs.deepseek.com/guides/kv_cache/", "https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html", "https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html", "https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html", "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html"] }, { "manifestId" :"mimo-cn-2026-08-23-v1", "displayKey" :"mimo-cn-v1", "reviewedAt" :"2026-08-23 (Asia/Shanghai)", "provider" :"Official MiMo API (mainland-China profile)", "gatewayOperator" :"Official MiMo API. The reviewed pages do not identify the specific company operating the service in mainland China. The terms for service outside mainland China name Xiaomi Technologies Singapore Pte. Ltd.", "modelVendor" :"Xiaomi / MiMo", "models" :["mimo-v2.5-pro (Responses API profile)"], "upstream" :"Official MiMo Responses API (api.xiaomimimo.com/v1/responses)", "submittedData" :["The resume text selected by the user, chosen context, and style instructions", "The initial adapter sends no HMAC provider subject ID, email address, username, or raw account ID"], "providerSubjectId" :"No provider subject ID is sent.", "processingRegion" :"The Privacy Policy describes global data centers, including the Netherlands and Singapore, and possible transfers involving other parties or regions. The actual request region depends on the request or a separate arrangement and is not guaranteed.", "cache" :"We could not verify a fixed TTL, scope, or opt-out mechanism for API-content caching from the reviewed official materials.", "retention" :"The Privacy Policy states a general rule of retaining data for the necessary period and then deleting or anonymizing it; it gives no fixed numeric TTL for API content.", "training" :"MiMo describes the user as Controller and itself as Processor, and states that submitted API content is not used for model training or other purposes.", "transfer" :"Access from mainland China is governed by the in-PRC terms; cross-border or other-region processing depends on the request and arrangements. Where applicable law requires it, the service operator uses an explicit-consent flow for this optional feature.", "unknowns" :["The exact company operating the service in mainland China", "A guaranteed processing region for each API request", "API-content cache TTL, cache scope, opt-out mechanism, and fixed content-retention period"], "sources" :["https://mimo.mi.com/docs/en-US/api/chat/responses", "https://mimo.mi.com/docs/en-US/price/pay-as-you-go", "https://mimo.mi.com/docs/en-US/api/guidance/rate-limit", "https://mimo.mi.com/docs/en-US/api/guidance/error-codes", "https://mimo.mi.com/docs/quick-start/terms/user-agreement", "https://mimo.mi.com/docs/en-US/terms/privacy-policy"] }] }$manifest$::jsonb;
  v_content jsonb;
  v_instance uuid;
  v_previous_bundle text;
begin
  select
    d.id,
    d.content_digest
  into
    strict v_document,
    v_ai_digest
  from
    legal.bundles b
    join legal.document_versions d on d.id = b.ai_document_version_id
  where
    b.code = 'CURRENT_20261107'
    and b.time_sealed is not null;
  if (
    select
      content
    from
      legal.document_versions
    where
      id = v_document) is distinct from $common_ai$ { "zh" : { "title" :"AI 服务条款",
  "effectiveDate" :"2026 年 11 月 7 日",
  "intro" :["本 AI 服务条款管辖你对 cv maker（https://cvmaker.dyue.org）AI 润色功能的使用。本条款是使用条款与隐私政策的补充条款，与它们共同适用。", "我们为这项可选功能选择独立同意流程。首次使用当前版本前，你必须在功能界面中单独勾选同意；我们会记录用户 ID、所选提供方的精确披露内容版本、摘要与接受时间，以证明已获得授权。这是本服务运营者选择的披露与授权流程，不是对所有 AI 提供方通用要求的陈述。", "本版本由公共 AI 条款和所选提供方的披露共同组成。你可以从当前时间段允许的提供方和模型选项中选择，发送前会展示并要求接受对应的完整披露。切换提供方不代表自动同意其他披露。"],
  "sections" :[{ "heading" :"AI 润色功能", "body" :["AI 润色功能应你的请求改写简历中选定的自由文本字段，例如个人简介、要点描述和技能描述。它只改变措辞，不刻意改变事实、数字、雇主、职位等事实性内容，也绝不会自动应用任何修改。", "当你确认润色请求时，你选中的文本以及你选择包含的上下文会以明文经我们的服务器转发至请求时披露的第三方 AI 服务处理。网络传输使用 HTTPS 保护，但你的请求内容对我们的服务器和实际接收方均为可读——本功能不适用端到端加密（见下文「加密与 AI 润色」）。", "可选集合和默认选项由服务端配置及请求时间决定，你明确选择本次使用的提供方和模型。每个已冻结请求只使用一个已披露的 provider/model profile；provider 故障不会在同一请求内触发未披露的跨 provider 自动 fallback。"] }, { "heading" :"发送的内容", "body" :["我们不会主动发送简历页眉中的姓名、邮箱和电话——任何上下文级别都不会读取它们。但如果你选中的正文及上下文本身包含个人信息，这些信息仍会作为请求的一部分发送至 AI 服务。", "我们不会向 AI 服务发送你的邮箱、用户名或原始账户 ID。是否发送 HMAC-SHA256 假名标识符取决于实际 provider profile：当前 DeepSeek profile 会发送，初版 MiMo profile 不会发送；详见对应提供方附录。", "每次请求前，功能会如实展示将要发送的完整内容。请仔细检查披露内容，移除或避免包含你不愿分享的信息。你选择的上下文级别决定发送范围："], "bullets" :["Level 0（仅原文）：只发送你选中的正文文本，以及你设置的风格预设或自定义风格指令（如有）。", "Level 1（相邻条目）：在 Level 0 的基础上，额外发送所选范围的元信息（如公司或机构名称、项目标题与详情、教育经历的机构/名称/详情、研究标题与日期、技能类别），以及同一条目或同一章节内未被选中的相邻条目文本。", "Level 2（简介与技能）：在 Level 1 的基础上，再额外发送你的个人简介正文与技能标签。"] }, { "heading" :"我们存储的内容", "body" :["我们不会在服务器上刻意存储你发送用于润色的简历正文或 AI 生成的输出。请求内容仅在内存中处理，响应返回后即被丢弃。", "我们会保留每次请求与尝试的元数据 ledger/log，例如：请求时间戳、你的用户 ID、请求/尝试 ID、冻结的 route/profile/price/legal bundle、润色粒度、条目数量、上下文级别、语言、模型与提示词/校验器版本、尝试次数、完成状态或失败阶段、可解释的 token/缓存用量、耗时、成本与配额结算结果。这些日志绝不包含你的简历正文、AI 输出或风格指令。若 provider usage 无法可靠解释，对应明细或成本会保持未知而不是猜测。", "请求元数据日志在请求结束 90 天后、按分钟的频率限制计数在 2 天后、按天的用量聚合在 90 天后进入删除计划。删除由每天运行一次的清理任务执行，因此每条记录会在越过保留阈值后的首次计划运行时被删除，最多可能多保留约一天。你对本 AI 服务条款的同意记录会保留至你删除账户为止。"] }, { "heading" :"使用限制、配额与取消", "body" :["AI 润色目前为免费功能，设有使用限制：每用户每天最多 20 次请求（UTC 零点重置）、每分钟最多 3 次；全服务另设有每日总容量上限，达到后功能会暂时不可用。我们可能会调整这些限制；对于滥用、过度使用或给服务带来风险的情况，我们可能会暂停访问权限。", "请求被接受时会预留配额。若请求在已发送给 AI 服务后被取消或中断，该次配额仍会计入，因为提供方处理或成本已经发生；若在发送前失败，或按服务结算规则属于可返还的提供方/校验失败，预留配额会被返还。重试属于同一冻结 route 下的尝试，不会静默改用另一提供方。"] }, { "heading" :"提供方、路由与政策变化", "body" :["当前 legal bundle 列出 DeepSeek 官方开放平台与 MiMo 官方 API。列入附录并不表示该 profile 已激活；实际接收方以请求前披露并由服务端冻结的 route 为准。", "第三方按其自身条款与政策处理收到的内容，我们无法控制。请勿发送敏感、机密或不愿由实际接收方处理的信息。", "新增接收方、upstream、处理地区，或缓存、留存、训练/改进政策发生实质变化时，我们会更新附录和版本，并在需要时要求你重新同意。旧版本同意不能授权需要新 legal bundle 的 route。"] }, { "heading" :"AI 输出需要你审阅", "body" :["AI 生成的建议可能不准确、不完整、有偏见或不合适，也可能以非预期的方式改变语义或侧重。它们仅作为起草建议提供。", "润色后的文本绝不会自动应用。你必须逐条审阅并明确接受或拒绝每条建议。你对简历的最终内容负全部责任。"] }, { "heading" :"加密与 AI 润色", "body" :["端到端加密（如可用）仅保护你云端保存的简历静态数据，不适用于 AI 润色功能。", "当你对加密的简历使用 AI 润色时，选中的明文会离开你的设备，经我们的服务器发送至 AI 服务。你简历的其余加密部分仍按隐私政策所述受到保护。"] }, { "heading" :"变更", "body" :["我们可能会不时更新本 AI 服务条款。如果变更具有实质性，我们将更新生效日期，并要求你重新同意后方能继续使用 AI 润色。"] }, { "heading" :"联系我们", "body" :["如有关于本 AI 服务条款的问题，请联系 Yue, operator of cv maker。", "邮箱：cvmaker@dyue.org", "网站：https://cvmaker.dyue.org"] }] }, "en" : { "title" :"AI Service Terms", "effectiveDate" :"November 7, 2026", "intro" :["These AI Service Terms govern your use of the AI polish feature of cv maker at https://cvmaker.dyue.org. They supplement the Terms of Use and the Privacy Policy and apply together with them.", "We chose a separate-consent flow for this optional feature. Before first use of the current version, you must separately accept it in the feature interface; we record your user ID, the exact selected-provider disclosure version and digest, and acceptance time to demonstrate authorization. This is the service operator's chosen disclosure and authorization flow, not a statement that all AI providers universally require separate consent.", "This version consists of common AI terms and the selected provider disclosure. You can choose among the provider and model options available for the current time period. The complete matching disclosure is displayed and requires acceptance before transmission. Selecting another provider does not automatically accept its disclosure."], "sections" :[{ "heading" :"The AI Polish Feature", "body" :["AI polish rewrites selected free-text fields of your resume at your request, such as profile summaries, bullet points, and skill descriptions. It is intended to change wording only, not facts, figures, employers, job titles, or other factual content, and it never applies changes automatically.", "When you confirm a polish request, the text you selected, together with any context you choose to include, is forwarded in plaintext through our server to the third-party AI service disclosed for that request. Network transmission uses HTTPS, but your request content is readable by our server and the actual recipient — end-to-end encryption does not apply to this feature (see \"Encryption and AI Polish\" below).", "The available options and default are determined by server-side configuration and request time; you explicitly select the provider and model for the request. Each frozen request uses one disclosed provider/model profile; a provider failure does not trigger an undisclosed automatic cross-provider fallback within that request."] }, { "heading" :"What Is Sent", "body" :["We do not actively send the name, email address, or phone number from your resume header — they are never read at any context level. However, any personal information contained in the text and context you select will still be sent to the AI provider as part of your request.", "We never send your email address, username, or raw account ID to the AI provider. Whether an HMAC-SHA256 pseudonymous identifier is sent depends on the actual provider profile: the current DeepSeek profile sends one, while the initial MiMo profile does not. See the applicable provider annex.", "Before each request, the feature shows you exactly what will be sent. Review this disclosure carefully and remove or avoid content you do not want to share. The context level you choose determines the scope:"], "bullets" :["Level 0 (text only): only the texts you selected, plus the style preset or custom style instruction if you set one.", "Level 1 (sibling items): in addition to Level 0, scope metadata (such as company or organization names, project titles and details, education institution/title/details, research titles and dates, and skill categories) and the unselected sibling text items in the same entry or section.", "Level 2 (profile & skills): in addition to Level 1, your profile summary bodies and your skill labels."] }, { "heading" :"What We Store", "body" :["We do not intentionally store the resume text you send for polishing or the AI-generated output on our servers. Request content is processed in memory and discarded after the response is returned.", "We keep metadata ledgers/logs about each request and attempt, such as: request timestamps, your user ID, request/attempt IDs, the frozen route/profile/price/legal bundle, polish granularity, item count, context level, language, model and prompt/validator versions, attempt count, completion status or failure stage, explainable token/cache usage, latency, cost, and the quota settlement outcome. These logs never include your resume text, the AI output, or your style instructions. If provider usage cannot be interpreted reliably, the relevant usage detail or cost remains unknown rather than being guessed.", "Request metadata logs are scheduled for deletion 90 days after the request completes, per-minute rate-limit counters after 2 days, and daily usage aggregates after 90 days. Deletion is performed by a cleanup job that runs once per day, so each record is deleted at the first scheduled run after it crosses its retention threshold and may remain for up to roughly one additional day. Records of your acceptance of these AI Service Terms are kept until you delete your account."] }, { "heading" :"Usage Limits, Quota, and Cancellation", "body" :["AI polish is currently a free feature with usage limits: at most 20 requests per user per day (reset at midnight UTC) and at most 3 requests per minute; a service-wide daily capacity limit also applies, after which the feature becomes temporarily unavailable. We may adjust these limits, and we may suspend access in cases of abuse, excessive use, or risk to the service.", "Quota is reserved when a request is accepted. If you cancel or interrupt it after it has been sent to the AI provider, the quota remains charged because provider processing or cost has occurred. If it fails before transmission, or the service's settlement rules classify a provider/validation failure as refundable, the reservation is refunded. Retries are attempts under the same frozen route and do not silently switch to another provider."] }, { "heading" :"Providers, Routing, and Policy Changes", "body" :["The current legal bundle lists the official DeepSeek Open Platform and the official MiMo API. Inclusion in an annex does not mean that a profile is active; the actual recipient is the route disclosed before the request and frozen by the server.", "Each third party processes received content under its own terms and policies, which we do not control. Do not send sensitive, confidential, or other information that you do not want the actual recipient to process.", "If we add a recipient, upstream, or processing region, or materially change caching, retention, training, or improvement policies, we will update the annexes and version and require renewed acceptance where needed. Acceptance of an old version cannot authorize a route that requires a new legal bundle."] }, { "heading" :"AI Output Requires Your Review", "body" :["AI-generated suggestions may be inaccurate, incomplete, biased, or unsuitable, and may alter meaning or emphasis in unintended ways. They are provided as drafting suggestions only.", "Polished text is never applied automatically. You must review each suggestion and explicitly accept or reject it. You are solely responsible for the final content of your resume."] }, { "heading" :"Encryption and AI Polish", "body" :["End-to-end encryption, where available, protects only your cloud-saved resume data at rest. It does not apply to AI polish.", "When you use AI polish on an encrypted resume, the selected plaintext leaves your device and is sent through our server to the AI provider. The rest of your encrypted resume remains protected as described in the Privacy Policy."] }, { "heading" :"Changes", "body" :["We may update these AI Service Terms from time to time. If changes are material, we will update the effective date and require you to accept the new version before using AI polish again."] }, { "heading" :"Contact", "body" :["For questions about these AI Service Terms, contact Yue, operator of cv maker.", "Email: cvmaker@dyue.org", "Website: https://cvmaker.dyue.org"] }] } }$common_ai$::jsonb then
    perform
      common.fail ('CONFLICT', 'REVIEWED_COMMON_AI_TERMS_MISMATCH');
  end if;
  v_bundle = common.insert_entity ('legal.bundles', jsonb_build_object('code', 'CV_APP_RESPONSES_20261107', 'ai_document_version_id', v_document, 'manifest', v_manifest, 'manifest_digest', common.digest(v_manifest)));
  for v_item in
  select
    *
  from
    jsonb_array_elements($disclosures$[{ "provider_code" :"DEEPSEEK", "disclosure_code" :"DEEPSEEK_RESPONSES_DEEPSEEK_FLASH_20261107", "recipient_code" :"DEEPSEEK", "model_id" :"deepseek-flash", "content" : { "en" : { "providerLabel" :"Official DeepSeek Open Platform", "modelLabel" :"deepseek-flash (Responses API profile)", "blocks" :[{ "kind" :"paragraph", "text" :"These AI Service Terms govern your use of the AI polish feature of cv maker at https://cvmaker.dyue.org. They supplement the Terms of Use and the Privacy Policy and apply together with them.\n\nWe chose a separate-consent flow for this optional feature. Before first use of the current version, you must separately accept it in the feature interface; we record your user ID, the exact selected-provider disclosure version and digest, and acceptance time to demonstrate authorization. This is the service operator's chosen disclosure and authorization flow, not a statement that all AI providers universally require separate consent.\n\nThis version consists of common AI terms and the selected provider disclosure. You can choose among the provider and model options available for the current time period. The complete matching disclosure is displayed and requires acceptance before transmission. Selecting another provider does not automatically accept its disclosure.\n\nThe AI Polish Feature\n\nAI polish rewrites selected free-text fields of your resume at your request, such as profile summaries, bullet points, and skill descriptions. It is intended to change wording only, not facts, figures, employers, job titles, or other factual content, and it never applies changes automatically.\n\nWhen you confirm a polish request, the text you selected, together with any context you choose to include, is forwarded in plaintext through our server to the third-party AI service disclosed for that request. Network transmission uses HTTPS, but your request content is readable by our server and the actual recipient — end-to-end encryption does not apply to this feature (see \"Encryption and AI Polish\" below).\n\nThe available options and default are determined by server-side configuration and request time; you explicitly select the provider and model for the request. Each frozen request uses one disclosed provider/model profile; a provider failure does not trigger an undisclosed automatic cross-provider fallback within that request.\n\nWhat Is Sent\n\nWe do not actively send the name, email address, or phone number from your resume header — they are never read at any context level. However, any personal information contained in the text and context you select will still be sent to the AI provider as part of your request.\n\nWe never send your email address, username, or raw account ID to the AI provider. Whether an HMAC-SHA256 pseudonymous identifier is sent depends on the actual provider profile: the current DeepSeek profile sends one, while the initial MiMo profile does not. See the applicable provider annex.\n\nBefore each request, the feature shows you exactly what will be sent. Review this disclosure carefully and remove or avoid content you do not want to share. The context level you choose determines the scope:" }, { "kind" :"bulletList", "items" :["Level 0 (text only): only the texts you selected, plus the style preset or custom style instruction if you set one.", "Level 1 (sibling items): in addition to Level 0, scope metadata (such as company or organization names, project titles and details, education institution/title/details, research titles and dates, and skill categories) and the unselected sibling text items in the same entry or section.", "Level 2 (profile & skills): in addition to Level 1, your profile summary bodies and your skill labels."] }, { "kind" :"paragraph", "text" :"What We Store\n\nWe do not intentionally store the resume text you send for polishing or the AI-generated output on our servers. Request content is processed in memory and discarded after the response is returned.\n\nWe keep metadata ledgers/logs about each request and attempt, such as: request timestamps, your user ID, request/attempt IDs, the frozen route/profile/price/legal bundle, polish granularity, item count, context level, language, model and prompt/validator versions, attempt count, completion status or failure stage, explainable token/cache usage, latency, cost, and the quota settlement outcome. These logs never include your resume text, the AI output, or your style instructions. If provider usage cannot be interpreted reliably, the relevant usage detail or cost remains unknown rather than being guessed.\n\nRequest metadata logs are scheduled for deletion 90 days after the request completes, per-minute rate-limit counters after 2 days, and daily usage aggregates after 90 days. Deletion is performed by a cleanup job that runs once per day, so each record is deleted at the first scheduled run after it crosses its retention threshold and may remain for up to roughly one additional day. Records of your acceptance of these AI Service Terms are kept until you delete your account.\n\nUsage Limits, Quota, and Cancellation\n\nAI polish is currently a free feature with usage limits: at most 20 requests per user per day (reset at midnight UTC) and at most 3 requests per minute; a service-wide daily capacity limit also applies, after which the feature becomes temporarily unavailable. We may adjust these limits, and we may suspend access in cases of abuse, excessive use, or risk to the service.\n\nQuota is reserved when a request is accepted. If you cancel or interrupt it after it has been sent to the AI provider, the quota remains charged because provider processing or cost has occurred. If it fails before transmission, or the service's settlement rules classify a provider/validation failure as refundable, the reservation is refunded. Retries are attempts under the same frozen route and do not silently switch to another provider.\n\nProviders, Routing, and Policy Changes\n\nThe current legal bundle lists the official DeepSeek Open Platform and the official MiMo API. Inclusion in an annex does not mean that a profile is active; the actual recipient is the route disclosed before the request and frozen by the server.\n\nEach third party processes received content under its own terms and policies, which we do not control. Do not send sensitive, confidential, or other information that you do not want the actual recipient to process.\n\nIf we add a recipient, upstream, or processing region, or materially change caching, retention, training, or improvement policies, we will update the annexes and version and require renewed acceptance where needed. Acceptance of an old version cannot authorize a route that requires a new legal bundle.\n\nAI Output Requires Your Review\n\nAI-generated suggestions may be inaccurate, incomplete, biased, or unsuitable, and may alter meaning or emphasis in unintended ways. They are provided as drafting suggestions only.\n\nPolished text is never applied automatically. You must review each suggestion and explicitly accept or reject it. You are solely responsible for the final content of your resume.\n\nEncryption and AI Polish" }, { "kind" :"paragraph", "text" :"End-to-end encryption, where available, protects only your cloud-saved resume data at rest. It does not apply to AI polish.\n\nWhen you use AI polish on an encrypted resume, the selected plaintext leaves your device and is sent through our server to the AI provider. The rest of your encrypted resume remains protected as described in the Privacy Policy.\n\nChanges\n\nWe may update these AI Service Terms from time to time. If changes are material, we will update the effective date and require you to accept the new version before using AI polish again.\n\nProvider Annex: Official DeepSeek Open Platform\n\nManifest ID: deepseek-official-responses-2026-11-07-v1; display key: deepseek-official-responses-v1; reviewed: Responses API technical facts: 2026-11-07; policy evidence retained from 2026-08-23 (Asia/Shanghai).\n\nProvider: Official DeepSeek Open Platform. Gateway/operator: Hangzhou DeepSeek Artificial Intelligence Co., Ltd.. Model vendor: DeepSeek. Models: deepseek-flash (Responses API profile). Upstream: Official DeepSeek Responses API (https://api.deepseek.com/responses).\n\nSubmitted data: The resume text selected by the user, chosen context, and style instructions; An HMAC-SHA256 pseudonymous identifier in the Responses API user field; no email address, username, or raw account ID. Provider subject ID: An HMAC-SHA256 pseudonymous identifier is sent in the Responses API user field. DeepSeek documents it for content safety, cache isolation, and scheduling isolation.\n\nProcessing region: DeepSeek's general Privacy Policy describes processing and storage in the People's Republic of China, but it expressly excludes products and services provided by downstream users. It therefore does not establish a location for content that this service submits through the Open Platform API. The API-specific processing location and region are unverified.\n\nCaching: Official API documentation states that disk context caching is enabled by default and that an unused cache is usually cleared automatically within a few hours to a few days.\n\nRetention: DeepSeek describes Responses as stateless, without stored response or conversation state. The store request parameter is unsupported and is not sent; responses carry store:false. This does not establish zero retention of caches or safety logs. We found no fixed overall retention period or zero-retention commitment for API content.\n\nTraining/service improvement: DeepSeek's Terms of Use, which defines its Services to include APIs, describes limited use of de-identified data to improve the Services. The Open Platform Terms do not grant DeepSeek training use: their model-training clause concerns what the developer may do with inputs and outputs. We found no API-specific no-training commitment or opt-out.\n\nTransfer mechanism: The API-specific processing location and transfer path are unverified. Where applicable law requires it, the service operator uses an explicit-consent flow for this optional feature; this is the operator's chosen authorization flow, not a claim that API content is processed in any particular location or a universal legal conclusion for every user or transfer.\n\nUnresolved: Specific retention and deletion periods for API content beyond context caching; The API-specific processing/storage location, transfer path, and whether any opt-out covers API requests. Database configuration and product copy must not turn these unknowns into guarantees.\n\nSources reviewed:" }, { "kind" :"paragraph", "text" :"Official source 1: https://api-docs.deepseek.com/quick_start/pricing/ https://api-docs.deepseek.com/quick_start/pricing/\n\nOfficial source 2: https://api-docs.deepseek.com/api/create-response/ https://api-docs.deepseek.com/api/create-response/\n\nOfficial source 3: https://api-docs.deepseek.com/guides/responses_api/ https://api-docs.deepseek.com/guides/responses_api/\n\nOfficial source 4: https://api-docs.deepseek.com/quick_start/rate_limit/ https://api-docs.deepseek.com/quick_start/rate_limit/\n\nOfficial source 5: https://api-docs.deepseek.com/guides/kv_cache/ https://api-docs.deepseek.com/guides/kv_cache/\n\nOfficial source 6: https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html\n\nOfficial source 7: https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html\n\nOfficial source 8: https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html\n\nOfficial source 9: https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html\n\nContact\n\nFor questions about these AI Service Terms, contact Yue, operator of cv maker.\n\nEmail: cvmaker@dyue.org\n\nWebsite: https://cvmaker.dyue.org" }] }, "zh" : { "providerLabel" :"DeepSeek 官方开放平台", "modelLabel" :"deepseek-flash（Responses API profile）", "blocks" :[{ "kind" :"paragraph", "text" :"本 AI 服务条款管辖你对 cv maker（https://cvmaker.dyue.org）AI 润色功能的使用。本条款是使用条款与隐私政策的补充条款，与它们共同适用。\n\n我们为这项可选功能选择独立同意流程。首次使用当前版本前，你必须在功能界面中单独勾选同意；我们会记录用户 ID、所选提供方的精确披露内容版本、摘要与接受时间，以证明已获得授权。这是本服务运营者选择的披露与授权流程，不是对所有 AI 提供方通用要求的陈述。\n\n本版本由公共 AI 条款和所选提供方的披露共同组成。你可以从当前时间段允许的提供方和模型选项中选择，发送前会展示并要求接受对应的完整披露。切换提供方不代表自动同意其他披露。\n\nAI 润色功能\n\nAI 润色功能应你的请求改写简历中选定的自由文本字段，例如个人简介、要点描述和技能描述。它只改变措辞，不刻意改变事实、数字、雇主、职位等事实性内容，也绝不会自动应用任何修改。\n\n当你确认润色请求时，你选中的文本以及你选择包含的上下文会以明文经我们的服务器转发至请求时披露的第三方 AI 服务处理。网络传输使用 HTTPS 保护，但你的请求内容对我们的服务器和实际接收方均为可读——本功能不适用端到端加密（见下文「加密与 AI 润色」）。\n\n可选集合和默认选项由服务端配置及请求时间决定，你明确选择本次使用的提供方和模型。每个已冻结请求只使用一个已披露的 provider/model profile；provider 故障不会在同一请求内触发未披露的跨 provider 自动 fallback。\n\n发送的内容\n\n我们不会主动发送简历页眉中的姓名、邮箱和电话——任何上下文级别都不会读取它们。但如果你选中的正文及上下文本身包含个人信息，这些信息仍会作为请求的一部分发送至 AI 服务。\n\n我们不会向 AI 服务发送你的邮箱、用户名或原始账户 ID。是否发送 HMAC-SHA256 假名标识符取决于实际 provider profile：当前 DeepSeek profile 会发送，初版 MiMo profile 不会发送；详见对应提供方附录。\n\n每次请求前，功能会如实展示将要发送的完整内容。请仔细检查披露内容，移除或避免包含你不愿分享的信息。你选择的上下文级别决定发送范围：" }, { "kind" :"bulletList", "items" :["Level 0（仅原文）：只发送你选中的正文文本，以及你设置的风格预设或自定义风格指令（如有）。", "Level 1（相邻条目）：在 Level 0 的基础上，额外发送所选范围的元信息（如公司或机构名称、项目标题与详情、教育经历的机构/名称/详情、研究标题与日期、技能类别），以及同一条目或同一章节内未被选中的相邻条目文本。", "Level 2（简介与技能）：在 Level 1 的基础上，再额外发送你的个人简介正文与技能标签。"] }, { "kind" :"paragraph", "text" :"我们存储的内容\n\n我们不会在服务器上刻意存储你发送用于润色的简历正文或 AI 生成的输出。请求内容仅在内存中处理，响应返回后即被丢弃。\n\n我们会保留每次请求与尝试的元数据 ledger/log，例如：请求时间戳、你的用户 ID、请求/尝试 ID、冻结的 route/profile/price/legal bundle、润色粒度、条目数量、上下文级别、语言、模型与提示词/校验器版本、尝试次数、完成状态或失败阶段、可解释的 token/缓存用量、耗时、成本与配额结算结果。这些日志绝不包含你的简历正文、AI 输出或风格指令。若 provider usage 无法可靠解释，对应明细或成本会保持未知而不是猜测。\n\n请求元数据日志在请求结束 90 天后、按分钟的频率限制计数在 2 天后、按天的用量聚合在 90 天后进入删除计划。删除由每天运行一次的清理任务执行，因此每条记录会在越过保留阈值后的首次计划运行时被删除，最多可能多保留约一天。你对本 AI 服务条款的同意记录会保留至你删除账户为止。\n\n使用限制、配额与取消\n\nAI 润色目前为免费功能，设有使用限制：每用户每天最多 20 次请求（UTC 零点重置）、每分钟最多 3 次；全服务另设有每日总容量上限，达到后功能会暂时不可用。我们可能会调整这些限制；对于滥用、过度使用或给服务带来风险的情况，我们可能会暂停访问权限。\n\n请求被接受时会预留配额。若请求在已发送给 AI 服务后被取消或中断，该次配额仍会计入，因为提供方处理或成本已经发生；若在发送前失败，或按服务结算规则属于可返还的提供方/校验失败，预留配额会被返还。重试属于同一冻结 route 下的尝试，不会静默改用另一提供方。\n\n提供方、路由与政策变化\n\n当前 legal bundle 列出 DeepSeek 官方开放平台与 MiMo 官方 API。列入附录并不表示该 profile 已激活；实际接收方以请求前披露并由服务端冻结的 route 为准。\n\n第三方按其自身条款与政策处理收到的内容，我们无法控制。请勿发送敏感、机密或不愿由实际接收方处理的信息。\n\n新增接收方、upstream、处理地区，或缓存、留存、训练/改进政策发生实质变化时，我们会更新附录和版本，并在需要时要求你重新同意。旧版本同意不能授权需要新 legal bundle 的 route。\n\nAI 输出需要你审阅\n\nAI 生成的建议可能不准确、不完整、有偏见或不合适，也可能以非预期的方式改变语义或侧重。它们仅作为起草建议提供。\n\n润色后的文本绝不会自动应用。你必须逐条审阅并明确接受或拒绝每条建议。你对简历的最终内容负全部责任。\n\n加密与 AI 润色\n\n端到端加密（如可用）仅保护你云端保存的简历静态数据，不适用于 AI 润色功能。\n\n当你对加密的简历使用 AI 润色时，选中的明文会离开你的设备，经我们的服务器发送至 AI 服务。你简历的其余加密部分仍按隐私政策所述受到保护。\n\n变更\n\n我们可能会不时更新本 AI 服务条款。如果变更具有实质性，我们将更新生效日期，并要求你重新同意后方能继续使用 AI 润色。\n\n提供方附录：DeepSeek 官方开放平台\n\nManifest ID：deepseek-official-responses-2026-11-07-v1；显示键：deepseek-official-responses-v1；核验时间：Responses API 技术事实：2026-11-07；政策证据沿用 2026-08-23（Asia/Shanghai）。\n\n提供方：DeepSeek 官方开放平台。Gateway/operator：杭州深度求索人工智能有限公司（DeepSeek）。模型提供方：DeepSeek。模型：deepseek-flash（Responses API profile）。Upstream：DeepSeek 官方 Responses API（https://api.deepseek.com/responses）。\n\n发送内容：用户选中的简历正文、所选上下文以及风格指令；通过 Responses API user 字段发送的 HMAC-SHA256 假名标识；不发送邮箱、用户名或原始账户 ID。Provider subject ID：通过 Responses API 的 user 字段发送 HMAC-SHA256 假名标识；DeepSeek 文档称其用于内容安全、缓存隔离与调度隔离。\n\n处理地区：DeepSeek 的一般隐私政策说明会在中华人民共和国境内处理和存储数据，但该政策明确排除下游用户提供的产品和服务，因此不能据此确定本服务通过开放平台 API 提交内容的处理地点。API 特定的处理地点和区域尚未核实。\n\n缓存：官方 API 文档说明磁盘上下文缓存默认启用；不再使用的缓存通常会在数小时至数天内自动清除。\n\n留存：DeepSeek 将 Responses API 描述为无状态，不保存可续接的响应或会话状态。store 请求参数不受支持，本服务不发送该参数；响应中的 store 固定为 false。这不构成缓存或安全日志零留存保证，未找到适用于 API 内容的固定总保留期限或零保留承诺。\n\n训练/服务改进：DeepSeek 使用条款将 API 纳入“服务”范围，并说明会在有限范围内使用去标识化数据改进服务。开放平台条款并未授予 DeepSeek 训练使用权，其中关于模型训练的条款描述的是开发者可如何使用输入和输出。未找到 API 特定的不训练承诺或退出机制。\n\n传输机制：API 特定的处理地点和传输路径尚未核实。适用法律要求时，本服务运营者为这项可选功能采用明示同意流程；这是运营者选择的授权流程，不表示 API 内容在任何特定地点处理，也并非对所有用户或传输情形作出的通用法律结论。\n\n尚未确认：API 内容除上下文缓存外的具体保留和删除期限；API 特定的处理/存储地点、传输路径以及任何退出机制是否覆盖 API 请求。这些未知事项不得由 DB 配置或产品文案改写为保证。\n\n核验来源：\n\n官方来源 1：https://api-docs.deepseek.com/quick_start/pricing/ https://api-docs.deepseek.com/quick_start/pricing/\n\n官方来源 2：https://api-docs.deepseek.com/api/create-response/ https://api-docs.deepseek.com/api/create-response/\n\n官方来源 3：https://api-docs.deepseek.com/guides/responses_api/ https://api-docs.deepseek.com/guides/responses_api/\n\n官方来源 4：https://api-docs.deepseek.com/quick_start/rate_limit/ https://api-docs.deepseek.com/quick_start/rate_limit/\n\n官方来源 5：https://api-docs.deepseek.com/guides/kv_cache/ https://api-docs.deepseek.com/guides/kv_cache/\n\n官方来源 6：https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html\n\n官方来源 7：https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html" }, { "kind" :"paragraph", "text" :"官方来源 8：https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html\n\n官方来源 9：https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html\n\n联系我们\n\n如有关于本 AI 服务条款的问题，请联系 Yue, operator of cv maker。\n\n邮箱：cvmaker@dyue.org\n\n网站：https://cvmaker.dyue.org" }] } } }, { "provider_code" :"MIMO", "disclosure_code" :"MIMO_CURRENT", "recipient_code" :"MIMO", "model_id" :"mimo-v2.5-pro", "content" : { "zh" : { "providerLabel" :"MiMo 官方 API（中国大陆 profile）", "modelLabel" :"mimo-v2.5-pro（Responses API profile）", "blocks" :[{ "kind" :"paragraph", "text" :"本 AI 服务条款管辖你对 cv maker（https://cvmaker.dyue.org）AI 润色功能的使用。本条款是使用条款与隐私政策的补充条款，与它们共同适用。\n\n我们为这项可选功能选择独立同意流程。首次使用当前版本前，你必须在功能界面中单独勾选同意；我们会记录用户 ID、所选提供方的精确披露内容版本、摘要与接受时间，以证明已获得授权。这是本服务运营者选择的披露与授权流程，不是对所有 AI 提供方通用要求的陈述。\n\n本版本由公共 AI 条款和所选提供方的披露共同组成。你可以从当前时间段允许的提供方和模型选项中选择，发送前会展示并要求接受对应的完整披露。切换提供方不代表自动同意其他披露。\n\nAI 润色功能\n\nAI 润色功能应你的请求改写简历中选定的自由文本字段，例如个人简介、要点描述和技能描述。它只改变措辞，不刻意改变事实、数字、雇主、职位等事实性内容，也绝不会自动应用任何修改。\n\n当你确认润色请求时，你选中的文本以及你选择包含的上下文会以明文经我们的服务器转发至请求时披露的第三方 AI 服务处理。网络传输使用 HTTPS 保护，但你的请求内容对我们的服务器和实际接收方均为可读——本功能不适用端到端加密（见下文「加密与 AI 润色」）。\n\n可选集合和默认选项由服务端配置及请求时间决定，你明确选择本次使用的提供方和模型。每个已冻结请求只使用一个已披露的 provider/model profile；provider 故障不会在同一请求内触发未披露的跨 provider 自动 fallback。\n\n发送的内容\n\n我们不会主动发送简历页眉中的姓名、邮箱和电话——任何上下文级别都不会读取它们。但如果你选中的正文及上下文本身包含个人信息，这些信息仍会作为请求的一部分发送至 AI 服务。\n\n我们不会向 AI 服务发送你的邮箱、用户名或原始账户 ID。是否发送 HMAC-SHA256 假名标识符取决于实际 provider profile：当前 DeepSeek profile 会发送，初版 MiMo profile 不会发送；详见对应提供方附录。\n\n每次请求前，功能会如实展示将要发送的完整内容。请仔细检查披露内容，移除或避免包含你不愿分享的信息。你选择的上下文级别决定发送范围：" }, { "kind" :"bulletList", "items" :["Level 0（仅原文）：只发送你选中的正文文本，以及你设置的风格预设或自定义风格指令（如有）。", "Level 1（相邻条目）：在 Level 0 的基础上，额外发送所选范围的元信息（如公司或机构名称、项目标题与详情、教育经历的机构/名称/详情、研究标题与日期、技能类别），以及同一条目或同一章节内未被选中的相邻条目文本。", "Level 2（简介与技能）：在 Level 1 的基础上，再额外发送你的个人简介正文与技能标签。"] }, { "kind" :"paragraph", "text" :"我们存储的内容\n\n我们不会在服务器上刻意存储你发送用于润色的简历正文或 AI 生成的输出。请求内容仅在内存中处理，响应返回后即被丢弃。\n\n我们会保留每次请求与尝试的元数据 ledger/log，例如：请求时间戳、你的用户 ID、请求/尝试 ID、冻结的 route/profile/price/legal bundle、润色粒度、条目数量、上下文级别、语言、模型与提示词/校验器版本、尝试次数、完成状态或失败阶段、可解释的 token/缓存用量、耗时、成本与配额结算结果。这些日志绝不包含你的简历正文、AI 输出或风格指令。若 provider usage 无法可靠解释，对应明细或成本会保持未知而不是猜测。\n\n请求元数据日志在请求结束 90 天后、按分钟的频率限制计数在 2 天后、按天的用量聚合在 90 天后进入删除计划。删除由每天运行一次的清理任务执行，因此每条记录会在越过保留阈值后的首次计划运行时被删除，最多可能多保留约一天。你对本 AI 服务条款的同意记录会保留至你删除账户为止。\n\n使用限制、配额与取消\n\nAI 润色目前为免费功能，设有使用限制：每用户每天最多 20 次请求（UTC 零点重置）、每分钟最多 3 次；全服务另设有每日总容量上限，达到后功能会暂时不可用。我们可能会调整这些限制；对于滥用、过度使用或给服务带来风险的情况，我们可能会暂停访问权限。\n\n请求被接受时会预留配额。若请求在已发送给 AI 服务后被取消或中断，该次配额仍会计入，因为提供方处理或成本已经发生；若在发送前失败，或按服务结算规则属于可返还的提供方/校验失败，预留配额会被返还。重试属于同一冻结 route 下的尝试，不会静默改用另一提供方。\n\n提供方、路由与政策变化\n\n当前 legal bundle 列出 DeepSeek 官方开放平台与 MiMo 官方 API。列入附录并不表示该 profile 已激活；实际接收方以请求前披露并由服务端冻结的 route 为准。\n\n第三方按其自身条款与政策处理收到的内容，我们无法控制。请勿发送敏感、机密或不愿由实际接收方处理的信息。\n\n新增接收方、upstream、处理地区，或缓存、留存、训练/改进政策发生实质变化时，我们会更新附录和版本，并在需要时要求你重新同意。旧版本同意不能授权需要新 legal bundle 的 route。\n\nAI 输出需要你审阅\n\nAI 生成的建议可能不准确、不完整、有偏见或不合适，也可能以非预期的方式改变语义或侧重。它们仅作为起草建议提供。\n\n润色后的文本绝不会自动应用。你必须逐条审阅并明确接受或拒绝每条建议。你对简历的最终内容负全部责任。\n\n加密与 AI 润色\n\n端到端加密（如可用）仅保护你云端保存的简历静态数据，不适用于 AI 润色功能。\n\n当你对加密的简历使用 AI 润色时，选中的明文会离开你的设备，经我们的服务器发送至 AI 服务。你简历的其余加密部分仍按隐私政策所述受到保护。\n\n变更\n\n我们可能会不时更新本 AI 服务条款。如果变更具有实质性，我们将更新生效日期，并要求你重新同意后方能继续使用 AI 润色。\n\n联系我们\n\n如有关于本 AI 服务条款的问题，请联系 Yue, operator of cv maker。\n\n邮箱：cvmaker@dyue.org\n\n网站：https://cvmaker.dyue.org\n\n提供方附录：MiMo 官方 API（中国大陆 profile）\n\nManifest ID：mimo-cn-2026-08-23-v1；显示键：mimo-cn-v1；核验时间：2026-08-23（Asia/Shanghai）。\n\n提供方：MiMo 官方 API（中国大陆 profile）。Gateway/operator：MiMo 官方 API；已核验页面未明确给出中国大陆适用运营主体的具体公司名称。中国大陆以外服务的条款列明 Xiaomi Technologies Singapore Pte. Ltd.。。模型提供方：Xiaomi / MiMo。模型：mimo-v2.5-pro（Responses API profile）。Upstream：MiMo 官方 Responses API（api.xiaomimimo.com/v1/responses）。\n\n发送内容：用户选中的简历正文、所选上下文以及风格指令；初版 adapter 不发送 HMAC provider subject ID、邮箱、用户名或原始账户 ID。Provider subject ID：不发送 provider subject ID。\n\n处理地区：隐私政策说明使用全球数据中心，包括荷兰和新加坡，并可能发生其他参与方或地区的传输；实际请求区域取决于请求或另行安排，未作固定区域保证。\n\n缓存：API 内容缓存的固定 TTL、作用域和退出机制未能从已核验官方资料确认。\n\n留存：隐私政策采用目的所需期间后删除或匿名化的一般规则；未提供 API 内容的固定数字 TTL。\n\n训练/服务改进：MiMo 将用户视为控制者、将自身描述为处理者，并称提交的 API 内容不用于模型训练或其他目的。\n\n传输机制：中国大陆访问适用中国大陆条款；跨境或其他地区处理取决于请求和安排。适用法律要求时，本服务运营者为这项可选功能采用明示同意流程。\n\n尚未确认：中国大陆适用服务运营主体的确切公司名称；每次 API 请求的保证处理区域；API 内容缓存 TTL、缓存作用域、退出机制与固定内容保留期限。这些未知事项不得由 DB 配置或产品文案改写为保证。\n\n核验来源：\n\n官方来源 1：https://mimo.mi.com/docs/en-US/api/chat/responses https://mimo.mi.com/docs/en-US/api/chat/responses\n\n官方来源 2：https://mimo.mi.com/docs/en-US/price/pay-as-you-go https://mimo.mi.com/docs/en-US/price/pay-as-you-go\n\n官方来源 3：https://mimo.mi.com/docs/en-US/api/guidance/rate-limit https://mimo.mi.com/docs/en-US/api/guidance/rate-limit\n\n官方来源 4：https://mimo.mi.com/docs/en-US/api/guidance/error-codes https://mimo.mi.com/docs/en-US/api/guidance/error-codes\n\n官方来源 5：https://mimo.mi.com/docs/quick-start/terms/user-agreement https://mimo.mi.com/docs/quick-start/terms/user-agreement\n\n官方来源 6：https://mimo.mi.com/docs/en-US/terms/privacy-policy https://mimo.mi.com/docs/en-US/terms/privacy-policy" }] }, "en" : { "providerLabel" :"Official MiMo API (mainland-China profile)", "modelLabel" :"mimo-v2.5-pro (Responses API profile)", "blocks" :[{ "kind" :"paragraph", "text" :"These AI Service Terms govern your use of the AI polish feature of cv maker at https://cvmaker.dyue.org. They supplement the Terms of Use and the Privacy Policy and apply together with them.\n\nWe chose a separate-consent flow for this optional feature. Before first use of the current version, you must separately accept it in the feature interface; we record your user ID, the exact selected-provider disclosure version and digest, and acceptance time to demonstrate authorization. This is the service operator's chosen disclosure and authorization flow, not a statement that all AI providers universally require separate consent.\n\nThis version consists of common AI terms and the selected provider disclosure. You can choose among the provider and model options available for the current time period. The complete matching disclosure is displayed and requires acceptance before transmission. Selecting another provider does not automatically accept its disclosure.\n\nThe AI Polish Feature\n\nAI polish rewrites selected free-text fields of your resume at your request, such as profile summaries, bullet points, and skill descriptions. It is intended to change wording only, not facts, figures, employers, job titles, or other factual content, and it never applies changes automatically.\n\nWhen you confirm a polish request, the text you selected, together with any context you choose to include, is forwarded in plaintext through our server to the third-party AI service disclosed for that request. Network transmission uses HTTPS, but your request content is readable by our server and the actual recipient — end-to-end encryption does not apply to this feature (see \"Encryption and AI Polish\" below).\n\nThe available options and default are determined by server-side configuration and request time; you explicitly select the provider and model for the request. Each frozen request uses one disclosed provider/model profile; a provider failure does not trigger an undisclosed automatic cross-provider fallback within that request.\n\nWhat Is Sent\n\nWe do not actively send the name, email address, or phone number from your resume header — they are never read at any context level. However, any personal information contained in the text and context you select will still be sent to the AI provider as part of your request.\n\nWe never send your email address, username, or raw account ID to the AI provider. Whether an HMAC-SHA256 pseudonymous identifier is sent depends on the actual provider profile: the current DeepSeek profile sends one, while the initial MiMo profile does not. See the applicable provider annex.\n\nBefore each request, the feature shows you exactly what will be sent. Review this disclosure carefully and remove or avoid content you do not want to share. The context level you choose determines the scope:" }, { "kind" :"bulletList", "items" :["Level 0 (text only): only the texts you selected, plus the style preset or custom style instruction if you set one.", "Level 1 (sibling items): in addition to Level 0, scope metadata (such as company or organization names, project titles and details, education institution/title/details, research titles and dates, and skill categories) and the unselected sibling text items in the same entry or section.", "Level 2 (profile & skills): in addition to Level 1, your profile summary bodies and your skill labels."] }, { "kind" :"paragraph", "text" :"What We Store\n\nWe do not intentionally store the resume text you send for polishing or the AI-generated output on our servers. Request content is processed in memory and discarded after the response is returned.\n\nWe keep metadata ledgers/logs about each request and attempt, such as: request timestamps, your user ID, request/attempt IDs, the frozen route/profile/price/legal bundle, polish granularity, item count, context level, language, model and prompt/validator versions, attempt count, completion status or failure stage, explainable token/cache usage, latency, cost, and the quota settlement outcome. These logs never include your resume text, the AI output, or your style instructions. If provider usage cannot be interpreted reliably, the relevant usage detail or cost remains unknown rather than being guessed.\n\nRequest metadata logs are scheduled for deletion 90 days after the request completes, per-minute rate-limit counters after 2 days, and daily usage aggregates after 90 days. Deletion is performed by a cleanup job that runs once per day, so each record is deleted at the first scheduled run after it crosses its retention threshold and may remain for up to roughly one additional day. Records of your acceptance of these AI Service Terms are kept until you delete your account.\n\nUsage Limits, Quota, and Cancellation\n\nAI polish is currently a free feature with usage limits: at most 20 requests per user per day (reset at midnight UTC) and at most 3 requests per minute; a service-wide daily capacity limit also applies, after which the feature becomes temporarily unavailable. We may adjust these limits, and we may suspend access in cases of abuse, excessive use, or risk to the service.\n\nQuota is reserved when a request is accepted. If you cancel or interrupt it after it has been sent to the AI provider, the quota remains charged because provider processing or cost has occurred. If it fails before transmission, or the service's settlement rules classify a provider/validation failure as refundable, the reservation is refunded. Retries are attempts under the same frozen route and do not silently switch to another provider.\n\nProviders, Routing, and Policy Changes\n\nThe current legal bundle lists the official DeepSeek Open Platform and the official MiMo API. Inclusion in an annex does not mean that a profile is active; the actual recipient is the route disclosed before the request and frozen by the server.\n\nEach third party processes received content under its own terms and policies, which we do not control. Do not send sensitive, confidential, or other information that you do not want the actual recipient to process.\n\nIf we add a recipient, upstream, or processing region, or materially change caching, retention, training, or improvement policies, we will update the annexes and version and require renewed acceptance where needed. Acceptance of an old version cannot authorize a route that requires a new legal bundle.\n\nAI Output Requires Your Review\n\nAI-generated suggestions may be inaccurate, incomplete, biased, or unsuitable, and may alter meaning or emphasis in unintended ways. They are provided as drafting suggestions only.\n\nPolished text is never applied automatically. You must review each suggestion and explicitly accept or reject it. You are solely responsible for the final content of your resume.\n\nEncryption and AI Polish\n\nEnd-to-end encryption, where available, protects only your cloud-saved resume data at rest. It does not apply to AI polish." }, { "kind" :"paragraph", "text" :"When you use AI polish on an encrypted resume, the selected plaintext leaves your device and is sent through our server to the AI provider. The rest of your encrypted resume remains protected as described in the Privacy Policy.\n\nChanges\n\nWe may update these AI Service Terms from time to time. If changes are material, we will update the effective date and require you to accept the new version before using AI polish again.\n\nContact\n\nFor questions about these AI Service Terms, contact Yue, operator of cv maker.\n\nEmail: cvmaker@dyue.org\n\nWebsite: https://cvmaker.dyue.org\n\nProvider Annex: Official MiMo API (mainland-China profile)\n\nManifest ID: mimo-cn-2026-08-23-v1; display key: mimo-cn-v1; reviewed: 2026-08-23 (Asia/Shanghai).\n\nProvider: Official MiMo API (mainland-China profile). Gateway/operator: Official MiMo API. The reviewed pages do not identify the specific company operating the service in mainland China. The terms for service outside mainland China name Xiaomi Technologies Singapore Pte. Ltd.. Model vendor: Xiaomi / MiMo. Models: mimo-v2.5-pro (Responses API profile). Upstream: Official MiMo Responses API (api.xiaomimimo.com/v1/responses).\n\nSubmitted data: The resume text selected by the user, chosen context, and style instructions; The initial adapter sends no HMAC provider subject ID, email address, username, or raw account ID. Provider subject ID: No provider subject ID is sent.\n\nProcessing region: The Privacy Policy describes global data centers, including the Netherlands and Singapore, and possible transfers involving other parties or regions. The actual request region depends on the request or a separate arrangement and is not guaranteed.\n\nCaching: We could not verify a fixed TTL, scope, or opt-out mechanism for API-content caching from the reviewed official materials.\n\nRetention: The Privacy Policy states a general rule of retaining data for the necessary period and then deleting or anonymizing it; it gives no fixed numeric TTL for API content.\n\nTraining/service improvement: MiMo describes the user as Controller and itself as Processor, and states that submitted API content is not used for model training or other purposes.\n\nTransfer mechanism: Access from mainland China is governed by the in-PRC terms; cross-border or other-region processing depends on the request and arrangements. Where applicable law requires it, the service operator uses an explicit-consent flow for this optional feature.\n\nUnresolved: The exact company operating the service in mainland China; A guaranteed processing region for each API request; API-content cache TTL, cache scope, opt-out mechanism, and fixed content-retention period. Database configuration and product copy must not turn these unknowns into guarantees.\n\nSources reviewed:\n\nOfficial source 1: https://mimo.mi.com/docs/en-US/api/chat/responses https://mimo.mi.com/docs/en-US/api/chat/responses\n\nOfficial source 2: https://mimo.mi.com/docs/en-US/price/pay-as-you-go https://mimo.mi.com/docs/en-US/price/pay-as-you-go\n\nOfficial source 3: https://mimo.mi.com/docs/en-US/api/guidance/rate-limit https://mimo.mi.com/docs/en-US/api/guidance/rate-limit\n\nOfficial source 4: https://mimo.mi.com/docs/en-US/api/guidance/error-codes https://mimo.mi.com/docs/en-US/api/guidance/error-codes\n\nOfficial source 5: https://mimo.mi.com/docs/quick-start/terms/user-agreement https://mimo.mi.com/docs/quick-start/terms/user-agreement\n\nOfficial source 6: https://mimo.mi.com/docs/en-US/terms/privacy-policy https://mimo.mi.com/docs/en-US/terms/privacy-policy" }] } } }] $disclosures$::jsonb)
    loop
      select
        *
      into
        strict v_provider
      from
        ai.providers
      where
        code = v_item ->> 'provider_code';
      v_content = v_item -> 'content';
      if v_provider.code = 'MIMO' and v_content is distinct from (
        select
          d.content
        from
          legal.disclosures d
          join legal.bundles b on b.id = d.bundle_id
        where
          b.code = 'CURRENT_20261107' and d.provider_id = v_provider.id and d.disclosure_code = 'MIMO_CURRENT') then
        perform
          common.fail ('CONFLICT', 'REVIEWED_MIMO_DISCLOSURE_MISMATCH');
      end if;
      perform
        common.insert_entity ('legal.disclosures', jsonb_build_object('bundle_id', (v_bundle ->> 'id')::bigint, 'provider_id', v_provider.id, 'disclosure_code', v_item ->> 'disclosure_code', 'renderer_contract', 'legal_display_1', 'model_id', v_item ->> 'model_id', 'recipient_code', v_provider.recipient_code, 'content', v_content, 'content_digest', common.digest(jsonb_build_object('content', v_content, 'ai_document_digest', v_ai_digest, 'manifest_digest', v_bundle ->> 'manifest_digest'))));
    end loop;
  update
    legal.bundles
  set
    time_sealed = clock_timestamp()
  where
    id = (v_bundle ->> 'id')::bigint;
  select
    b.external_id
  into
    v_previous_bundle
  from
    legal.current_state c
    join legal.bundles b on b.id = c.ai_bundle_id
  where
    c.id = 1;
  -- Initialized environments adopt the new sealed evidence. Uninitialized ones
  -- have no pointers/Auth target; initialize() will select the newest sealed bundle.
  update
    legal.current_state
  set
    ai_bundle_id = (v_bundle ->> 'id')::bigint
  where
    id = 1;
  update
    ai.runtime_control
  set
    enabled = false,
    active_policy_version_id = null,
    generation = generation + 1,
    close_cycle = close_cycle + 1,
    user_updated = null
  where
    id = 1;
  select
    database_instance_id
  into
    v_instance
  from
    admin.environment
  where
    id = 1;
  perform
    common.insert_entity ('audit.events', jsonb_build_object('actor_kind', 'MIGRATION', 'actor_auth_user_id', null, 'entity_kind', 'AI_EXECUTION_CONTRACT', 'entity_external_id', v_bundle ->> 'external_id', 'action', 'DEEPSEEK_RESPONSES_CUTOVER', 'reason', 'Replace unreferenced DeepSeek Chat capability with official Responses and require new configuration/consent', 'summary', jsonb_build_object('database_instance_id', v_instance, 'previous_ai_bundle_id', v_previous_bundle, 'ai_bundle_id', v_bundle ->> 'external_id', 'capability_code', 'DEEPSEEK_RESPONSES', 'runtime_enabled', false, 'active_policy_version_id', null)));
end;
$legal$;
commit;
