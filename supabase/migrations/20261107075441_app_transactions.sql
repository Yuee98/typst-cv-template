-- Explicit file transaction also protects CLI versions that execute statements separately.
begin;
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
-- Supabase's migration role can read Auth through pg_read_all_data but cannot regrant platform tables.
-- These narrow private read-only bridges are the sole postgres-owned SECURITY DEFINER exception.
create function common.auth_user_active (p_user uuid)
  returns boolean
  language sql
  stable
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
  stable
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
create function common.auth_has_totp (p_user uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
  as $$
  select
    exists (
      select
        1
      from
        auth.mfa_factors
      where
        user_id = p_user
        and status = 'verified'
        and factor_type = 'totp')
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
-- One current API. Every privileged public entry point is owned by app_api_owner.
create function common.guard (p_input jsonb)
  returns void
  language plpgsql
  stable
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
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
    if not found or not exists (
      select
        1
      from
        legal.current_state
      where
        id = 1) then
      perform
        common.fail ('NOT_READY', 'ENVIRONMENT_NOT_INITIALIZED');
    end if;
    if p_input ->> 'contract_code' is distinct from e.contract_code or p_input ->> 'database_instance_id' is distinct from e.database_instance_id::text then
      perform
        common.fail ('CLIENT_UPDATE_REQUIRED', 'DATABASE_INSTANCE_OR_CONTRACT_CHANGED');
    end if;
end
$$;
create function common.user_id ()
  returns uuid
  language plpgsql
  stable
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
  stable
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
create function common.admin_id (p_step_up boolean default false)
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
  if p_step_up and (j ->> 'aal' is distinct from 'aal2' or not common.auth_has_totp (u) or not exists (
    select
      1
    from
      jsonb_array_elements(coalesce(j -> 'amr', '[]')) a
    where
      a ->> 'method' = 'totp' and (a ->> 'timestamp')::numeric >= extract(epoch from clock_timestamp()) - 600)) then
    perform
      common.fail ('STEP_UP_REQUIRED');
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
      legal.current_state c
      join legal.document_versions d on d.id = c.terms_document_version_id
      join legal.acceptances a on a.document_version_id = d.id
        and a.owner_auth_user_id = p_user
        and a.accepted_content_digest = d.content_digest
    where
      c.id = 1) then
  perform
    common.fail ('FORBIDDEN', 'TERMS_REQUIRED');
end if;
end
$$;
-- Generated from the sole current strict cvSchema (v7); SQL tests check old/malformed inputs.
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
create function common.client_user (p_input jsonb)
  returns uuid
  language plpgsql
  stable
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
create function ai.graph_child_guard ()
  returns trigger
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
declare
  v_tx xid8;
  v_status text;
begin
  if tg_op <> 'INSERT' then
    perform
      common.fail ('INVALID_REQUEST', 'IMMUTABLE_CONFIGURATION_GRAPH');
  end if;
  if tg_table_name = 'price_components' then
    select
      creation_txid,
      status
    into
      v_tx,
      v_status
    from
      ai.price_versions
    where
      id = new.price_version_id;
  else
    select
      creation_txid,
      status
    into
      v_tx,
      v_status
    from
      ai.policy_versions
    where
      id = new.policy_version_id;
  end if;
  if v_tx is distinct from pg_current_xact_id () or v_status is distinct from 'DRAFT' then
    perform
      common.fail ('INVALID_REQUEST', 'CONFIGURATION_GRAPH_CREATION_ONLY');
  end if;
  return new;
end
$$;
create trigger frozen_price_components
  before insert or update or delete on ai.price_components for each row
  execute function ai.graph_child_guard ();
create trigger frozen_policy_options
  before insert or update or delete on ai.policy_options for each row
  execute function ai.graph_child_guard ();
create trigger frozen_routing_rules
  before insert or update or delete on ai.routing_rules for each row
  execute function ai.graph_child_guard ();
create trigger frozen_rule_options
  before insert or update or delete on ai.routing_rule_options for each row
  execute function ai.graph_child_guard ();
create function ai.attempt_fact_guard ()
  returns trigger
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
begin
  if old.state <> 'STARTED' and to_jsonb (new) is distinct from to_jsonb (old) then
    perform
      common.fail ('CONFLICT', 'IMMUTABLE_TERMINAL_FACT');
  end if;
  return new;
end
$$;
create trigger frozen_attempt_terminal
  before update on ai.attempts for each row
  execute function ai.attempt_fact_guard ();
create function common.cv_payload (p_input jsonb)
  returns void
  language plpgsql
  immutable
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
create function cv.dto (p_row cv.documents)
  returns jsonb
  language sql
  stable
  security invoker
  set search_path = ''
  as $$
  select
    jsonb_build_object('external_id', p_row.external_id, 'title', p_row.title, 'storage_mode', p_row.storage_mode, 'document_schema_version', p_row.document_schema_version, 'revision', p_row.revision::text, 'time_created', p_row.time_created, 'time_updated', p_row.time_updated, 'data', p_row.data, 'encrypted_payload', p_row.encrypted_payload)
$$;
create view public.cv_document_summaries with ( security_invoker = true
) as
select
  external_id,
  title,
  storage_mode,
  document_schema_version,
  revision::text as revision,
  time_created,
  time_updated
from
  cv.documents;
create view public.cv_document_contents with ( security_invoker = true
) as
select
  external_id,
  title,
  storage_mode,
  document_schema_version,
  revision::text as revision,
  time_created,
  time_updated,
  data,
  encrypted_payload
from
  cv.documents;
grant select (external_id, title, storage_mode, document_schema_version, revision, time_created, time_updated, data, encrypted_payload, owner_auth_user_id) on cv.documents to authenticated;
grant select on public.cv_document_summaries, public.cv_document_contents to authenticated;
create function public.app_context ()
  returns jsonb
  language sql
  stable
  security definer
  set search_path = ''
  as $$
  select
    jsonb_build_object('ready', e.id is not null
      and c.id is not null, 'contract_code', 'cv_app_db_1', 'database_instance_id', e.database_instance_id, 'environment', e.name, 'capabilities', coalesce((
        select
          jsonb_agg(code order by id)
        from ai.capabilities
        where
          time_deprecated is null), '[]'))
  from (
    values (1)) t (id)
  left join admin.environment e on e.id = t.id
  left join legal.current_state c on c.id = t.id
$$;
create function public.keep_project_active ()
  returns boolean
  language sql
  immutable
  security invoker
  set search_path = ''
  as $$
  select
    true
$$;
create function public.cv_document_create (p_input jsonb)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  u uuid;
  v cv.documents;
  d text;
  i int;
  c text;
begin
  perform
    common.guard (p_input);
    u = common.client_user (p_input);
    perform
      common.require_terms (u);
      perform
        common.required (p_input, array['client_create_key', 'title']);
        perform
          common.cv_payload (p_input);
          d = common.digest(p_input - array['contract_code', 'database_instance_id']);
          select
            *
          into
            v
          from
            cv.documents
          where
            owner_auth_user_id = u
            and client_create_key = (p_input ->> 'client_create_key')::uuid;
            if found then
              if v.create_payload_digest <> d then
                perform
                  common.fail ('CONFLICT', 'IDEMPOTENCY_PAYLOAD_CHANGED');
              end if;
              return cv.dto (v);
            end if;
            for i in 1..5 loop
              begin
                insert into cv.documents (owner_auth_user_id, client_create_key, create_payload_digest, title, storage_mode, data, encrypted_payload, document_schema_version, user_created, user_updated)
                  values (u, (p_input ->> 'client_create_key')::uuid, d, p_input ->> 'title', p_input ->> 'storage_mode', nullif (p_input -> 'data', 'null'), nullif (p_input -> 'encrypted_payload', 'null'), 7, u, u)
                returning
                  *
                into
                  v;
                  return cv.dto (v);
              exception
                when unique_violation then
                  get stacked diagnostics c = constraint_name;
                  if c = 'cv_documents_owner_auth_user_id_client_create_key_key' then
                    select
                      *
                    into
                      v
                    from
                      cv.documents
                    where
                      owner_auth_user_id = u
                      and client_create_key = (p_input ->> 'client_create_key')::uuid;
                      if v.create_payload_digest = d then
                        return cv.dto (v);
                        end if;
                        perform
                          common.fail ('CONFLICT', 'IDEMPOTENCY_PAYLOAD_CHANGED');
                        elsif c <> 'uq_cv_documents_external_id' then
                          raise;
                    end if;
              end;
  end loop;
  raise exception 'External ID collision retry limit reached' using errcode = '23505';
end
$$;
create function cv.write (p_input jsonb, p_action text)
  returns jsonb
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  v cv.documents;
  u uuid;
begin
  perform
    common.guard (p_input);
    u = common.client_user (p_input);
    if p_action <> 'delete' then
      perform
        common.require_terms (u);
    end if;
    perform
      common.required (p_input, array['external_id', 'expected_revision']);
      select
        *
      into
        v
      from
        cv.documents
      where
        external_id = p_input ->> 'external_id'
        and owner_auth_user_id = u
      for update;
      if not found then
        perform
          common.fail ('NOT_FOUND');
      end if;
      if v.revision::text <> p_input ->> 'expected_revision' then
        perform
          common.fail ('CONFLICT', 'REVISION_CHANGED');
      end if;
      if p_action = 'delete' then
        delete from cv.documents
        where id = v.id;
          return jsonb_build_object('deleted', true);
        elsif p_action = 'rename' then
          perform
            common.required (p_input, array['title']);
            update
              cv.documents
            set
              title = p_input ->> 'title',
              user_updated = u
            where
              id = v.id
            returning
              *
            into
              v;
            else
              perform
                common.cv_payload (p_input);
                if p_action = 'update' and p_input ->> 'storage_mode' <> v.storage_mode then
                  perform
                    common.fail ('INVALID_REQUEST', 'USE_CONVERT');
                end if;
                update
                  cv.documents
                set
                  storage_mode = p_input ->> 'storage_mode',
                  data = nullif (p_input -> 'data', 'null'),
                  encrypted_payload = nullif (p_input -> 'encrypted_payload', 'null'),
                  document_schema_version = 7,
                  user_updated = u
                where
                  id = v.id
                returning
                  *
                into
                  v;
      end if;
      return cv.dto (v);
