-- Explicit file transaction also protects CLI versions that execute statements separately.
begin;
-- Empty-business-database baseline. Never apply over the retired schema.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;
-- pg_cron owns its platform-defined catalog/schema; do not relocate it.
create extension if not exists pg_cron;
do $$
begin
  if exists (
    select
      1
    from
      pg_catalog.pg_extension e
      join pg_catalog.pg_namespace n on n.oid = e.extnamespace
    where
      e.extname in ('pgcrypto', 'btree_gist')
      and n.nspname <> 'extensions') then
  raise exception 'pgcrypto and btree_gist must be installed in the verified extensions schema';
end if;
end
$$;
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
elsif exists (
    select
      1
    from
      pg_catalog.pg_roles
    where
      rolname = 'app_api_owner'
      and (rolcanlogin
        or rolinherit
        or rolbypassrls
        or rolsuper
        or rolcreaterole
        or rolcreatedb))
  or exists (
    select
      1
    from
      pg_catalog.pg_auth_members m
      join pg_catalog.pg_roles r on r.oid = m.roleid
    where
      r.rolname = 'app_api_owner'
      and m.member <> (
        select
          oid
        from
          pg_catalog.pg_roles
        where
          rolname = current_user)) then
    raise exception 'Unsafe existing app_api_owner role';
end if;
  execute pg_catalog.format('grant app_api_owner to %I with set true, inherit false', current_user);
end
$$;
create schema common;
create schema cv;
create schema ai;
create schema legal;
create schema admin;
create schema audit;
revoke create on schema public from public, anon, authenticated, service_role;
revoke all on schema common, cv, ai, legal, admin, audit from public, anon, authenticated, service_role;
alter default privileges revoke execute on functions from public;
alter default privileges in schema common, cv, ai, legal, admin, audit, public revoke all on tables from public, anon, authenticated, service_role;
-- 外部 ID 生成与校验函数；在项目迁移事务内适配使用。
-- 前置条件：common schema 已存在；pgcrypto 已安装在 extensions schema。
-- 用 pg_extension/pg_namespace 核实扩展位置，按实际位置调整限定名，保持 search_path 为空。
-- 更新已有函数前，核对签名、调用者、存量数据、CHECK 依赖及 EXECUTE 授权。
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
  v_index INTEGER;
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
create function common.fail (p_code text, p_reason text default null)
  returns void
  language plpgsql
  volatile
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
  immutable
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
create function common.immutable ()
  returns trigger
  language plpgsql
  volatile
  security invoker
  set search_path = ''
  as $$
  #variable_conflict use_variable
declare
  v_old jsonb;
  v_new jsonb;
begin
  v_old = pg_catalog.to_jsonb (old) - array['status', 'time_published', 'time_retired', 'time_closed', 'time_sealed', 'user_published', 'user_retired'];
  v_new = pg_catalog.to_jsonb (new) - array['status', 'time_published', 'time_retired', 'time_closed', 'time_sealed', 'user_published', 'user_retired'];
  if v_old is distinct from v_new then
    perform
      common.fail ('INVALID_REQUEST', 'IMMUTABLE_VERSION');
  end if;
  if pg_catalog.to_jsonb (old) ? 'status' and (pg_catalog.to_jsonb (old) ->> 'status' = 'RETIRED' or (pg_catalog.to_jsonb (old) ->> 'status' = 'PUBLISHED' and pg_catalog.to_jsonb (new) ->> 'status' not in ('PUBLISHED', 'RETIRED'))) then
    perform
      common.fail ('CONFLICT', 'INVALID_LIFECYCLE');
  end if;
  if (pg_catalog.to_jsonb (old) ->> 'time_closed') is not null and (pg_catalog.to_jsonb (new) ->> 'time_closed') is distinct from (pg_catalog.to_jsonb (old) ->> 'time_closed') then
    perform
      common.fail ('INVALID_REQUEST', 'IMMUTABLE_CLOSE');
  end if;
  if pg_catalog.to_jsonb (old) ->> 'time_sealed' is not null and pg_catalog.to_jsonb (new) ->> 'time_sealed' is distinct from pg_catalog.to_jsonb (old) ->> 'time_sealed' then
    perform
      common.fail ('INVALID_REQUEST', 'IMMUTABLE_SEAL');
  end if;
  return new;
end
$$;
revoke all on all functions in schema common from public, anon, authenticated, service_role;
commit;
