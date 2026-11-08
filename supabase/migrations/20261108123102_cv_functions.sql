begin;
set local search_path = '';
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
drop policy api_owner on cv.documents;
create policy cv_owner on cv.documents to authenticated, app_api_owner
  using (owner_auth_user_id = (
    select
      auth.uid ()))
  with check (owner_auth_user_id = (
    select
      auth.uid ()));
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
revoke all on all functions in schema cv from public, anon, authenticated, service_role;
grant execute on all functions in schema cv to app_api_owner;
grant create on schema public to app_api_owner;
revoke all on function public.cv_document_create (jsonb) from public, anon, authenticated, service_role;
grant execute on function public.cv_document_create (jsonb) to authenticated;
alter function public.cv_document_create (jsonb) owner to app_api_owner;
revoke all on function public.cv_document_update (jsonb) from public, anon, authenticated, service_role;
grant execute on function public.cv_document_update (jsonb) to authenticated;
alter function public.cv_document_update (jsonb) owner to app_api_owner;
revoke all on function public.cv_document_convert (jsonb) from public, anon, authenticated, service_role;
grant execute on function public.cv_document_convert (jsonb) to authenticated;
alter function public.cv_document_convert (jsonb) owner to app_api_owner;
revoke all on function public.cv_document_rename (jsonb) from public, anon, authenticated, service_role;
grant execute on function public.cv_document_rename (jsonb) to authenticated;
alter function public.cv_document_rename (jsonb) owner to app_api_owner;
revoke all on function public.cv_document_delete (jsonb) from public, anon, authenticated, service_role;
grant execute on function public.cv_document_delete (jsonb) to authenticated;
alter function public.cv_document_delete (jsonb) owner to app_api_owner;
revoke create on schema public from app_api_owner;
commit;
