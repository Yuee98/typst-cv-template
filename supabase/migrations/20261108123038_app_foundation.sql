begin;
set local search_path = '';
-- Sole cv_app_db_2 baseline. Apply only after an explicitly authorized application reset.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;
create extension if not exists pg_cron;
do $$
begin
  if not exists (
    select
      1
    from
      pg_catalog.pg_roles
    where
      rolname = 'app_api_owner') then
  create role app_api_owner nologin noinherit nobypassrls;
end if;
  execute format('grant app_api_owner to %I with set true, inherit false', current_user);
end
$$;
create schema common;
create schema admin;
create schema ai;
create schema legal;
create schema cv;
create schema audit;
revoke create on schema public from public, anon, authenticated, service_role;
revoke all on schema common, admin, ai, legal, cv, audit from public, anon, authenticated, service_role;
alter default privileges revoke execute on functions from public;
alter default privileges in schema common, admin, ai, legal, cv, audit, public revoke all on tables from public, anon, authenticated, service_role;
create or replace function common.generate_external_id (p_prefix TEXT, p_suffix_length INTEGER default 12)
  returns TEXT
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  v_alphabet CONSTANT TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_bytes BYTEA;
  v_suffix TEXT := '';
begin
  if p_prefix is null or p_prefix collate pg_catalog."C" !~ '^[a-z][a-z0-9]*_$' then
    raise exception
      using ERRCODE = '22023', MESSAGE = 'Prefix must be lowercase letters/digits, start with a letter and end with one underscore';
  end if;
  if p_suffix_length is null or p_suffix_length < 12 or p_suffix_length > 1024 then
    raise exception
      using ERRCODE = '22023', MESSAGE = 'Suffix length must be between 12 and 1024';
  end if;
  v_bytes := extensions.gen_random_bytes(p_suffix_length);
  for v_index in 0..p_suffix_length - 1 loop
    v_suffix := v_suffix || pg_catalog.substr(v_alphabet, (pg_catalog.get_byte(v_bytes, v_index) % 32) + 1, 1);
  end loop;
  return p_prefix || v_suffix;
end;
$$;
create or replace function common.is_valid_external_id (p_id TEXT, p_prefix TEXT, p_suffix_length INTEGER)
  returns BOOLEAN
  language plpgsql
  immutable
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  v_suffix TEXT;
begin
  -- 故意不使用 STRICT：NULL 输入返回 FALSE，不让 CHECK 因 UNKNOWN 放过无效值。
  if p_id is null or p_prefix is null or p_suffix_length is null then
    return false;
  end if;
  if p_prefix collate pg_catalog."C" !~ '^[a-z][a-z0-9]*_$' or p_suffix_length < 12 or p_suffix_length > 1024 then
    return false;
  end if;
  if pg_catalog.left (p_id, pg_catalog.char_length(p_prefix))
    collate pg_catalog."C" <> p_prefix collate pg_catalog."C" then
    return false;
  end if;
  v_suffix := pg_catalog.substr(p_id, pg_catalog.char_length(p_prefix) + 1);
  return pg_catalog.char_length(v_suffix) = p_suffix_length
    and v_suffix collate pg_catalog."C" ~ '^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]+$';
end;
$$;
comment on function common.generate_external_id (TEXT, INTEGER) is '生成类型前缀加随机 Crockford Base32 后缀；默认 12 位，唯一性由使用方具名 UNIQUE 约束保证。';
comment on function common.is_valid_external_id (TEXT, TEXT, INTEGER) is '严格验证外部 ID 的前缀、长度及大写 Base32 字符集；NULL 或无效参数返回 false。';
revoke all on function common.generate_external_id (TEXT, INTEGER) from PUBLIC;
revoke all on function common.is_valid_external_id (TEXT, TEXT, INTEGER) from PUBLIC;
-- 按项目调用路径授予必要的 schema USAGE / 函数 EXECUTE；不批量授权 anon/authenticated。
-- 由普通角色执行 DEFAULT 或 CHECK 时，也要验证该路径所需的函数权限。
-- STABLE keeps intentional errors at execution time; IMMUTABLE would permit
-- planner constant-folding of an untaken validation branch.
create function common.fail (p_code text, p_reason text default null)
  returns void
  language plpgsql
  stable
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
  begin
    raise exception
      using errcode = 'P0001', message = p_code, detail = coalesce(p_reason, p_code);
  end
$$;
create function common.digest (p_value jsonb)
  returns text
  language sql
  immutable
  security invoker
  set search_path = ''
  as $$
  select
    pg_catalog.encode(extensions.digest(p_value::text, 'sha256'), 'hex')
$$;
create function common.required (p_input jsonb, p_fields text[])
  returns void
  language plpgsql
  stable
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  v_key text;
begin
  if pg_catalog.jsonb_typeof(p_input) is distinct from 'object' then
    perform
      common.fail ('INVALID_REQUEST', 'OBJECT_REQUIRED');
  end if;
  foreach v_key in array p_fields loop
    if not (p_input ? v_key) or p_input -> v_key = 'null'::jsonb then
      perform
        common.fail ('INVALID_REQUEST', 'MISSING_' || v_key);
    end if;
  end loop;
end
$$;
create function common.assert_api_owner_safe ()
  returns void
  language plpgsql
  stable
  security invoker
  set search_path = ''
  as $$
declare
  v_owner oid;
  v_migration_owner oid;
begin
  select
    oid
  into
    v_owner
  from
    pg_catalog.pg_roles
  where
    rolname = 'app_api_owner';
  select
    oid
  into
    v_migration_owner
  from
    pg_catalog.pg_roles
  where
    rolname = current_user;
  if v_owner is null or exists (
    select
      1
    from
      pg_catalog.pg_roles
    where
      oid = v_owner and (rolcanlogin or rolinherit or rolbypassrls or rolsuper or rolcreaterole or rolcreatedb or rolreplication)) or exists (
select
  1
from
  pg_catalog.pg_auth_members
where
  member = v_owner) or exists (
select
  1
from
  pg_catalog.pg_auth_members
where
  roleid = v_owner and member <> v_migration_owner) or exists (
select
  1
from
  pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where
  n.nspname in ('auth', 'storage') and c.relkind in ('r', 'p', 'v', 'm', 'f') and (pg_catalog.has_table_privilege(v_owner, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') or pg_catalog.has_any_column_privilege(v_owner, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))) then
    raise exception 'Unsafe existing app_api_owner role'
      using errcode = '42501';
  end if;
end;
$$;
revoke all on function common.assert_api_owner_safe () from public, anon, authenticated, service_role, app_api_owner;
select
  common.assert_api_owner_safe ();
commit;
