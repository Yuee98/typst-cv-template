begin;
set local search_path = '';
create function legal.prepare_document ()
  returns trigger
  language plpgsql
  set search_path = ''
  as $$
begin
  if length(btrim(new.zh_title)) = 0 or length(btrim(new.en_title)) = 0 or length(btrim(new.zh_body)) = 0 or length(btrim(new.en_body)) = 0 or length(new.zh_body) > 65536 or length(new.en_body) > 65536 or octet_length(new.zh_body) > 262144 or octet_length(new.en_body) > 262144 then
    perform
      common.fail ('INVALID_REQUEST', 'INVALID_LEGAL_BODY');
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
