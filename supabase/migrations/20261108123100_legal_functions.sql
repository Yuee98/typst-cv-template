begin;
set local search_path = '';
-- This lexical contract is shared with web/src/lib/legal/markdown.ts and the
-- legal-markdown-corpus.json fixture. It validates stored reader input, not URLs
-- used for server-side requests, and does not perform DNS or network access.
create function legal.utf16_length (p_value text)
  returns integer
  language sql
  immutable
  strict
  security invoker
  set search_path = ''
  as $$
  select length(p_value) + length(regexp_replace(p_value collate pg_catalog."C", U&'[^\+010000-\+10FFFF]', '', 'g'))
$$;
create function legal.href_valid (p_value text)
  returns boolean
  language plpgsql
  immutable
  security invoker
  set search_path = ''
  as $$
declare
  v_space constant text := E' \t\n\v\f\r' || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  v_authority text;
  v_host text;
  v_port text;
  v_parts text[];
  v_ipv4_parts text[];
  v_part text;
  v_address inet;
  v_trailing_dot boolean := false;
begin
  if p_value is null or p_value = '' or position(E'\\' in p_value) > 0 or p_value collate pg_catalog."C" ~ '[\x01-\x20\x7f]' or p_value collate pg_catalog."C" ~ ('[' || v_space || ']') then
    return false;
  end if;
  if left(p_value, 1) = '/' then
    return left(p_value, 2) <> '//';
  end if;
  if lower(left(p_value, 8)) <> 'https://' then
    return false;
  end if;
  v_authority = split_part(split_part(split_part(substr(p_value, 9), '/', 1), '?', 1), '#', 1);
  if left(v_authority, 1) = '[' then
    v_parts = regexp_match(v_authority collate pg_catalog."C", '^\[([0-9A-Fa-f:.]+)\](:([0-9]{1,5}))?$');
    if v_parts is null then
      return false;
    end if;
    v_host = v_parts[1];
    v_port = v_parts[3];
    if position('.' in v_host) > 0 then
      -- inet accepts some noncanonical IPv4 forms that a browser URL rejects.
      v_ipv4_parts = string_to_array(regexp_replace(v_host, '^.*:', ''), '.');
      if array_length(v_ipv4_parts, 1) <> 4 then
        return false;
      end if;
      foreach v_part in array v_ipv4_parts loop
        if v_part collate pg_catalog."C" !~ '^(0|[1-9][0-9]{0,2})$' then
          return false;
        end if;
        if v_part::integer > 255 then
          return false;
        end if;
      end loop;
    end if;
    begin
      v_address = v_host::inet;
    exception when invalid_text_representation then
      return false;
    end;
    if family(v_address) <> 6 then
      return false;
    end if;
  else
    v_parts = regexp_match(v_authority collate pg_catalog."C", '^([A-Za-z0-9.-]+)(:([0-9]{1,5}))?$');
    if v_parts is null then
      return false;
    end if;
    v_host = v_parts[1];
    v_port = v_parts[3];
    if length(v_host) > 253 then
      return false;
    end if;
    if right(v_host, 1) = '.' then
      v_trailing_dot = true;
      v_host = left(v_host, length(v_host) - 1);
    end if;
    if v_host collate pg_catalog."C" !~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$' then
      return false;
    end if;
    v_parts = string_to_array(v_host, '.');
    if v_parts[array_length(v_parts, 1)] collate pg_catalog."C" ~ '^([0-9]+|0[xX][0-9A-Fa-f]+)$' then
      if v_trailing_dot or array_length(v_parts, 1) <> 4 then
        return false;
      end if;
      foreach v_part in array v_parts loop
        if v_part collate pg_catalog."C" !~ '^(0|[1-9][0-9]{0,2})$' then
          return false;
        end if;
        if v_part::integer > 255 then
          return false;
        end if;
      end loop;
    end if;
  end if;
  return v_port is null or v_port::integer between 1 and 65535;
end
$$;
create function legal.markdown_valid (p_body text)
  returns boolean
  language plpgsql
  immutable
  security invoker
  set search_path = ''
  as $$
declare
  -- ECMAScript WhiteSpace + LineTerminator, exactly matching String.trim/\s.
  v_space constant text := E' \t\n\v\f\r' || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  v_match text[];
  v_line text;
