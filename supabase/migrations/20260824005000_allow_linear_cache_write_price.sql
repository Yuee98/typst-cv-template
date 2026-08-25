-- Allow linear-token price versions to carry one explicit cache-write price.
--
-- Existing DeepSeek/legacy price versions remain valid with the original three
-- required components. MiMo can represent its currently-free cache write as an
-- explicit zero without pretending that wire usage reports a write-token
-- bucket, and later linear profiles may carry a non-zero write price.

create or replace function public.assert_ai_price_structure_v1(
  p_price_version_id uuid
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_calculator_kind text;
  v_parameters jsonb;
  v_component_count bigint;
  v_required_component_count bigint;
  v_cache_write_component_count bigint;
  v_unsupported_component_count bigint;
begin
  if p_price_version_id is null then
    raise exception 'price structure requires a non-null price version id'
      using errcode = '23514';
  end if;

  select calculator_kind, parameters
  into v_calculator_kind, v_parameters
  from public.ai_price_versions
  where id = p_price_version_id;

  if not found then
    raise exception 'price structure parent does not exist'
      using errcode = '23503';
  end if;

  if v_calculator_kind is distinct from 'linear_token_v1'
     or v_parameters is distinct from '{}'::jsonb then
    raise exception 'unsupported or malformed price calculator structure'
      using errcode = '23514';
  end if;

  select
    count(*),
    count(*) filter (
      where component in ('input_standard', 'input_cache_read', 'output')
    ),
    count(*) filter (where component = 'input_cache_write'),
    count(*) filter (
      where component not in (
        'input_standard',
        'input_cache_read',
        'input_cache_write',
        'output'
      )
    )
  into
    v_component_count,
    v_required_component_count,
    v_cache_write_component_count,
    v_unsupported_component_count
  from public.ai_price_components
  where price_version_id = p_price_version_id;

  if v_required_component_count <> 3
     or v_cache_write_component_count not in (0, 1)
     or v_unsupported_component_count <> 0
     or v_component_count < 3
     or v_component_count > 4
     or v_component_count <>
       v_required_component_count + v_cache_write_component_count then
    raise exception 'linear_token_v1 requires input_standard, input_cache_read, and output, with at most one optional input_cache_write component'
      using errcode = '23514';
  end if;
end;
$$;

revoke execute on function public.assert_ai_price_structure_v1(uuid)
  from public, anon, authenticated, service_role;
