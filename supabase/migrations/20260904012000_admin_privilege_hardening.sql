begin;

-- PostgreSQL grants EXECUTE on newly-created functions to PUBLIC unless it is
-- explicitly revoked. This owner-only cutover primitive must never be exposed
-- through PostgREST, including before or after authority adoption.
revoke all on function public.admin_cutover_authority_v1(
  uuid, uuid[], bigint, bigint, text
) from public, anon, authenticated, service_role;

commit;