begin
  if p_body is null or btrim(p_body, v_space) = '' or legal.utf16_length(p_body) > 65536
    or position('<' in p_body) > 0 or position('>' in p_body) > 0
    or position('![' in p_body) > 0 or position('```' in p_body) > 0 then
    return false;
  end if;
  for v_match in select regexp_matches(p_body collate pg_catalog."C", '\[([^\]' || chr(10) || ']+)\]\(([^)' || v_space || ']+)\)', 'g') loop
    if not legal.href_valid(v_match[2]) then
      return false;
    end if;
  end loop;
  foreach v_line in array string_to_array(replace(replace(p_body, E'\r\n', E'\n'), E'\r', E'\n'), E'\n') loop
    if btrim(v_line, v_space) = '' or left(v_line, 3) = '## ' or left(v_line, 2) = '- ' then
      continue;
    end if;
    if v_line collate pg_catalog."C" ~ ('^[' || v_space || ']*#|^[' || v_space || ']*[-*+][' || v_space || ']|^[' || v_space || ']*[0-9]+\.[' || v_space || ']') then
      return false;
    end if;
  end loop;
  return true;
end
$$;
revoke all on function legal.utf16_length (text), legal.href_valid (text), legal.markdown_valid (text) from public, anon, authenticated, service_role;
grant execute on function legal.utf16_length (text), legal.href_valid (text), legal.markdown_valid (text) to app_api_owner;
comment on function legal.markdown_valid (text) is 'Pure restricted-Markdown write guard matching the strict public legal reader and the shared parity corpus; no HTML, images, fences, unsupported headings/lists or unsafe links.';
comment on function legal.href_valid (text) is 'Canonical HTTPS authority or single-slash site path for legal links. ASCII DNS/canonical IP literals, bounded port, no credentials/control/backslash. Does not normalize implicit browser URL repair forms.';
create function legal.prepare_document ()
  returns trigger
  language plpgsql
  set search_path = ''
  as $$
declare
  v_space constant text := E' \t\n\v\f\r' || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
  if not legal.markdown_valid(new.zh_body) or not legal.markdown_valid(new.en_body) then
    perform
      common.fail ('INVALID_REQUEST', 'INVALID_LEGAL_BODY');
  end if;
  if new.zh_title is null or new.en_title is null or length(btrim(new.zh_title, v_space)) = 0 or length(btrim(new.en_title, v_space)) = 0
    or legal.utf16_length(new.zh_title) > 500 or legal.utf16_length(new.en_title) > 500
    or (new.recipient_name is not null and (length(btrim(new.recipient_name, v_space)) = 0 or legal.utf16_length(new.recipient_name) > 500))
    or new.effective_date is null or new.effective_date < date '0001-01-01' or new.effective_date > date '9999-12-31' then
    perform
      common.fail ('INVALID_REQUEST', 'INVALID_LEGAL_DOCUMENT_METADATA');
  end if;
  new.content_digest = common.digest(jsonb_build_array(new.kind, new.zh_title, new.en_title, new.zh_body, new.en_body, new.effective_date, new.recipient_name));
  return new;
end
$$;
create trigger prepare_document
  before insert or update on legal.documents for each row
  execute function legal.prepare_document ();
create function legal.document_json (p_audit bigint)
  returns jsonb
  language sql
  stable
  set search_path = ''
  as $$
  select
    common.api_json (jsonb_build_object('document_id', h.id, 'external_id', h.external_id, 'kind', h.kind, 'zh_title', h.zh_title, 'en_title', h.en_title, 'zh_body', h.zh_body, 'en_body', h.en_body, 'effective_date', h.effective_date, 'content_digest', h.content_digest, 'enabled', h.enabled, 'revision', h.revision, 'document_audit_id', h.audit_id, 'recipient_name', h.recipient_name))
  from
    audit.documents h
  where
    h.audit_id = p_audit
$$;
create function legal.accept_one (p_user uuid, p_document bigint, p_audit bigint, p_kind text)
  returns bigint
  language plpgsql
  set search_path = ''
  as $$
declare
  d legal.documents;
  h audit.documents;
  a legal.acceptances;
  v bigint;
begin
  select
    *
  into
    d
  from
    legal.documents
  where
    id = p_document for share;
  select
    *
  into
    h
  from
    audit.documents
  where
    audit_id = p_audit
    and id = p_document;
  if d.id is null or h.audit_id is null or d.kind <> p_kind or not d.enabled or not h.enabled or d.content_digest <> h.content_digest then
    perform
      common.fail ('CONFLICT', 'LEGAL_TARGET_CHANGED');
  end if;
  select
    *
  into
    a
  from
    legal.acceptances
  where
    owner_auth_user_id = p_user
    and document_id = p_document
  for update;
  if a.id is not null and a.document_audit_id = p_audit then
    select
      audit_id
    into
      v
    from
      audit.acceptances
    where
      id = a.id
    order by
      audit_id desc
    limit 1;
    return v;
  end if;
  insert into legal.acceptances (owner_auth_user_id, document_id, document_audit_id)
    values (p_user, p_document, p_audit)
  on conflict (owner_auth_user_id, document_id)
    do update set
      document_audit_id = excluded.document_audit_id,
      time_accepted = common.now()
    returning
      *
    into
      a;
  select
    audit_id
  into
    v
  from
    audit.acceptances
  where
    id = a.id
  order by
    audit_id desc
  limit 1;
  return v;
