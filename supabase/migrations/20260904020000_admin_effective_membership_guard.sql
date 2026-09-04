-- A stale or disabled Auth account is not an effective Admin and must remain
-- revocable. Keep the original RPC identity so deployed Admin clients gain the
-- corrected last-Admin semantics without a compatibility flag.
begin;

create or replace function public.admin_set_membership_v1(
  p_environment text,
  p_project_ref text,
  p_target_user_id uuid,
  p_enabled boolean,
  p_expected_revision bigint,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_payload jsonb;
  v_replay jsonb;
  v_target public.admin_principals%rowtype;
  v_audit uuid;
  v_result jsonb;
begin
  v_actor:=public.admin_assert_write_actor_v1(p_environment,p_project_ref,false);
  perform public.admin_assert_jwt_control_mode_v1();
  v_payload:=jsonb_build_object('targetUserId',p_target_user_id,'enabled',p_enabled,
    'expectedRevision',p_expected_revision,'reason',p_reason);
  v_replay:=public.admin_lock_committed_operation_v1(
    v_actor,'admin_membership_set',p_idempotency_key,v_payload);
  if (v_replay->>'found')::boolean then
    return public.admin_replayed_operation_v1(v_replay,'admin_membership_set',p_idempotency_key);
  end if;
  if not public.admin_has_recent_totp_v1(v_actor) then
    raise exception 'STEP_UP_REQUIRED' using errcode='42501';
  end if;
  perform public.admin_assert_reason_v1(p_reason);
  if p_target_user_id is null or p_enabled is null or p_expected_revision is null
     or p_expected_revision < 0 then
    raise exception 'INVALID_REQUEST' using errcode='22023';
  end if;

  -- The FK keeps a principal's Auth identity present even when the account is
  -- soft-deleted. Lock that identity for both branches, but require it to be
  -- usable only when granting authority.
  perform 1 from auth.users where id=p_target_user_id for update;
  if not found then
    raise exception 'TARGET_USER_UNAVAILABLE' using errcode='23514';
  end if;
  if p_enabled and not exists(
    select 1 from auth.users where id=p_target_user_id
      and deleted_at is null and not coalesce(is_anonymous,false)
      and (banned_until is null or banned_until<=clock_timestamp())
      and (email_confirmed_at is not null or phone_confirmed_at is not null)
  ) then
    raise exception 'TARGET_USER_UNAVAILABLE' using errcode='23514';
  end if;

  select * into v_target from public.admin_principals
  where user_id=p_target_user_id for update;
  if p_enabled then
    if not found then
      if p_expected_revision<>0 then raise exception 'CONFLICT' using errcode='40001'; end if;
      insert into public.admin_principals(user_id)
      values(p_target_user_id) returning * into v_target;
    else
      if v_target.revision is distinct from p_expected_revision
         or v_target.revoked_at is null then
        raise exception 'CONFLICT' using errcode='40001';
      end if;
      update public.admin_principals set enabled_at=clock_timestamp(),revoked_at=null,
        revision=revision+1 where user_id=p_target_user_id returning * into v_target;
    end if;
  else
    if not found or v_target.revision is distinct from p_expected_revision
       or v_target.revoked_at is not null then
      raise exception 'CONFLICT' using errcode='40001';
    end if;
    if not exists(
      select 1
      from public.admin_principals as principal
      join auth.users as account on account.id=principal.user_id
      where principal.revoked_at is null
        and principal.user_id<>p_target_user_id
        and account.deleted_at is null
        and not coalesce(account.is_anonymous,false)
        and (account.banned_until is null or account.banned_until<=clock_timestamp())
        and (account.email_confirmed_at is not null or account.phone_confirmed_at is not null)
    ) then
      raise exception 'LAST_ADMIN' using errcode='23514';
    end if;
    update public.admin_principals set revoked_at=clock_timestamp(),revision=revision+1
    where user_id=p_target_user_id returning * into v_target;
  end if;
  insert into public.admin_audit_events(operation,actor,target_id,reason)
  values(case when p_enabled then 'admin_grant' else 'admin_revoke' end,
    v_actor::text,p_target_user_id,p_reason) returning id into v_audit;
  v_result:=jsonb_build_object('schemaVersion','admin_membership_result_v1',
    'userId',v_target.user_id,'enabled',v_target.revoked_at is null,
    'revision',v_target.revision::text);
  return public.admin_commit_operation_v1(v_actor,'admin_membership_set',
    p_idempotency_key,v_payload,v_result,v_audit);
end;
$$;

revoke all on function public.admin_set_membership_v1(
  text,text,uuid,boolean,bigint,text,uuid
) from public,anon,authenticated,service_role;
grant execute on function public.admin_set_membership_v1(
  text,text,uuid,boolean,bigint,text,uuid
) to authenticated;

commit;
