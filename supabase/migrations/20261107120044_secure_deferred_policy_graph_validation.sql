-- Deferred triggers run after a definer RPC returns and the transaction's API role is restored.
-- Keep private graph reads under the same restricted application owner at COMMIT/SET CONSTRAINTS.
begin;
alter function ai.validate_policy_graph() security definer;
alter function ai.validate_policy_graph() set search_path='';
revoke all on function ai.validate_policy_graph() from public,anon,authenticated,service_role;
comment on function ai.validate_policy_graph() is 'Deferred complete_policy invariant only. SECURITY DEFINER owner app_api_owner (NOLOGIN/NOINHERIT/NOBYPASSRLS), empty search_path; reads private routing/options at COMMIT after the authenticated caller role is restored. No API EXECUTE grants and no direct writes or caller-supplied SQL. Trigger receives the inserted policy version and returns no data.';
-- Required only while transferring ownership; ordinary API roles receive no schema/table privileges.
grant create on schema ai to app_api_owner;
alter function ai.validate_policy_graph() owner to app_api_owner;
revoke create on schema ai from app_api_owner;
commit;