end
$$;
create function legal.acceptance_for (p_user uuid, p_document bigint, p_target_audit bigint default null)
  returns bigint
  language sql
  stable
  set search_path = ''
  as $$
  select
    h.audit_id
  from
    legal.acceptances a
    join audit.acceptances h on h.id = a.id
      and h.document_audit_id = a.document_audit_id
    join audit.documents accepted on accepted.audit_id = a.document_audit_id
    join legal.documents current on current.id = a.document_id
    left join audit.documents target on target.audit_id = p_target_audit
      and target.id = current.id
  where
    a.owner_auth_user_id = p_user
    and a.document_id = p_document
    and current.enabled
    and accepted.enabled
    and accepted.content_digest = current.content_digest
    and (p_target_audit is null
      or (target.enabled
        and target.content_digest = current.content_digest))
  order by
    h.audit_id desc
  limit 1
$$;
create function public.legal_current ()
  returns jsonb
  language sql
  stable
  security definer
  set search_path = ''
  as $$
  select
    jsonb_build_object('documents', coalesce(jsonb_agg(legal.document_json (document_audit_id)
        order by id), '[]'))
  from
    legal.documents
  where
    enabled
$$;
create function public.legal_document_read (p_input jsonb)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = ''
  as $$
declare
  a bigint;
begin
  select
    audit_id
  into
    a
  from
    audit.documents
  where
    audit_id = (p_input ->> 'document_audit_id')::bigint
    and external_id = p_input ->> 'external_id'
    and content_digest = p_input ->> 'content_digest'
    and enabled;
  if a is null then
    perform
      common.fail ('NOT_FOUND', 'LEGAL_DOCUMENT_NOT_FOUND');
  end if;
  return legal.document_json (a);
end
$$;
create function public.legal_accept_document (p_input jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  u uuid;
  a bigint;
begin
  perform
    common.guard (p_input);
  u = common.client_user (p_input);
  perform
    1
  from
    ai.runtime_control
  where
    id = 1
  for update;
  perform
    common.audit_context (null, u, 'Explicit ordinary terms acceptance');
  a = legal.accept_one (u, (p_input ->> 'document_id')::bigint, (p_input ->> 'document_audit_id')::bigint, 'TERMS');
  return jsonb_build_object('accepted', true, 'acceptance_audit_id', a::text);
end
$$;
create function public.legal_accept_ai (p_input jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  u uuid;
  c bigint;
  p bigint;
begin
  perform
    common.guard (p_input);
  u = common.client_user (p_input);
  perform
    1
  from
    ai.runtime_control
  where
    id = 1
  for update;
  perform
    common.audit_context (null, u, 'Explicit common and selected recipient consent');
  c = legal.accept_one (u, (p_input #>> '{common,document_id}')::bigint, (p_input #>> '{common,document_audit_id}')::bigint, 'AI_COMMON');
  p = legal.accept_one (u, (p_input #>> '{provider,document_id}')::bigint, (p_input #>> '{provider,document_audit_id}')::bigint, 'AI_PROVIDER');
  return jsonb_build_object('accepted', true, 'common_acceptance_audit_id', c::text, 'provider_acceptance_audit_id', p::text);
end
$$;
create policy acceptance_owner on legal.acceptances to authenticated
  using (owner_auth_user_id = (
    select
      auth.uid ()));
create policy accepted_document_read on audit.documents to authenticated
  using (exists (
    select
      1
    from
      legal.acceptances a
    where
      a.document_audit_id = audit_id
      and a.owner_auth_user_id = (
        select
          auth.uid ())));
grant select (document_id, document_audit_id, owner_auth_user_id) on legal.acceptances to authenticated;
grant select (audit_id, content_digest) on audit.documents to authenticated;
create view public.legal_my_acceptances with ( security_invoker = true
) as
select
  a.document_id::text as document_id,
  a.document_audit_id::text as document_audit_id,
  d.content_digest
from
  legal.acceptances a
  join audit.documents d on d.audit_id = a.document_audit_id
where
  a.owner_auth_user_id = (
    select
      auth.uid (
));
grant select on public.legal_my_acceptances to authenticated;
commit;