end
$$;
create function public.cv_document_update (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    cv.write (p_input, 'update')
$$;
create function public.cv_document_convert (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    cv.write (p_input, 'convert')
$$;
create function public.cv_document_rename (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    cv.write (p_input, 'rename')
$$;
create function public.cv_document_delete (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    cv.write (p_input, 'delete')
$$;
create function public.legal_current ()
  returns jsonb
  language sql
  stable
  security definer
  set search_path = ''
  as $$
  select
    jsonb_build_object('terms', jsonb_build_object('external_id', t.external_id, 'content_digest', t.content_digest, 'renderer_contract', t.renderer_contract, 'content', t.content), 'ai_bundle', case when b.id is null then
        null
      else
        jsonb_build_object('external_id', b.external_id, 'manifest_digest', b.manifest_digest, 'ai_terms', jsonb_build_object('external_id', a.external_id, 'content_digest', a.content_digest, 'renderer_contract', a.renderer_contract, 'content', a.content), 'disclosures', coalesce((
            select
              jsonb_agg(jsonb_build_object('external_id', d.external_id, 'provider_id', p.external_id, 'provider_code', p.code, 'model_id', d.model_id, 'recipient_code', d.recipient_code, 'content_digest', d.content_digest, 'renderer_contract', d.renderer_contract, 'content', d.content))
            from legal.disclosures d
            join ai.providers p on p.id = d.provider_id
            where
              d.bundle_id = b.id), '[]'))
      end)
  from
    legal.current_state s
    join legal.document_versions t on t.id = s.terms_document_version_id
    left join legal.bundles b on b.id = s.ai_bundle_id
      and b.time_sealed is not null
  left join legal.document_versions a on a.id = b.ai_document_version_id
where
  s.id = 1
$$;
create view public.legal_my_acceptances with ( security_invoker = true
) as
select
  d.external_id as document_version_id,
  x.external_id as disclosure_id,
  a.accepted_content_digest,
  a.time_accepted
from
  legal.acceptances a
  left join legal.document_versions d on d.id = a.document_version_id
  left join legal.disclosures x on x.id = a.disclosure_id;
grant select (id, external_id) on legal.document_versions, legal.disclosures to authenticated;
create policy document_public_read on legal.document_versions
  for select to authenticated
  using (true);
create policy disclosure_public_read on legal.disclosures
  for select to authenticated
  using (true);
grant select (owner_auth_user_id, document_version_id, disclosure_id, accepted_content_digest, time_accepted) on legal.acceptances to authenticated;
grant select on public.legal_my_acceptances to authenticated;
create function legal.accept (p_input jsonb, p_disclosure boolean)
  returns jsonb
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  u uuid;
  v_id bigint;
  d text;
begin
  perform
    common.guard (p_input);
    u = common.client_user (p_input);
    if p_disclosure then
      select
        x.id,
        x.content_digest
      into
        v_id,
        d
      from
        legal.disclosures x
        join legal.bundles b on b.id = x.bundle_id
        join legal.current_state c on c.ai_bundle_id = b.id
      where
        x.external_id = p_input ->> 'disclosure_id'
        and b.external_id = p_input ->> 'bundle_id'
        and b.manifest_digest = p_input ->> 'manifest_digest'
        and b.time_sealed is not null;
      else
        select
          t.id,
          t.content_digest
        into
          v_id,
          d
        from
          legal.document_versions t
          join legal.current_state c on c.terms_document_version_id = t.id
        where
          t.external_id = p_input ->> 'document_version_id';
    end if;
    if v_id is null or d is distinct from p_input ->> 'content_digest' then
      perform
        common.fail ('CONFLICT', 'LEGAL_TARGET_CHANGED');
    end if;
  insert into legal.acceptances (owner_auth_user_id, document_version_id, disclosure_id, accepted_content_digest)
    values (u, case when not p_disclosure then
        v_id
      end, case when p_disclosure then
        v_id
      end, d)
  on conflict
    do nothing;
    return jsonb_build_object('accepted', true, 'target_id', coalesce(p_input ->> 'disclosure_id', p_input ->> 'document_version_id'), 'content_digest', d);
end
$$;
create function public.legal_accept_document (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    legal.accept (p_input, false)
$$;
create function public.legal_accept_disclosure (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    legal.accept (p_input, true)
$$;
create function admin.initialize (p_name text, p_admin_user uuid)
  returns jsonb
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  e admin.environment;
  t bigint;
  b bigint;
begin
  if not exists (
    select
      1
    from
      auth.users
    where
      id = p_admin_user
      and deleted_at is null) then
  perform
    common.fail ('INVALID_REQUEST', 'ADMIN_USER_MISSING');
end if;
select
  *
into
  e
from
  admin.environment
where
  id = 1
for update;
if found then
  if e.name <> p_name or not exists (
    select
      1
    from
      admin.members
    where
      auth_user_id = p_admin_user and time_revoked is null) then
    perform
      common.fail ('CONFLICT', 'INITIALIZATION_CHANGED');
  end if;
  return public.app_context ();
end if;
select
  id
into
  t
from
  legal.document_versions
where
  document_code = 'TERMS'
order by
  version desc
limit 1;
select
  id
into
  b
from
  legal.bundles
where
  time_sealed is not null
order by
  id desc
limit 1;
if t is null or b is null then
  perform
    common.fail ('NOT_READY', 'LEGAL_CATALOG_MISSING');
end if;
insert into admin.environment (id, name, database_instance_id, contract_code)
  values (1, p_name, gen_random_uuid (), 'cv_app_db_1');
  perform
    common.insert_entity ('admin.members', jsonb_build_object('auth_user_id', p_admin_user, 'user_created', p_admin_user, 'user_updated', p_admin_user));
  insert into legal.current_state (id, terms_document_version_id, ai_bundle_id)
    values (1, t, b);
    update
      ai.runtime_control
    set
      enabled = false,
      active_policy_version_id = null,
      audience = 'ALLOWLIST'
    where
      id = 1;
      return public.app_context ();
end
$$;
create function ai.profile_snapshot (p_id bigint)
  returns jsonb
  language sql
  stable
  security invoker
  set search_path = ''
  as $$
  select
    jsonb_build_object('profile_id', p.external_id, 'profile_version_id', v.external_id, 'provider_id', r.external_id, 'provider_code', r.code, 'recipient_code', r.recipient_code, 'capability', jsonb_build_object('code', c.code, 'adapter_kind', c.adapter_kind, 'wire_api_kind', c.wire_api_kind, 'execution_contract', c.execution_contract, 'calculator_kind', c.calculator_kind, 'cache_policy', c.cache_policy, 'descriptor_digest', c.descriptor_digest), 'endpoint_url', v.endpoint_url, 'credential_ref', v.credential_ref, 'model_id', v.model_id, 'adapter_config', v.adapter_config, 'config_digest', v.config_digest)
  from
    ai.profile_versions v
    join ai.profiles p on p.id = v.profile_id
    join ai.providers r on r.id = p.provider_id
    join ai.capabilities c on c.id = v.capability_id
  where
    v.id = p_id
$$;
create function ai.quota_value (p_user uuid, p_day date default (clock_timestamp() at time zone 'UTC')::date)
  returns jsonb
  language sql
  stable
  security invoker
  set search_path = ''
  as $$
  select
    jsonb_build_object('day', p_day, 'limit', c.user_daily_limit::text, 'reserved', coalesce(u.reserved_count, 0)::text, 'charged', coalesce(u.charged_count, 0)::text, 'remaining', greatest (0, c.user_daily_limit - coalesce(u.reserved_count, 0) - coalesce(u.charged_count, 0))::text, 'minute_limit', c.user_minute_limit::text, 'reset_at', (p_day + 1)::timestamp at time zone 'UTC')
  from
    ai.runtime_control c
  left join ai.user_usage_daily u on u.auth_user_id = p_user
    and u.day = p_day
where
  c.id = 1
$$;
create function public.ai_quota (p_input jsonb)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = ''
  as $$
  #variable_conflict use_variable
begin
  return ai.quota_value (common.service_user (p_input));
end
$$;
create function ai.rule_at (p_policy bigint, p_time timestamptz)
  returns integer
  language sql
  stable
  security invoker
  set search_path = ''
  as $$
  select
    ordinal
  from
    ai.routing_rules
  where
    policy_version_id = p_policy
    and (is_fallback
      or (weekday = extract(isodow from p_time at time zone 'Asia/Shanghai')
        and start_minute <= extract(hour from p_time at time zone 'Asia/Shanghai') * 60 + extract(minute from p_time at time zone 'Asia/Shanghai')
        and end_minute > extract(hour from p_time at time zone 'Asia/Shanghai') * 60 + extract(minute from p_time at time zone 'Asia/Shanghai')))
  order by
    is_fallback,
    ordinal
  limit 1
$$;
create function ai.price_at (p_profile bigint, p_lane text, p_time timestamptz)
  returns bigint
  language sql
  stable
  security invoker
  set search_path = ''
  as $$
  select
    id
  from
    ai.price_versions
  where
    profile_version_id = p_profile
    and lane_code = p_lane
    and status = 'PUBLISHED'
    and time_valid_from <= p_time
    and (least (time_valid_until, time_closed) is null
      or least (time_valid_until, time_closed) > p_time)
$$;
create function public.ai_availability (p_input jsonb)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  u uuid;
  c ai.runtime_control;
  v ai.policy_versions;
  r ai.routing_rules;
  t timestamptz := clock_timestamp();
  items jsonb;
  reason text;
  bound timestamptz;
begin
  u = common.service_user (p_input);
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
      v
    from
      ai.policy_versions
    where
      id = c.active_policy_version_id;
      select
        *
      into
        r
      from
        ai.routing_rules
      where
        policy_version_id = v.id
        and ordinal = ai.rule_at (v.id, t);
        if not c.enabled then
          reason = 'DISABLED';
        elsif c.audience = 'ALLOWLIST'
            and not exists (
              select
                1
              from
                ai.allowed_users
              where
                auth_user_id = u) then
            reason = 'NOT_ALLOWED';
          elsif (ai.quota_value (u) ->> 'remaining')::bigint = 0 then
            reason = 'QUOTA_EXCEEDED';
          elsif coalesce((
              select
                admitted_count
              from ai.global_usage_daily
              where
                day = (t at time zone 'UTC')::date), 0) >= c.global_daily_limit then
            reason = 'GLOBAL_QUOTA_EXCEEDED';
        end if;
        select
          coalesce(jsonb_agg(jsonb_build_object('option_id', o.external_id, 'profile_version_id', pv.external_id, 'provider_id', p.external_id, 'provider_code', p.code, 'provider_name', p.name, 'recipient_code', p.recipient_code, 'model_id', pv.model_id, 'disclosure_id', d.external_id, 'content_digest', d.content_digest, 'bundle_id', b.external_id, 'manifest_digest', b.manifest_digest, 'content', d.content, 'runtime_profile', ai.profile_snapshot (pv.id), 'status', case when pv.status <> 'PUBLISHED'
                  or pr.time_retired is not null
                  or p.time_archived is not null
                  or cap.time_deprecated is not null
                  or ai.price_at (pv.id, o.price_lane_code, t) is null then
                  'UNAVAILABLE'
                when not exists (
                  select
                    1
                  from legal.acceptances a
                  where
                    a.owner_auth_user_id = u
                    and a.disclosure_id = d.id
                    and a.accepted_content_digest = d.content_digest) then
                  'CONSENT_REQUIRED'
                else
                  'READY'
                end, 'reason', case when ai.price_at (pv.id, o.price_lane_code, t) is null then
                  'PRICE_UNAVAILABLE'
                end)
            order by o.display_order, o.id), '[]')
        into
          items
        from
          ai.routing_rule_options m
          join ai.policy_options o on o.id = m.option_id
          join ai.profile_versions pv on pv.id = o.profile_version_id
          join ai.profiles pr on pr.id = pv.profile_id
          join ai.providers p on p.id = pr.provider_id
          join ai.capabilities cap on cap.id = pv.capability_id
          join legal.disclosures d on d.id = pv.legal_disclosure_id
          join legal.bundles b on b.id = d.bundle_id
        where
          m.policy_version_id = v.id
          and m.rule_ordinal = r.ordinal;
          select
            min(x)
          into
            bound
          from (
            select
              (((t at time zone 'Asia/Shanghai')::date + g.day_offset)::timestamp + make_interval(mins => z.minute)) at time zone 'Asia/Shanghai' as x
            from
              generate_series(0, 7) g (day_offset)
              join ai.routing_rules rr on rr.policy_version_id = v.id
                and not rr.is_fallback
                and extract(isodow from ((t at time zone 'Asia/Shanghai')::date + g.day_offset)) = rr.weekday
            cross join lateral (
              values (rr.start_minute),
                (rr.end_minute)) z (minute)
          union all
          select
            time_valid_from
          from
            ai.price_versions p
            join ai.policy_options o on o.profile_version_id = p.profile_version_id
                and o.price_lane_code = p.lane_code
            where
              o.policy_version_id = v.id
                and p.status = 'PUBLISHED'
              union all
              select
                least (time_valid_until, time_closed)
              from
                ai.price_versions p
                join ai.policy_options o on o.profile_version_id = p.profile_version_id
                  and o.price_lane_code = p.lane_code
              where
                o.policy_version_id = v.id
                and p.status = 'PUBLISHED') q
          where
            x > t;
              return jsonb_build_object('generation', c.generation::text, 'policy_version_id', v.external_id, 'rule_ordinal', r.ordinal, 'options', items, 'default_option_id', (
                  select
                    external_id
                  from ai.policy_options
                  where
                    id = r.default_option_id), 'observed_at', t, 'next_change_at', bound, 'enabled', c.enabled, 'reason', reason, 'database_instance_id', p_input ->> 'database_instance_id', 'contract_code', 'cv_app_db_1');
end
$$;
create function public.ai_reserve (p_input jsonb)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  u uuid;
  c ai.runtime_control;
  v ai.policy_versions;
  o ai.policy_options;
  pv ai.profile_versions;
  pc ai.price_versions;
  r ai.requests;
  t timestamptz;
  day date;
  minute timestamptz;
  ord integer;
  counted bigint;
begin
  u = common.service_user (p_input);
  perform
    common.required (p_input, array['client_request_key', 'request_fingerprint', 'selected_option_id', 'expected_generation', 'expected_policy_version_id', 'expected_profile_version_id', 'disclosure_id', 'content_digest']);
    select
      *
    into
      c
    from
      ai.runtime_control
    where
      id = 1
    for update;
    select
      *
    into
      r
    from
      ai.requests
    where
      owner_auth_user_id = u
      and client_request_key = (p_input ->> 'client_request_key')::uuid
    for update;
    if found then
      if r.request_fingerprint <> p_input ->> 'request_fingerprint' then
        perform
          common.fail ('CONFLICT', 'IDEMPOTENCY_PAYLOAD_CHANGED');
      end if;
      return jsonb_build_object('request_id', r.external_id, 'state', r.state, 'replayed', true, 'quota', ai.quota_value (u, r.quota_day));
    end if;
    if not c.enabled then
      perform
        common.fail ('UNAVAILABLE', 'DISABLED');
    end if;
    if c.audience = 'ALLOWLIST' and not exists (
      select
        1
      from
        ai.allowed_users
      where
        auth_user_id = u) then
      perform
        common.fail ('FORBIDDEN', 'NOT_ALLOWED');
    end if;
    select
      *
    into
      v
    from
      ai.policy_versions
    where
      id = c.active_policy_version_id
      and status = 'PUBLISHED' for share;
      if v.id is null or v.external_id is distinct from p_input ->> 'expected_policy_version_id' or c.generation::text is distinct from p_input ->> 'expected_generation' then
        perform
          common.fail ('CONFLICT', 'CONFIG_CHANGED');
      end if;
      select
        *
      into
        o
      from
        ai.policy_options
      where
        external_id = p_input ->> 'selected_option_id'
        and policy_version_id = v.id;
        select
          *
        into
          pv
        from
          ai.profile_versions
        where
          id = o.profile_version_id
          and status = 'PUBLISHED'
          and external_id = p_input ->> 'expected_profile_version_id' for share;
          t = clock_timestamp();
          day = (t at time zone 'UTC')::date;
          minute = date_trunc('minute', t);
          ord = ai.rule_at (v.id, t);
          if o.id is null or pv.id is null or not exists (
            select
              1
            from
              ai.routing_rule_options
            where
              policy_version_id = v.id and rule_ordinal = ord and option_id = o.id) then
            perform
              common.fail ('CONFLICT', 'OPTION_UNAVAILABLE');
          end if;
          if exists (
            select
              1
            from
              ai.profiles pr
              join ai.providers p on p.id = pr.provider_id
              join ai.capabilities a on a.id = pv.capability_id
            where
              pr.id = pv.profile_id
              and (pr.time_retired is not null
                or p.time_archived is not null
                or a.time_deprecated is not null)) then
          perform
            common.fail ('UNAVAILABLE', 'PROFILE_UNAVAILABLE');
end if;
if not exists (
  select
    1
  from
    legal.current_state s
    join legal.bundles b on b.id = s.ai_bundle_id
    join legal.disclosures d on d.bundle_id = b.id
    join legal.acceptances a on a.disclosure_id = d.id
      and a.owner_auth_user_id = u
      and a.accepted_content_digest = d.content_digest
  where
    b.id = v.legal_bundle_id
    and b.time_sealed is not null
    and d.id = pv.legal_disclosure_id
    and d.external_id = p_input ->> 'disclosure_id'
    and d.content_digest = p_input ->> 'content_digest') then
perform
  common.fail ('FORBIDDEN', 'CONSENT_REQUIRED');
end if;
select
  *
into
  pc
from
  ai.price_versions
where
  id = ai.price_at (pv.id, o.price_lane_code, t)
  for share;
  if not found then
    perform
      common.fail ('UNAVAILABLE', 'PRICE_UNAVAILABLE');
  end if;
insert into ai.user_usage_daily (auth_user_id, day)
  values (u, day)
on conflict
  do nothing;
  select
    reserved_count + charged_count
  into
    counted
  from
    ai.user_usage_daily
  where
    auth_user_id = u
    and ai.user_usage_daily.day = day
  for update;
  if counted >= c.user_daily_limit then
    perform
      common.fail ('QUOTA_EXCEEDED');
  end if;
  if coalesce((
    select
      admitted_count
    from ai.global_usage_daily
    where
      ai.global_usage_daily.day = day), 0) >= c.global_daily_limit then
    perform
      common.fail ('QUOTA_EXCEEDED', 'GLOBAL_QUOTA_EXCEEDED');
  end if;
insert into ai.rate_minutes (auth_user_id, minute_bucket)
  values (u, minute)
on conflict
  do nothing;
  select
    request_count
  into
    counted
  from
    ai.rate_minutes
  where
    auth_user_id = u
    and minute_bucket = minute
  for update;
  if counted >= c.user_minute_limit then
    perform
      common.fail ('RATE_LIMITED');
  end if;
  select
    *
  into
    r
  from
    jsonb_populate_record(null::ai.requests, common.insert_entity ('ai.requests', jsonb_build_object('owner_auth_user_id', u, 'client_request_key', p_input ->> 'client_request_key', 'request_fingerprint', p_input ->> 'request_fingerprint', 'policy_version_id', v.id, 'rule_ordinal', ord, 'selected_option_id', o.id, 'profile_version_id', pv.id, 'price_version_id', pc.id, 'legal_bundle_id', v.legal_bundle_id, 'legal_disclosure_id', pv.legal_disclosure_id, 'config_generation', c.generation, 'quota_day', day, 'time_reserved', t, 'time_progress', t, 'billing_currency', pc.currency)));
    update
      ai.user_usage_daily
    set
      reserved_count = reserved_count + 1
    where
      auth_user_id = u
      and ai.user_usage_daily.day = day;
      update
        ai.rate_minutes
      set
        request_count = request_count + 1
      where
        auth_user_id = u
        and minute_bucket = minute;
        return jsonb_build_object('request_id', r.external_id, 'state', r.state, 'replayed', false, 'quota', ai.quota_value (u, day));
end
$$;
create function public.ai_execution_snapshot (p_input jsonb)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  u uuid;
  r ai.requests;
  p ai.price_versions;
begin
  u = common.service_user (p_input);
  select
    *
  into
    r
  from
    ai.requests
  where
    external_id = p_input ->> 'request_id'
    and owner_auth_user_id = u;
    if not found then
      perform
        common.fail ('NOT_FOUND');
    end if;
    select
      *
    into
      p
    from
      ai.price_versions
    where
      id = r.price_version_id;
      return ai.profile_snapshot (r.profile_version_id) || jsonb_build_object('request_id', r.external_id, 'state', r.state, 'selected_option_id', (
          select
            external_id
          from ai.policy_options
          where
            id = r.selected_option_id), 'policy_version_id', (
          select
            external_id
          from ai.policy_versions
          where
            id = r.policy_version_id), 'price_version_id', p.external_id, 'price', jsonb_build_object('currency', p.currency, 'calculator_kind', p.calculator_kind, 'parameters', p.parameters, 'components', (
            select
              jsonb_object_agg(component, nanos_per_million::text)
            from ai.price_components
          where
            price_version_id = p.id)), 'disclosure_id', (
          select
            external_id
          from legal.disclosures
        where
          id = r.legal_disclosure_id), 'content_digest', (
        select
          content_digest
        from legal.disclosures
      where
        id = r.legal_disclosure_id), 'cancel_sequence', r.cancel_sequence::text, 'attempts', coalesce((
      select
        jsonb_agg(jsonb_build_object('attempt_id', external_id, 'attempt_no', attempt_no, 'state', state, 'retry_allowed', retry_allowed, 'transmitted', transmitted)
      order by attempt_no)
      from ai.attempts
    where
      request_id = r.id), '[]'));
end
$$;
create function public.ai_attempt_start (p_input jsonb)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  u uuid;
  c ai.runtime_control;
  r ai.requests;
  a ai.attempts;
  prior ai.attempts;
  n int;
  t timestamptz;
  day date;
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
  select
    *
  into
    r
  from
    ai.requests
  where
    external_id = p_input ->> 'request_id'
    and owner_auth_user_id = u
  for update;
  if not found then
    perform
      common.fail ('NOT_FOUND');
  end if;
  n = (p_input ->> 'attempt_no')::int;
  if n not in (1, 2) or n is null then
    perform
      common.fail ('INVALID_REQUEST', 'ATTEMPT_NUMBER');
  end if;
  select
    *
  into
    a
  from
    ai.attempts
  where
    request_id = r.id
    and attempt_no = n;
    if found then
      return jsonb_build_object('attempt_id', a.external_id, 'attempt_no', n, 'state', a.state, 'may_transmit', false);
    end if;
    if not c.enabled then
      perform
        common.fail ('UNAVAILABLE', 'DISABLED');
    end if;
    if r.state = 'FINALIZED' or r.cancel_sequence > 0 then
      perform
        common.fail ('CONFLICT', 'REQUEST_NOT_TRANSMITTABLE');
    end if;
    if n = 2 then
      select
        *
      into
        prior
      from
        ai.attempts
      where
        request_id = r.id
        and attempt_no = 1
      for update;
      if not found or prior.state in ('STARTED', 'UNKNOWN') or prior.retry_allowed is distinct from true then
        perform
          common.fail ('CONFLICT', 'RETRY_NOT_ALLOWED');
      end if;
    elsif exists (
        select
          1
        from
          ai.attempts
        where
          request_id = r.id) then
      perform
        common.fail ('CONFLICT', 'ATTEMPT_EXISTS');
    end if;
    t = clock_timestamp();
    day = (t at time zone 'UTC')::date;
    if r.provider_admission_day is null then
      insert into ai.global_usage_daily (day)
        values (day)
      on conflict
        do nothing;
        if (
          select
            admitted_count
          from
            ai.global_usage_daily
          where
            ai.global_usage_daily.day = day
          for update) >= c.global_daily_limit then
          perform
            common.fail ('QUOTA_EXCEEDED', 'GLOBAL_QUOTA_EXCEEDED');
        end if;
        update
          ai.global_usage_daily
        set
          admitted_count = admitted_count + 1
        where
          ai.global_usage_daily.day = day;
          update
            ai.requests
          set
            provider_admission_day = day
          where
            id = r.id;
    end if;
    select
      *
    into
      a
    from
      jsonb_populate_record(null::ai.attempts, common.insert_entity ('ai.attempts', jsonb_build_object('request_id', r.id, 'attempt_no', n, 'time_started', t)));
      update
        ai.requests
      set
        state = 'RUNNING',
        time_progress = t
      where
        id = r.id;
        return jsonb_build_object('attempt_id', a.external_id, 'attempt_no', n, 'state', a.state, 'may_transmit', true);
end
$$;
create function ai.usage_validate (p_usage jsonb)
  returns void
  language plpgsql
  immutable
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  k text;
  v numeric;
begin
  if jsonb_typeof(p_usage) <> 'object' then
    perform
      common.fail ('INVALID_REQUEST', 'USAGE_OBJECT');
  end if;
  for k in
  select
    jsonb_object_keys(p_usage)
    loop
      if k not in ('input_total', 'cache_read', 'cache_write', 'input_standard', 'output', 'reasoning') then
        perform
          common.fail ('INVALID_REQUEST', 'UNKNOWN_USAGE_FIELD');
      end if;
      if p_usage -> k <> 'null'::jsonb then
        if p_usage ->> k !~ '^[0-9]+$' then
          perform
            common.fail ('INVALID_REQUEST', 'INVALID_USAGE');
        end if;
        v = (p_usage ->> k)::numeric;
        if v > 9223372036854775807 then
          perform
            common.fail ('INVALID_REQUEST', 'USAGE_OVERFLOW');
        end if;
      end if;
    end loop;
    if p_usage ->> 'input_total' is not null and (coalesce((p_usage ->> 'cache_read')::numeric, 0) + coalesce((p_usage ->> 'cache_write')::numeric, 0) + coalesce((p_usage ->> 'input_standard')::numeric, 0)) > (p_usage ->> 'input_total')::numeric then
      perform
        common.fail ('INVALID_REQUEST', 'INPUT_CONSERVATION');
    end if;
    if p_usage ->> 'input_total' is not null and p_usage ->> 'cache_read' is not null and p_usage ->> 'cache_write' is not null and p_usage ->> 'input_standard' is not null and (p_usage ->> 'input_total')::numeric <> ((p_usage ->> 'cache_read')::numeric + (p_usage ->> 'cache_write')::numeric + (p_usage ->> 'input_standard')::numeric) then
      perform
        common.fail ('INVALID_REQUEST', 'INPUT_CONSERVATION');
    end if;
    if p_usage ->> 'reasoning' is not null and p_usage ->> 'output' is not null and (p_usage ->> 'reasoning')::numeric > (p_usage ->> 'output')::numeric then
      perform
        common.fail ('INVALID_REQUEST', 'OUTPUT_CONSERVATION');
    end if;
end
$$;
create function public.ai_attempt_complete (p_input jsonb)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  u uuid;
  r ai.requests;
  a ai.attempts;
  d text;
  known numeric := 0;
  full_cost boolean := true;
  cost_overflow boolean := false;
  c record;
  n numeric;
  usage jsonb;
begin
  perform
    common.guard (p_input);
    perform
      common.required (p_input, array['owner_auth_user_id', 'request_id']);
      u = (p_input ->> 'owner_auth_user_id')::uuid;
      perform
        1
      from
        ai.runtime_control
      where
        id = 1
      for update;
      select
        *
      into
        r
      from
        ai.requests
      where
        external_id = p_input ->> 'request_id'
        and (owner_auth_user_id = u
          or owner_auth_user_id is null)
      for update;
      if not found then
        perform
          common.fail ('NOT_FOUND');
      end if;
      select
        *
      into
        a
      from
        ai.attempts
      where
        request_id = r.id
        and external_id = p_input ->> 'attempt_id'
      for update;
      if not found then
        perform
          common.fail ('NOT_FOUND');
      end if;
      perform
        common.required (p_input, array['state', 'usage']);
        d = common.digest(p_input - array['contract_code', 'database_instance_id', 'owner_auth_user_id']);
        if a.state <> 'STARTED' then
          if a.fact_digest <> d then
            perform
              common.fail ('CONFLICT', 'TERMINAL_FACT_CHANGED');
          end if;
          return jsonb_build_object('attempt_id', a.external_id, 'state', a.state, 'replayed', true);
        end if;
        if p_input ->> 'state' not in ('SUCCEEDED', 'CANCELED', 'FAILED_UPSTREAM', 'TIMED_OUT', 'INVALID_OUTPUT', 'UNKNOWN') then
          perform
            common.fail ('INVALID_REQUEST', 'ATTEMPT_STATE');
        end if;
        if p_input ->> 'state' = 'SUCCEEDED' and (p_input ->> 'transmitted')::boolean is distinct from true then
          perform
            common.fail ('INVALID_REQUEST', 'SUCCESS_REQUIRES_TRANSMISSION');
        end if;
        if (p_input ->> 'retry_allowed')::boolean is true and p_input ->> 'state' not in ('FAILED_UPSTREAM', 'TIMED_OUT', 'INVALID_OUTPUT') then
          perform
            common.fail ('INVALID_REQUEST', 'INVALID_RETRY_FACT');
        end if;
        usage = p_input -> 'usage';
        perform
          ai.usage_validate (usage);
          for c in
          select
            component,
            nanos_per_million
          from
            ai.price_components
          where
            price_version_id = r.price_version_id
          order by
            component loop
              n = (usage ->> case c.component
                when 'INPUT_STANDARD' then
                  'input_standard'
                when 'INPUT_CACHE_READ' then
                  'cache_read'
                when 'INPUT_CACHE_WRITE' then
                  'cache_write'
                else
                  'output'
                end)::numeric;
              if n is null then
                if c.nanos_per_million > 0 then
                  full_cost = false;
                end if;
              else
                known = known + n * c.nanos_per_million::numeric;
              end if;
            end loop;
            known = ceil(known / 1000000);
            if (p_input ->> 'provider_billable')::boolean is false then
              known = 0;
              full_cost = true;
            end if;
            if known > 9223372036854775807 then
              known = null;
              full_cost = false;
              cost_overflow = true;
            end if;
            update
              ai.attempts
            set
              state = p_input ->> 'state',
              time_terminal = clock_timestamp(),
              transmitted = (p_input ->> 'transmitted')::boolean,
              provider_billable = (p_input ->> 'provider_billable')::boolean,
              retry_allowed = (p_input ->> 'retry_allowed')::boolean,
              fact_digest = d,
              usage = usage,
              estimated_cost_nanos = case when full_cost then
                known::bigint
              end,
              known_estimated_cost_nanos = known::bigint,
              provider_reported_cost_nanos = (p_input ->> 'provider_reported_cost_nanos')::bigint,
              incomplete_reasons = case when cost_overflow then
                array['COST_OVERFLOW']
              when full_cost then
                '{}'::text[]
              else
                array['USAGE_INCOMPLETE']
              end
            where
              id = a.id
            returning
              *
            into
              a;
              update
                ai.requests
              set
                time_progress = clock_timestamp(),
                cancel_sequence = case when p_input ->> 'state' = 'CANCELED' then
                  greatest (cancel_sequence, 1)
                else
                  cancel_sequence
                end,
                time_canceled = case when p_input ->> 'state' = 'CANCELED' then
                  coalesce(time_canceled, clock_timestamp())
                else
                  time_canceled
                end
              where
                id = r.id;
                return jsonb_build_object('attempt_id', a.external_id, 'state', a.state, 'replayed', false);
end
$$;
create function ai.finalize_locked (p_id bigint)
  returns jsonb
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  r ai.requests;
  n int;
  pending boolean;
  transmitted boolean;
  unknown boolean;
  success boolean;
  invalid boolean;
  charged boolean;
  outcome text;
  tokens_in bigint;
  tokens_out bigint;
  known numeric;
  estimated numeric;
  reported numeric;
  incomplete text[];
  usage_incomplete boolean;
  aggregate_usage jsonb;
  known_usage jsonb;
  key text;
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
    return jsonb_build_object('request_id', r.external_id, 'state', r.state, 'outcome', r.outcome, 'charged', r.charged, 'quota', ai.quota_value (r.owner_auth_user_id, r.quota_day));
  end if;
  select
    count(*),
    coalesce(bool_or(state = 'STARTED'), false),
    coalesce(bool_or(a.transmitted), false),
    coalesce(bool_or(state = 'UNKNOWN'
        or a.transmitted is null), false),
    coalesce(bool_or(state = 'SUCCEEDED'), false),
    coalesce(bool_or(state = 'INVALID_OUTPUT'), false),
    coalesce(sum((usage ->> 'input_total')::bigint), 0),
    coalesce(sum((usage ->> 'output')::bigint), 0),
    case when count(known_estimated_cost_nanos) = 0
      and count(*) > 0 then
      null
    else
      coalesce(sum(known_estimated_cost_nanos), 0)
    end,
    case when count(estimated_cost_nanos) = count(*) then
      sum(estimated_cost_nanos)
    end,
    case when count(provider_reported_cost_nanos) = count(*) then
      sum(provider_reported_cost_nanos)
    end
  into
    n,
    pending,
    transmitted,
    unknown,
    success,
    invalid,
    tokens_in,
    tokens_out,
    known,
    estimated,
    reported
  from
    ai.attempts a
  where
    request_id = r.id;
    select
      coalesce(array_agg(distinct code), '{}'::text[])
    into
      incomplete
    from
      ai.attempts a
    cross join lateral unnest(a.incomplete_reasons) code
        where
          a.request_id = r.id;
          if known > 9223372036854775807 or estimated > 9223372036854775807 then
            known = null;
            estimated = null;
            incomplete = array_append(incomplete, 'COST_OVERFLOW');
          end if;
          if reported > 9223372036854775807 then
            reported = null;
            incomplete = array_append(incomplete, 'COST_OVERFLOW');
          end if;
          if pending or unknown then
            update
              ai.requests
            set
              state = 'HELD'
            where
              id = r.id;
              return jsonb_build_object('request_id', r.external_id, 'state', 'HELD', 'outcome', null, 'charged', null, 'quota', ai.quota_value (r.owner_auth_user_id, r.quota_day));
          end if;
          usage_incomplete = exists (
            select
              1
            from
              ai.attempts
            where
              request_id = r.id
              and (usage ->> 'input_total' is null
                or usage ->> 'output' is null));
          aggregate_usage = '{}';
          known_usage = '{}';
          foreach key in array array['input_total', 'cache_read', 'cache_write', 'input_standard', 'output', 'reasoning'] loop
            aggregate_usage = aggregate_usage || jsonb_build_object(key, (
                select
                  case when count(usage ->> key) = count(*) then
                    sum((usage ->> key)::bigint)::text
                  end from ai.attempts
                  where
                    request_id = r.id));
            known_usage = known_usage || jsonb_build_object(key, (
                select
                  coalesce(sum((usage ->> key)::bigint), 0)::text from ai.attempts
              where
                request_id = r.id));
          end loop;
          outcome = case when n = 0 then
            'RELEASED'
          when r.cancel_sequence > 0 then
            'CANCELED'
          when success then
            'SUCCEEDED'
          when invalid then
            'INVALID_OUTPUT'
          else
            'FAILED_UPSTREAM'
          end;
          charged = outcome = 'SUCCEEDED'
          or (outcome = 'CANCELED'
            and transmitted);
          update
            ai.user_usage_daily
          set
            reserved_count = reserved_count - 1,
            charged_count = charged_count + charged::int,
            succeeded_count = succeeded_count + (outcome = 'SUCCEEDED')::int,
            failed_count = failed_count + (outcome in ('FAILED_UPSTREAM', 'INVALID_OUTPUT'))::int,
            canceled_count = canceled_count + (outcome = 'CANCELED')::int,
            input_tokens = input_tokens + tokens_in,
            output_tokens = output_tokens + tokens_out,
            incomplete_usage_count = incomplete_usage_count + usage_incomplete::int
          where
            auth_user_id = r.owner_auth_user_id
            and day = r.quota_day;
            if r.provider_admission_day is not null then
              update
                ai.global_usage_daily
              set
                succeeded_count = succeeded_count + (outcome = 'SUCCEEDED')::int,
                failed_count = failed_count + (outcome in ('FAILED_UPSTREAM', 'INVALID_OUTPUT'))::int,
                canceled_count = canceled_count + (outcome = 'CANCELED')::int,
                input_tokens = input_tokens + tokens_in,
                output_tokens = output_tokens + tokens_out,
                incomplete_usage_count = incomplete_usage_count + usage_incomplete::int
              where
                day = r.provider_admission_day;
            end if;
  insert into ai.profile_usage_daily (day, profile_version_id, currency, request_count, attempt_count, known_estimated_cost_nanos, incomplete_count, input_tokens, output_tokens, incomplete_usage_count)
    values (r.quota_day, r.profile_version_id, r.billing_currency, 1, n, coalesce(known, 0)::bigint, (estimated is null
        and n > 0)::int, tokens_in, tokens_out, usage_incomplete::int)
  on conflict (day, profile_version_id, currency)
    do update set
      request_count = ai.profile_usage_daily.request_count + 1,
      attempt_count = ai.profile_usage_daily.attempt_count + excluded.attempt_count,
      known_estimated_cost_nanos = ai.profile_usage_daily.known_estimated_cost_nanos + excluded.known_estimated_cost_nanos,
      incomplete_count = ai.profile_usage_daily.incomplete_count + excluded.incomplete_count,
      input_tokens = ai.profile_usage_daily.input_tokens + excluded.input_tokens,
      output_tokens = ai.profile_usage_daily.output_tokens + excluded.output_tokens,
      incomplete_usage_count = ai.profile_usage_daily.incomplete_usage_count + excluded.incomplete_usage_count;
    update
      ai.requests
    set
      state = 'FINALIZED',
      outcome = outcome,
      charged = charged,
      time_finalized = clock_timestamp(),
      time_progress = clock_timestamp(),
      usage = aggregate_usage,
      known_usage = known_usage,
      known_estimated_cost_nanos = known,
      estimated_cost_nanos = case when n = 0 then
        0
      else
        estimated
      end,
      provider_reported_cost_nanos = reported,
      incomplete_reasons = incomplete
    where
      id = r.id;
      return jsonb_build_object('request_id', r.external_id, 'state', 'FINALIZED', 'outcome', outcome, 'charged', charged, 'quota', ai.quota_value (r.owner_auth_user_id, r.quota_day));
end
$$;
create function public.ai_finalize (p_input jsonb)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  u uuid;
  r ai.requests;
begin
  perform
    common.guard (p_input);
    perform
      common.required (p_input, array['owner_auth_user_id', 'request_id']);
      u = (p_input ->> 'owner_auth_user_id')::uuid;
      perform
        1
      from
        ai.runtime_control
      where
        id = 1
      for update;
      select
        *
      into
        r
      from
        ai.requests
      where
        external_id = p_input ->> 'request_id'
        and (owner_auth_user_id = u
          or owner_auth_user_id is null)
      for update;
      if not found then
        perform
          common.fail ('NOT_FOUND');
      end if;
      return ai.finalize_locked (r.id);
end
$$;
create function public.ai_cancel (p_input jsonb)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  u uuid;
  r ai.requests;
begin
  u = common.service_user (p_input);
  perform
    1
  from
    ai.runtime_control
  where
    id = 1
  for update;
  select
    *
  into
    r
  from
    ai.requests
  where
    external_id = p_input ->> 'request_id'
    and owner_auth_user_id = u
  for update;
  if not found then
    perform
      common.fail ('NOT_FOUND');
  end if;
  if r.state <> 'FINALIZED' and r.cancel_sequence = 0 then
    update
      ai.requests
    set
      cancel_sequence = 1,
      time_canceled = clock_timestamp(),
      time_progress = clock_timestamp()
    where
      id = r.id
    returning
      *
    into
      r;
  end if;
  return jsonb_build_object('request_id', r.external_id, 'state', r.state, 'cancel_sequence', r.cancel_sequence::text);
end
$$;
create function admin.table_for (p_kind text)
  returns regclass
  language plpgsql
  immutable
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
begin
  return case p_kind
  when 'providers' then
    'ai.providers'::regclass
  when 'profiles' then
    'ai.profiles'::regclass
  when 'profile_versions' then
    'ai.profile_versions'::regclass
  when 'price_versions' then
    'ai.price_versions'::regclass
  when 'policies' then
    'ai.policies'::regclass
  when 'policy_versions' then
    'ai.policy_versions'::regclass
  when 'members' then
    'admin.members'::regclass
  when 'validations' then
    'admin.validations'::regclass
  when 'readbacks' then
    'admin.readbacks'::regclass
  when 'operations' then
    'admin.operations'::regclass
  when 'requests' then
    'ai.requests'::regclass
  when 'events' then
    'audit.events'::regclass
  else
    null
  end;
end
$$;
create function admin.project (p_kind text, p_row jsonb)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  j jsonb := p_row - array['id', 'creation_txid'];
  k text;
  v text;
begin
  foreach k in array array['revision', 'generation', 'config_generation', 'control_revision', 'environment_revision', 'close_cycle', 'user_daily_limit', 'global_daily_limit', 'user_minute_limit', 'cancel_sequence', 'estimated_cost_nanos', 'known_estimated_cost_nanos', 'provider_reported_cost_nanos'] loop
    if j ? k and j -> k <> 'null'::jsonb then
      j = jsonb_set(j, array[k], to_jsonb (j ->> k));
    end if;
  end loop;
  if j ? 'selected_option_id' then
    j = jsonb_set(j, '{selected_option_id}', coalesce((
        select
          to_jsonb (external_id)
        from ai.policy_options
        where
          id = (p_row ->> 'selected_option_id')::bigint), 'null'));
  end if;
  if j ? 'operation_id' then
    j = jsonb_set(j, '{operation_id}', coalesce((
        select
          to_jsonb (external_id)
        from admin.operations
        where
          id = (p_row ->> 'operation_id')::bigint), 'null'));
  end if;
  if j ? 'provider_id' then
    j = jsonb_set(j, '{provider_id}', coalesce((
        select
          to_jsonb (external_id)
        from ai.providers
        where
          id = (p_row ->> 'provider_id')::bigint), 'null'));
  end if;
  if j ? 'profile_id' then
    j = jsonb_set(j, '{profile_id}', coalesce((
        select
          to_jsonb (external_id)
        from ai.profiles
        where
          id = (p_row ->> 'profile_id')::bigint), 'null'));
  end if;
  if j ? 'profile_version_id' then
    j = jsonb_set(j, '{profile_version_id}', coalesce((
        select
          to_jsonb (external_id)
        from ai.profile_versions
        where
          id = (p_row ->> 'profile_version_id')::bigint), 'null'));
  end if;
  if j ? 'price_version_id' then
    j = jsonb_set(j, '{price_version_id}', coalesce((
        select
          to_jsonb (external_id)
        from ai.price_versions
        where
          id = (p_row ->> 'price_version_id')::bigint), 'null'));
  end if;
  if j ? 'policy_id' then
    j = jsonb_set(j, '{policy_id}', coalesce((
        select
          to_jsonb (external_id)
        from ai.policies
        where
          id = (p_row ->> 'policy_id')::bigint), 'null'));
  end if;
  if j ? 'policy_version_id' then
    j = jsonb_set(j, '{policy_version_id}', coalesce((
        select
          to_jsonb (external_id)
        from ai.policy_versions
        where
          id = (p_row ->> 'policy_version_id')::bigint), 'null'));
  end if;
  if j ? 'legal_bundle_id' then
    j = jsonb_set(j, '{legal_bundle_id}', coalesce((
        select
          to_jsonb (external_id)
        from legal.bundles
        where
          id = (p_row ->> 'legal_bundle_id')::bigint), 'null'));
  end if;
  if j ? 'legal_disclosure_id' then
    j = jsonb_set(j, '{legal_disclosure_id}', coalesce((
        select
          to_jsonb (external_id)
        from legal.disclosures
        where
          id = (p_row ->> 'legal_disclosure_id')::bigint), 'null'));
  end if;
  if j ? 'active_policy_version_id' then
    j = jsonb_set(j, '{active_policy_version_id}', coalesce((
        select
          to_jsonb (external_id)
        from ai.policy_versions
        where
          id = (p_row ->> 'active_policy_version_id')::bigint), 'null'));
  end if;
  if j ? 'capability_id' then
    j = (j - 'capability_id') || jsonb_build_object('capability_code', (
        select
          code
        from ai.capabilities
        where
          id = (p_row ->> 'capability_id')::smallint));
  end if;
  if p_kind = 'providers' then
    j = (j - array['default_capability_id', 'default_endpoint_url', 'default_credential_ref', 'default_model_id']) || jsonb_build_object('defaults', jsonb_build_object('capability_code', (
          select
            code
          from ai.capabilities
          where
            id = (p_row ->> 'default_capability_id')::smallint), 'endpoint_url', p_row -> 'default_endpoint_url', 'credential_ref', p_row -> 'default_credential_ref', 'model_id', p_row -> 'default_model_id'));
  end if;
  if p_kind = 'profile_versions' then
    j = j || jsonb_build_object('disclosure_id', j -> 'legal_disclosure_id', 'parent_revision', (
        select
          revision::text
        from ai.profiles
        where
          id = (p_row ->> 'profile_id')::bigint));
  elsif p_kind = 'price_versions' then
    j = j || jsonb_build_object('parent_revision', (
        select
          p.revision::text
        from ai.profiles p
        join ai.profile_versions v on v.profile_id = p.id
        where
          v.id = (p_row ->> 'profile_version_id')::bigint));
  elsif p_kind = 'policy_versions' then
    j = j || jsonb_build_object('parent_revision', (
        select
          revision::text
        from ai.policies
        where
          id = (p_row ->> 'policy_id')::bigint));
  end if;
  if p_kind = 'price_versions' then
    j = j || jsonb_build_object('valid_from', p_row -> 'time_valid_from', 'valid_until', p_row -> 'time_valid_until', 'components', (
        select
          jsonb_object_agg(component, nanos_per_million::text)
        from ai.price_components
        where
          price_version_id = (p_row ->> 'id')::bigint));
  end if;
  if p_kind = 'policy_versions' then
    j = j || jsonb_build_object('options', (
        select
          coalesce(jsonb_agg(jsonb_build_object('external_id', o.external_id, 'profile_version_id', v.external_id, 'price_lane_code', o.price_lane_code, 'display_order', o.display_order)
          order by o.display_order, o.id), '[]')
        from ai.policy_options o
        join ai.profile_versions v on v.id = o.profile_version_id
        where
          o.policy_version_id = (p_row ->> 'id')::bigint), 'rules', (
          select
            coalesce(jsonb_agg(jsonb_build_object('ordinal', r.ordinal, 'is_fallback', r.is_fallback, 'weekday', r.weekday, 'start_minute', r.start_minute, 'end_minute', r.end_minute, 'default_option_id', (
                    select
                      external_id
                    from ai.policy_options
                  where
                    id = r.default_option_id), 'option_ids', (
                    select
                      jsonb_agg(o.external_id order by o.display_order)
                  from ai.routing_rule_options m
                  join ai.policy_options o on o.id = m.option_id
                where
                  m.policy_version_id = r.policy_version_id
                  and m.rule_ordinal = r.ordinal))
            order by r.ordinal), '[]')
      from ai.routing_rules r
    where
      r.policy_version_id = (p_row ->> 'id')::bigint));
  end if;
  if p_kind = 'validations' then
    return jsonb_build_object('external_id', j -> 'external_id', 'target_kind', j -> 'target_kind', 'target_id', coalesce(nullif (j -> 'profile_version_id', 'null'), nullif (j -> 'price_version_id', 'null'), nullif (j -> 'policy_version_id', 'null')), 'dependency_digest', j -> 'dependency_digest', 'passed', j -> 'passed', 'reasons', j -> 'reasons', 'time_checked', j -> 'time_checked', 'time_expires', j -> 'time_expires');
  elsif p_kind = 'readbacks' then
    return jsonb_build_object('external_id', j -> 'external_id', 'policy_version_id', j -> 'policy_version_id', 'dependency_digest', j -> 'dependency_digest', 'passed', j -> 'passed', 'reasons', j -> 'reasons', 'time_checked', j -> 'time_checked', 'time_expires', j -> 'time_expires');
  end if;
  if p_kind = 'requests' then
    j = j - array['request_fingerprint', 'client_request_key'];
  end if;
  return j;
end
$$;
create function public.admin_context ()
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  u uuid;
begin
  u = common.admin_id ();
  return public.app_context () || jsonb_build_object('member_id', (
      select
        external_id
      from admin.members
      where
        auth_user_id = u), 'aal', common.jwt () ->> 'aal', 'control', (
    select
      admin.project ('control', jsonb_build_object('enabled', c.enabled, 'active_policy_version_id', c.active_policy_version_id, 'audience', c.audience, 'generation', c.generation, 'close_cycle', c.close_cycle, 'revision', c.revision, 'user_daily_limit', c.user_daily_limit, 'global_daily_limit', c.global_daily_limit, 'user_minute_limit', c.user_minute_limit))
    from ai.runtime_control c
    where
      id = 1), 'legal', public.legal_current ());
end
$$;
create function public.admin_records (p_kind text, p_limit integer default 50, p_after text default null)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  t regclass;
  rows jsonb;
begin
  perform
    common.admin_id ();
    if p_limit < 1 or p_limit > 100 then
      perform
        common.fail ('INVALID_REQUEST', 'PAGE_LIMIT');
    end if;
    if p_kind = 'users' then
      rows = common.auth_user_page (p_limit, p_after);
      return jsonb_build_object('records', rows, 'next_cursor', case when jsonb_array_length(rows) = p_limit then
          rows -> - 1 ->> 'auth_user_id'
        end);
    end if;
    t = admin.table_for (p_kind);
    if t is null then
      perform
        common.fail ('INVALID_REQUEST', 'UNKNOWN_RECORD_KIND');
    end if;
    execute format('select coalesce(jsonb_agg(admin.project($1,to_jsonb(x)) order by x.external_id),''[]''::jsonb) from(select * from %s where $2 is null or external_id>$2 order by external_id limit $3)x', t) into rows
    using p_kind, p_after, p_limit;
    return jsonb_build_object('records', rows, 'next_cursor', case when jsonb_array_length(rows) = p_limit then
        rows -> - 1 ->> 'external_id'
      end);
end
$$;
create function public.admin_record (p_kind text, p_external_id text)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  t regclass;
  j jsonb;
begin
  perform
    common.admin_id ();
    t = admin.table_for (p_kind);
    if t is null then
      perform
        common.fail ('INVALID_REQUEST', 'UNKNOWN_RECORD_KIND');
    end if;
    execute format('select admin.project($1,to_jsonb(x)) from %s x where external_id=$2', t) into j
    using p_kind, p_external_id;
    if j is null then
      perform
        common.fail ('NOT_FOUND');
    end if;
    return j;
end
$$;
create function public.admin_analytics (p_days integer default 30)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
  #variable_conflict use_variable
begin
  perform
    common.admin_id ();
    if p_days not between 1 and 90 then
      perform
        common.fail ('INVALID_REQUEST', 'DAYS_RANGE');
    end if;
    return jsonb_build_object('days', p_days, 'token_totals_kind', 'KNOWN_LOWER_BOUND', 'global', coalesce((
        select
          jsonb_agg(to_jsonb (g) || jsonb_build_object('admitted_count', g.admitted_count::text, 'succeeded_count', g.succeeded_count::text, 'failed_count', g.failed_count::text, 'canceled_count', g.canceled_count::text, 'input_tokens', g.input_tokens::text, 'output_tokens', g.output_tokens::text, 'incomplete_usage_count', g.incomplete_usage_count::text)
        order by day)
        from ai.global_usage_daily g
        where
          day >= (clock_timestamp() at time zone 'UTC')::date - p_days), '[]'), 'profiles', coalesce((
      select
        jsonb_agg((to_jsonb (p) - 'profile_version_id') || jsonb_build_object('profile_version_id', v.external_id, 'known_estimated_cost_nanos', p.known_estimated_cost_nanos::text, 'request_count', p.request_count::text, 'attempt_count', p.attempt_count::text, 'incomplete_count', p.incomplete_count::text, 'input_tokens', p.input_tokens::text, 'output_tokens', p.output_tokens::text, 'incomplete_usage_count', p.incomplete_usage_count::text)
      order by day)
    from ai.profile_usage_daily p
    join ai.profile_versions v on v.id = p.profile_version_id
    where
      day >= (clock_timestamp() at time zone 'UTC')::date - p_days), '[]'));
end
$$;
-- Full configuration dependency snapshot; object identity plus all publication inputs.
create function admin.dependencies (p_kind text, p_id bigint)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  j jsonb;
  pv bigint;
  policy bigint;
begin
  if p_kind = 'PROFILE' then
    pv = p_id;
    j = jsonb_build_object('target', (
        select
          to_jsonb (v)
        from ai.profile_versions v
        where
          id = p_id));
  elsif p_kind = 'PRICE' then
    select
      profile_version_id
    into
      pv
    from
      ai.price_versions
    where
      id = p_id;
      j = jsonb_build_object('target', (
          select
            to_jsonb (v)
          from ai.price_versions v
          where
            id = p_id), 'components', (
            select
              jsonb_agg(to_jsonb (c)
            order by component)
            from ai.price_components c
            where
              price_version_id = p_id));
    elsif p_kind = 'POLICY' then
      policy = p_id;
      j = jsonb_build_object('target', (
          select
            to_jsonb (v)
          from ai.policy_versions v
          where
            id = p_id), 'options', (
            select
              jsonb_agg(to_jsonb (o)
            order by id)
            from ai.policy_options o
            where
              policy_version_id = p_id), 'rules', (
              select
                jsonb_agg(to_jsonb (r)
                order by ordinal)
              from ai.routing_rules r
            where
              policy_version_id = p_id), 'members', (
              select
                jsonb_agg(to_jsonb (m)
                order by rule_ordinal, option_id)
              from ai.routing_rule_options m
            where
              policy_version_id = p_id));
    else
      perform
        common.fail ('INVALID_REQUEST', 'TARGET_KIND');
  end if;
  if j -> 'target' = 'null'::jsonb or j -> 'target' is null then
    perform
      common.fail ('NOT_FOUND');
  end if;
  return j || jsonb_build_object('environment', (
      select
        to_jsonb (e)
      from admin.environment e
      where
        id = 1), 'current', (
        select
          to_jsonb (c)
        from legal.current_state c
        where
          id = 1), 'control', (
          select
            to_jsonb (c)
          from ai.runtime_control c
        where
          id = 1), 'profiles', (
          select
            coalesce(jsonb_agg(jsonb_build_object('profile', to_jsonb (p), 'version', to_jsonb (v), 'provider', to_jsonb (r), 'capability', to_jsonb (c), 'disclosure', to_jsonb (d), 'bundle', to_jsonb (b), 'document', to_jsonb (ld), 'prices', (
                  select
                    jsonb_agg(to_jsonb (pc) || jsonb_build_object('components', (
                        select
                          jsonb_agg(to_jsonb (cp)
                        order by component)
                        from ai.price_components cp
                      where
                        cp.price_version_id = pc.id))
                  order by pc.id)
                  from ai.price_versions pc
                where
                  pc.profile_version_id = v.id))
            order by v.id), '[]')
          from ai.profile_versions v
          join ai.profiles p on p.id = v.profile_id
          join ai.providers r on r.id = p.provider_id
          join ai.capabilities c on c.id = v.capability_id
          join legal.disclosures d on d.id = v.legal_disclosure_id
          join legal.bundles b on b.id = d.bundle_id
          join legal.document_versions ld on ld.id = b.ai_document_version_id
        where
          v.id = pv
          or v.id in (
            select
              o.profile_version_id
            from ai.policy_options o
          where
            o.policy_version_id = policy)));
end
$$;
create function admin.candidate (p_kind text, p_external text)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  t regclass;
  i bigint;
  j jsonb;
  profiles jsonb;
  expires timestamptz := clock_timestamp() + interval '10 minutes';
  reason text[] := '{}';
begin
  t = case p_kind
  when 'PROFILE' then
    'ai.profile_versions'::regclass
  when 'PRICE' then
    'ai.price_versions'::regclass
  when 'POLICY' then
    'ai.policy_versions'::regclass
  end;
  if t is null then
    perform
      common.fail ('INVALID_REQUEST', 'TARGET_KIND');
  end if;
  execute format('select id from %s where external_id=$1', t) into i
  using p_external;
  j = admin.dependencies (p_kind, i);
  select
    coalesce(jsonb_agg(ai.profile_snapshot ((x -> 'version' ->> 'id')::bigint)), '[]')
  into
    profiles
  from
    jsonb_array_elements(j -> 'profiles') x;
    if exists (
      select
        1
      from
        jsonb_array_elements(j -> 'profiles') x
      where
        x -> 'provider' ->> 'time_archived' is not null
        or x -> 'profile' ->> 'time_retired' is not null
        or x -> 'capability' ->> 'time_deprecated' is not null
        or x -> 'bundle' ->> 'time_sealed' is null
        or x -> 'bundle' ->> 'id' is distinct from j -> 'current' ->> 'ai_bundle_id') then
    reason = array_append(reason, 'DEPENDENCY_UNAVAILABLE');
end if;
if p_kind = 'PRICE' and j -> 'profiles' -> 0 -> 'version' ->> 'status' is distinct from 'PUBLISHED' then
  reason = array_append(reason, 'PROFILE_NOT_PUBLISHED');
end if;
if p_kind = 'POLICY' and exists (
  select
    1
  from
    ai.policy_options o
    join ai.profile_versions v on v.id = o.profile_version_id
  where
    o.policy_version_id = i and (v.status <> 'PUBLISHED' or ai.price_at (v.id, o.price_lane_code, clock_timestamp()) is null)) then
  reason = array_append(reason, 'OPTION_NOT_READY');
end if;
select
  least (expires, min(x))
into
  expires
from (
  select
    (pc ->> 'time_valid_from')::timestamptz x
  from
    jsonb_array_elements(j -> 'profiles') p
    cross join lateral jsonb_array_elements(coalesce(nullif (p -> 'prices', 'null'), '[]')) pc
union all
select
  least ((pc ->> 'time_valid_until')::timestamptz, (pc ->> 'time_closed')::timestamptz)
from
  jsonb_array_elements(j -> 'profiles') p
  cross join lateral jsonb_array_elements(coalesce(nullif (p -> 'prices', 'null'), '[]')) pc) z
where
  x > clock_timestamp();
  return jsonb_build_object('environment', (
      select
        name
      from admin.environment
      where
        id = 1), 'database_instance_id', (
      select
        database_instance_id
      from admin.environment
      where
        id = 1), 'target_kind', p_kind, 'target_id', p_external, 'dependency_digest', common.digest(j), 'passed', cardinality(reason) = 0, 'reasons', to_jsonb (reason), 'time_expires', expires, 'data', jsonb_build_object('profiles', profiles, 'configuration', j -> 'target'));
end
$$;
create function public.config_validation_candidate (p_input jsonb)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
  #variable_conflict use_variable
begin
  perform
    common.guard (p_input);
    perform
      1
    from
      ai.runtime_control
    where
      id = 1
    for update;
    return admin.candidate (p_input ->> 'target_kind', p_input ->> 'target_id');
end
$$;
create function public.config_validation_record (p_input jsonb)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  j jsonb;
  i bigint;
  b bigint;
  v admin.validations;
  k text := p_input ->> 'target_kind';
begin
  perform
    common.guard (p_input);
    perform
      1
    from
      ai.runtime_control
    where
      id = 1
    for update;
    j = admin.candidate (k, p_input ->> 'target_id');
    if j ->> 'dependency_digest' is distinct from p_input ->> 'dependency_digest' then
      perform
        common.fail ('CONFLICT', 'CONFIG_CHANGED');
    end if;
    if k = 'PROFILE' then
      select
        id,
        legal_bundle_id
      into
        i,
        b
      from
        ai.profile_versions
      where
        external_id = p_input ->> 'target_id';
      elsif k = 'PRICE' then
        select
          p.id,
          profile_ver.legal_bundle_id
        into
          i,
          b
        from
          ai.price_versions p
          join ai.profile_versions profile_ver on profile_ver.id = p.profile_version_id
        where
          p.external_id = p_input ->> 'target_id';
        else
          select
            id,
            legal_bundle_id
          into
            i,
            b
          from
            ai.policy_versions
          where
            external_id = p_input ->> 'target_id';
    end if;
    select
      *
    into
      v
    from
      jsonb_populate_record(null::admin.validations, common.insert_entity ('admin.validations', jsonb_build_object('target_kind', k, 'profile_version_id', case when k = 'PROFILE' then
              i
            end, 'price_version_id', case when k = 'PRICE' then
              i
            end, 'policy_version_id', case when k = 'POLICY' then
              i
            end, 'legal_bundle_id', b, 'dependency_digest', j ->> 'dependency_digest', 'environment_revision', (
              select
                revision
              from admin.environment
              where
                id = 1), 'passed', coalesce((p_input ->> 'passed')::boolean, false)
          and (j ->> 'passed')::boolean, 'reasons', (coalesce(p_input -> 'reasons', '[]') || (j -> 'reasons')), 'time_checked', clock_timestamp(), 'time_expires', j ->> 'time_expires')));
      return admin.project ('validations', to_jsonb (v));
end
$$;
create function public.runtime_readback_candidate (p_input jsonb)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  c ai.runtime_control;
  j jsonb;
begin
  perform
    common.guard (p_input);
    select
      *
    into
      c
    from
      ai.runtime_control
    where
      id = 1
    for update;
    if c.enabled or c.active_policy_version_id is null or not exists (
      select
        1
      from
        ai.policy_versions
      where
        id = c.active_policy_version_id and status = 'PUBLISHED') then
      perform
        common.fail ('CONFLICT', 'DISABLED_POLICY_REQUIRED');
    end if;
    j = admin.candidate ('POLICY', (
        select
          external_id
        from ai.policy_versions
        where
          id = c.active_policy_version_id));
    return j || jsonb_build_object('time_expires', least ((j ->> 'time_expires')::timestamptz, clock_timestamp() + interval '5 minutes'));
end
$$;
create function public.runtime_readback_record (p_input jsonb)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  j jsonb;
  c ai.runtime_control;
  v admin.readbacks;
begin
  j = public.runtime_readback_candidate (p_input);
  if j ->> 'dependency_digest' is distinct from p_input ->> 'dependency_digest' then
    perform
      common.fail ('CONFLICT', 'CONFIG_CHANGED');
  end if;
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
      v
    from
      jsonb_populate_record(null::admin.readbacks, common.insert_entity ('admin.readbacks', jsonb_build_object('policy_version_id', c.active_policy_version_id, 'legal_bundle_id', (
              select
                legal_bundle_id
              from ai.policy_versions
              where
                id = c.active_policy_version_id), 'generation', c.generation, 'control_revision', c.revision, 'close_cycle', c.close_cycle, 'environment_revision', (
              select
                revision
              from admin.environment
              where
                id = 1), 'dependency_digest', j ->> 'dependency_digest', 'passed', coalesce((p_input ->> 'passed')::boolean, false)
          and (j ->> 'passed')::boolean, 'reasons', (coalesce(p_input -> 'reasons', '[]') || (j -> 'reasons')), 'time_checked', clock_timestamp(), 'time_expires', j ->> 'time_expires')));
      return admin.project ('readbacks', to_jsonb (v));
end
$$;
create function common.insert_entity (p_table regclass, p_values jsonb)
  returns jsonb
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  cols text;
  vals text;
  j jsonb;
  i int;
  c text;
  ext_constraint text;
begin
  select
    string_agg(format('%I', key), ',' order by key),
    string_agg(format('(jsonb_populate_record(null::%s,$1)).%I', p_table, key), ',' order by key)
  into
    cols,
    vals
  from
    jsonb_object_keys(p_values)
    key;
    select
      'uq_' || n.nspname || '_' || r.relname || '_external_id'
    into
      ext_constraint
    from
      pg_class r
      join pg_namespace n on n.oid = r.relnamespace
    where
      r.oid = p_table;
      for i in 1..5 loop
        begin
          execute format('insert into %s as t(%s) select %s returning to_jsonb(t)', p_table, cols, vals) into j
          using p_values;
          return j;
        exception
          when unique_violation then
            get stacked diagnostics c = constraint_name;
            if c <> ext_constraint or p_values ? 'external_id' then
              raise;
              end if;
        end;
        end loop;
        raise exception 'External ID collision retry limit reached' using errcode = '23505';
end
$$;
create function admin.parent_guard (p_table regclass, p_external text, p_revision text)
  returns bigint
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  j jsonb;
begin
  execute format('select to_jsonb(t) from %s t where external_id=$1 for update', p_table) into j
  using p_external;
  if j is null then
    perform
      common.fail ('NOT_FOUND');
  end if;
  if j ->> 'revision' is distinct from p_revision then
    perform
      common.fail ('CONFLICT', 'REVISION_CHANGED');
  end if;
  if j ->> 'time_retired' is not null then
    perform
      common.fail ('CONFLICT', 'PARENT_RETIRED');
  end if;
  return (j ->> 'id')::bigint;
end
$$;
create function admin.report_guard (p_kind text, p_id bigint, p_report text)
  returns void
  language plpgsql
  stable
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  v admin.validations;
begin
  select
    *
  into
    v
  from
    admin.validations
  where
    external_id = p_report
    and target_kind = p_kind
    and coalesce(profile_version_id, price_version_id, policy_version_id) = p_id
    and passed
    and time_expires > clock_timestamp();
    if not found or v.dependency_digest <> common.digest(admin.dependencies (p_kind, p_id)) then
      perform
        common.fail ('CONFLICT', 'VALIDATION_EXPIRED_OR_CHANGED');
    end if;
end
$$;
create function admin.price_create (p_input jsonb, p_profile bigint, p_actor uuid, p_start timestamptz default null)
  returns jsonb
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  j jsonb;
  k text;
  version integer;
begin
  perform
    common.required (p_input, array['lane_code', 'currency', 'calculator_kind', 'parameters', 'components']);
    if p_input -> 'parameters' is distinct from '{}'::jsonb then
      perform
        common.fail ('INVALID_REQUEST', 'UNSUPPORTED_PRICE_PARAMETERS');
    end if;
    if p_input ->> 'calculator_kind' <> 'linear_token_v1' or p_input ->> 'calculator_kind' is distinct from (
      select
        c.calculator_kind
      from
        ai.profile_versions v
        join ai.capabilities c on c.id = v.capability_id
      where
        v.id = p_profile) then
      perform
        common.fail ('INVALID_REQUEST', 'CALCULATOR_MISMATCH');
    end if;
    if jsonb_typeof(p_input -> 'components') is distinct from 'object' or not (p_input -> 'components' ?& array['INPUT_STANDARD', 'INPUT_CACHE_READ', 'INPUT_CACHE_WRITE', 'OUTPUT']) or (
    select
      count(*)
    from
      jsonb_object_keys(p_input -> 'components')) <> 4 then
      perform
        common.fail ('INVALID_REQUEST', 'PRICE_COMPONENTS');
    end if;
    select
      coalesce(max(v.version), 0) + 1
    into
      version
    from
      ai.price_versions v
    where
      v.profile_version_id = p_profile
      and lane_code = p_input ->> 'lane_code';
      j = common.insert_entity ('ai.price_versions', jsonb_build_object('profile_version_id', p_profile, 'lane_code', p_input ->> 'lane_code', 'version', version, 'currency', p_input ->> 'currency', 'calculator_kind', p_input ->> 'calculator_kind', 'parameters', p_input -> 'parameters', 'time_valid_from', coalesce(p_start, (p_input ->> 'valid_from')::timestamptz), 'time_valid_until', (p_input ->> 'valid_until')::timestamptz, 'config_digest', common.digest(p_input - array['contract_code', 'database_instance_id', 'operation_key', 'reason', 'expected_revision', 'validation_id', 'external_id']), 'user_created', p_actor));
      for k in
      select
        jsonb_object_keys(p_input -> 'components')
        loop
          if p_input -> 'components' ->> k !~ '^[0-9]+$' then
            perform
              common.fail ('INVALID_REQUEST', 'PRICE_COMPONENT_AMOUNT');
          end if;
          insert into ai.price_components (price_version_id, component, nanos_per_million)
            values ((j ->> 'id')::bigint, k, (p_input -> 'components' ->> k)::bigint);
        end loop;
        return j;
end
$$;
create function admin.apply (p_action text, p_input jsonb, p_actor uuid)
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
                      and cap_def.code = 'DEEPSEEK_CHAT'
                      and p_input ->> 'endpoint_url' = 'https://api.deepseek.com/chat/completions')
                    or (p.code = 'MIMO'
                      and cap_def.code = 'MIMO_RESPONSES'
                      and p_input ->> 'endpoint_url' = 'https://api.xiaomimimo.com/v1/responses'))) then
              perform
                common.fail ('INVALID_REQUEST', 'PROVIDER_CAPABILITY_OR_ENDPOINT');
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
create function admin.mutate (p_action text, p_input jsonb)
  returns jsonb
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  u uuid;
  op admin.operations;
  event audit.events;
  d text;
  result jsonb;
  receipt jsonb;
  j jsonb;
begin
  perform
    common.guard (p_input);
    u = common.admin_id (false);
    perform
      common.required (p_input, array['operation_key', 'reason']);
      if length(btrim(p_input ->> 'reason')) < 3 or length(p_input ->> 'reason') > 500 then
        perform
          common.fail ('INVALID_REQUEST', 'REASON_REQUIRED');
      end if;
      d = common.digest(jsonb_build_object('action', p_action, 'input', p_input));
      select
        *
      into
        op
      from
        admin.operations
      where
        actor_auth_user_id = u
        and idempotency_key = (p_input ->> 'operation_key')::uuid;
        if found then
          if op.payload_digest <> d then
            perform
              common.fail ('CONFLICT', 'IDEMPOTENCY_PAYLOAD_CHANGED');
          end if;
          return op.result;
        end if;
        if p_action <> 'ai_disable' and (p_action like '%_publish' or p_action like '%_retire' or p_action like 'ai_%' or p_action like 'member_%' or p_action in ('price_version_close', 'price_version_replace')) then
          perform
            common.admin_id (true);
        end if;
        perform
          1
        from
          ai.runtime_control
        where
          id = 1
        for update;
        result = admin.apply (p_action, p_input, u);
        j = common.insert_entity ('admin.operations', jsonb_build_object('actor_auth_user_id', u, 'idempotency_key', p_input ->> 'operation_key', 'operation_code', p_action, 'payload_digest', d, 'result', '{}'::jsonb));
        select
          *
        into
          op
        from
          admin.operations
        where
          id = (j ->> 'id')::bigint;
          j = common.insert_entity ('audit.events', jsonb_build_object('actor_kind', 'USER', 'actor_auth_user_id', u, 'operation_id', op.id, 'entity_kind', p_action, 'entity_external_id', coalesce(result ->> 'external_id', result ->> 'database_instance_id'), 'action', p_action, 'reason', p_input ->> 'reason', 'summary', jsonb_build_object('result_digest', common.digest(result))));
          select
            *
          into
            event
          from
            audit.events
          where
            id = (j ->> 'id')::bigint;
            receipt = jsonb_build_object('operation_id', op.external_id, 'operation', p_action, 'result', result, 'audit_id', event.external_id, 'time_committed', op.time_committed);
            update
              admin.operations
            set
              result = receipt
            where
              id = op.id;
              return receipt;
end
$$;
create function public.admin_provider_update (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'provider_update')
$$;
create function public.admin_profile_create (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'profile_create')
$$;
create function public.admin_profile_version_create (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'profile_version_create')
$$;
create function public.admin_profile_version_publish (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'profile_version_publish')
$$;
create function public.admin_profile_version_retire (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'profile_version_retire')
$$;
create function public.admin_price_version_create (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'price_version_create')
$$;
create function public.admin_price_version_publish (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'price_version_publish')
$$;
create function public.admin_price_version_close (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'price_version_close')
$$;
create function public.admin_price_version_replace (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'price_version_replace')
$$;
create function public.admin_price_version_retire (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'price_version_retire')
$$;
create function public.admin_policy_create (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'policy_create')
$$;
create function public.admin_policy_version_create (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'policy_version_create')
$$;
create function public.admin_policy_version_publish (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'policy_version_publish')
$$;
create function public.admin_policy_version_retire (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'policy_version_retire')
$$;
create function public.admin_profile_retire (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'profile_retire')
$$;
create function public.admin_policy_retire (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'policy_retire')
$$;
create function public.admin_ai_disable (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'ai_disable')
$$;
create function public.admin_ai_set_policy (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'ai_set_policy')
$$;
create function public.admin_ai_reopen (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'ai_reopen')
$$;
create function public.admin_ai_update_limits (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'ai_update_limits')
$$;
create function public.admin_ai_set_audience (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'ai_set_audience')
$$;
create function public.admin_ai_set_allowed_user (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'ai_set_allowed_user')
$$;
create function public.admin_member_grant (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'member_grant')
$$;
create function public.admin_member_revoke (p_input jsonb)
  returns jsonb
  language sql
  volatile
  security definer
  set search_path = ''
  as $$
  select
    admin.mutate (p_input => p_input, p_action => 'member_revoke')
$$;
create function ai.anonymize_deleted_user ()
  returns trigger
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
  #variable_conflict use_variable
begin
  new.client_request_key = null;
  new.request_fingerprint = null;
  return new;
end
$$;
create trigger anonymize_cv_ai_user
  before update of owner_auth_user_id on ai.requests for each row
  when (old.owner_auth_user_id is not null and new.owner_auth_user_id is null)
  execute function ai.anonymize_deleted_user ();
create function ai.reconcile (p_limit integer default 100)
  returns integer
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  r record;
  n integer := 0;
begin
  if not exists (
    select
      1
    from
      admin.environment
    where
      id = 1) then
  return 0;
end if;
if p_limit not between 1 and 1000 then
  perform
    common.fail ('INVALID_REQUEST');
end if;
perform
  1
from
  ai.runtime_control
where
  id = 1
for update;
for r in
select
  id
from
  ai.requests
where
  state in ('RESERVED', 'RUNNING', 'HELD')
  and time_progress < clock_timestamp() - interval '600 seconds'
order by
  id
limit p_limit
for update
  skip locked loop
    if exists (
      select
        1
      from
        ai.attempts
      where
        request_id = r.id
        and state in ('STARTED', 'UNKNOWN')) then
    update
      ai.requests
    set
      state = 'HELD'
    where
      id = r.id;
    else
      perform
        ai.finalize_locked (r.id);
  end if;
  n = n + 1;
end loop;
return n;
end
$$;
create function ai.retention_cleanup (p_limit integer default 1000)
  returns integer
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  n int;
begin
  if not exists (
    select
      1
    from
      admin.environment
    where
      id = 1) then
  return 0;
end if;
if p_limit not between 1 and 5000 then
  perform
    common.fail ('INVALID_REQUEST');
end if;
perform
  1
from
  ai.runtime_control
where
  id = 1
for update;
delete from ai.requests
where id in (
    select
      id
    from
      ai.requests
    where
      state = 'FINALIZED'
      and time_finalized < clock_timestamp() - interval '90 days'
    order by
      id
    limit p_limit);
get diagnostics n = row_count;
delete from ai.rate_minutes
where (auth_user_id, minute_bucket) in (
    select
      auth_user_id,
      minute_bucket
    from
      ai.rate_minutes
    where
      minute_bucket < clock_timestamp() - interval '2 days'
    limit p_limit);
delete from ai.user_usage_daily
where (auth_user_id, day) in (
    select
      u.auth_user_id,
      u.day
    from
      ai.user_usage_daily u
    where
      day < (clock_timestamp() at time zone 'UTC')::date - 90
      and reserved_count = 0
      and not exists (
        select
          1
        from
          ai.requests r
        where
          r.state <> 'FINALIZED'
          and r.owner_auth_user_id = u.auth_user_id
          and r.quota_day = u.day)
      order by
        day,
        auth_user_id
      limit p_limit);
  delete from ai.global_usage_daily
  where day in (
      select
        g.day
      from
        ai.global_usage_daily g
      where
        day < (clock_timestamp() at time zone 'UTC')::date - 90
        and not exists (
          select
            1
          from
            ai.requests r
          where
            r.state <> 'FINALIZED'
            and r.provider_admission_day = g.day)
        order by
          day
        limit p_limit);
    delete from ai.profile_usage_daily
    where (day, profile_version_id, currency) in (
        select
          p.day,
          p.profile_version_id,
          p.currency
        from
          ai.profile_usage_daily p
        where
          day < (clock_timestamp() at time zone 'UTC')::date - 90
          and not exists (
            select
              1
            from
              ai.requests r
            where
              r.state <> 'FINALIZED'
              and r.profile_version_id = p.profile_version_id
              and r.quota_day = p.day)
          order by
            day,
            profile_version_id,
            currency
          limit p_limit);
      return n;
end
$$;
create function admin.publish_legal_current (p_terms text, p_bundle text)
  returns void
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  t bigint;
  b bigint;
begin
  perform
    1
  from
    admin.environment
  where
    id = 1
  for update;
  perform
    1
  from
    ai.runtime_control
  where
    id = 1
  for update;
  select
    id
  into
    t
  from
    legal.document_versions
  where
    external_id = p_terms
    and document_code = 'TERMS';
    select
      id
    into
      b
    from
      legal.bundles
    where
      external_id = p_bundle
      and time_sealed is not null;
      if t is null or b is null then
        perform
          common.fail ('INVALID_REQUEST', 'LEGAL_TARGET');
      end if;
      update
        ai.runtime_control
      set
        enabled = false,
        active_policy_version_id = null,
        generation = generation + 1,
        close_cycle = close_cycle + 1
      where
        id = 1;
        update
          legal.current_state
        set
          terms_document_version_id = t,
          ai_bundle_id = b
        where
          id = 1;
end
$$;
-- Deferred relational completeness and insertion-time immutable facts.
create function ai.validate_policy_graph ()
  returns trigger
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
begin
  if (
    select
      count(*)
    from
      ai.routing_rules
    where
      policy_version_id = new.id and is_fallback) <> 1 or exists (
  select
    1
  from
    ai.policy_options o
  where
    o.policy_version_id = new.id and not exists (
    select
      1
    from
      ai.routing_rule_options m
    where
      m.policy_version_id = new.id and m.option_id = o.id)) then
    perform
      common.fail ('INVALID_REQUEST', 'INCOMPLETE_POLICY_GRAPH');
  end if;
  return null;
end
$$;
create constraint trigger complete_policy
  after insert on ai.policy_versions deferrable initially deferred for each row
  execute function ai.validate_policy_graph ();
create function legal.disclosure_guard ()
  returns trigger
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
begin
  if exists (
    select
      1
    from
      legal.bundles
    where
      id = new.bundle_id
      and time_sealed is not null) then
  perform
    common.fail ('INVALID_REQUEST', 'BUNDLE_SEALED');
end if;
if not exists (
  select
    1
  from
    ai.providers
  where
    id = new.provider_id
    and recipient_code = new.recipient_code) then
perform
  common.fail ('INVALID_REQUEST', 'RECIPIENT_MISMATCH');
end if;
return new;
end
$$;
create trigger disclosure_parent_guard
  before insert on legal.disclosures for each row
  execute function legal.disclosure_guard ();
-- Private code is callable only by its dedicated RPC owner (or migration owner).
revoke all on all functions in schema common, cv, ai, legal, admin from public, anon, authenticated, service_role;
grant execute on all functions in schema common, cv, ai, legal, admin to app_api_owner;
-- owner-only lifecycle entry points are deliberately not granted to the API owner.
revoke all on function admin.initialize (text, uuid), admin.publish_legal_current (text, text), ai.reconcile (integer), ai.retention_cleanup (integer) from app_api_owner;
grant create on schema public, ai to app_api_owner;
do $$
declare
  r record;
begin
  for r in
  select
    p.oid::regprocedure sig,
    p.proname
  from
    pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
  where
    n.nspname = 'public'
    and (p.proname in ('app_context', 'keep_project_active', 'legal_current', 'cv_document_create', 'cv_document_update', 'cv_document_convert', 'cv_document_rename', 'cv_document_delete', 'legal_accept_document', 'legal_accept_disclosure', 'admin_context', 'admin_records', 'admin_record', 'admin_analytics')
      or p.proname like 'admin_%'
      or p.proname like 'ai_%'
      or p.proname in ('config_validation_candidate', 'config_validation_record', 'runtime_readback_candidate', 'runtime_readback_record'))
      loop
        execute format('revoke all on function %s from public,anon,authenticated,service_role', r.sig);
        if r.proname in ('app_context', 'keep_project_active', 'legal_current') then
          execute format('grant execute on function %s to anon,authenticated,service_role', r.sig);
        elsif r.proname like 'ai_%'
            or r.proname in ('config_validation_candidate', 'config_validation_record', 'runtime_readback_candidate', 'runtime_readback_record') then
            execute format('grant execute on function %s to service_role', r.sig);
        else
          execute format('grant execute on function %s to authenticated', r.sig);
        end if;
        execute format('comment on function %s is %L', r.sig, 'cv_app_db_1 API. Dedicated NOLOGIN NOBYPASSRLS app_api_owner; explicit role EXECUTE; CV/legal use auth.uid; Admin validates live user/session/member and step-up; AI/producer restricted to service_role plus instance guard.');
        if r.proname <> 'keep_project_active' then
          execute format('alter function %s owner to app_api_owner', r.sig);
        end if;
      end loop;
  for r in
  select
    p.oid::regprocedure sig
  from
    pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
  where
    n.nspname in ('common', 'cv', 'ai', 'legal', 'admin')
    loop
      execute format('comment on function %s is %L', r.sig, 'cv_app_db_1 private helper; fixed empty search_path; no API execution grants.');
    end loop;
end
$$;
alter function ai.anonymize_deleted_user () owner to app_api_owner;
revoke create on schema public, ai from app_api_owner;
comment on function common.auth_user_active (uuid) is 'Private postgres-owned read-only Auth bridge exception: no platform GRANT OPTION. Empty search_path; app_api_owner-only EXECUTE; boolean or bounded safe Admin fields; no credentials or writes.';
comment on function common.auth_session_valid (uuid, uuid) is 'Private postgres-owned read-only Auth bridge exception: no platform GRANT OPTION. Empty search_path; app_api_owner-only EXECUTE; boolean or bounded safe Admin fields; no credentials or writes.';
comment on function common.auth_has_totp (uuid) is 'Private postgres-owned read-only Auth bridge exception: no platform GRANT OPTION. Empty search_path; app_api_owner-only EXECUTE; boolean or bounded safe Admin fields; no credentials or writes.';
comment on function common.auth_user_page (integer, text) is 'Private postgres-owned read-only Auth bridge exception: no platform GRANT OPTION. Empty search_path; app_api_owner-only EXECUTE; boolean or bounded safe Admin fields; no credentials or writes.';
commit;
