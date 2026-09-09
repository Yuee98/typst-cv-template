# Admin setup

Applies after `20260909110000_simplify_admin_bootstrap.sql` and the matching web build are deployed. Bootstrap creates the first administrator and environment label; it does not enable configuration writes or change AI routing, gates, legal bundles or quotas.

The existing web server hosts `/zh/admin`, `/en/admin` and the protected API. Static exports exclude Admin routes and its client entry. Set `ADMIN_ENVIRONMENT` to `local`, `preview` or `production`; Vercel's `VERCEL_ENV` must agree. The existing Supabase URL and publishable key remain connection settings in the deployment. They are not copied into the database. There is no bootstrap CLI, environment-file export or project-ref input.

Create and confirm an ordinary Auth user first. Open **SQL Editor in the intended Supabase project**, verify the project and environment, and execute as `postgres`, replacing the UUID:

```sql
begin;
select public.admin_bootstrap_v2(
  p_user_id := '<existing-confirmed-auth-user-uuid>'::uuid,
  p_environment := 'preview',
  p_reason := 'Initial administrator approved by project owner'
);
select environment, control_plane_mode, revision
from public.admin_environment;
select user_id, revoked_at, revision from public.admin_principals;
commit;
```

Use `production` for the Production database and `local` for the local stack. Successful readback shows your UUID with `revoked_at = null` and `control_plane_mode = legacy`. Bootstrap requires a confirmed, available, non-anonymous account and refuses any prior membership. The operation is atomic and audited. Only a direct DB-owner session may execute it; anonymous, authenticated and service-role API callers cannot bootstrap. Account recovery remains an explicit DB-owner operation, with no automatic takeover.

Sign in at `/zh/admin` or `/en/admin` with that account. Enroll TOTP under Security before high-risk operations. Configuration writes remain unavailable until the separate owner authority cutover; read-only Admin access does not require AI to be enabled.

Every API request verifies the bearer with Supabase Auth and forwards the same bearer to the database. The database checks its own user/session, active membership, account availability and environment label. Revocation, banning or session deletion invalidates access even with an unexpired JWT. Preview and Production must use their intended Supabase connections; there is no additional persisted project identity to detect two environments accidentally configured to the same backend.

Upgrades preserve existing membership, environment/control revisions, gates, pointers and historical audit/report rows. Old `project_ref` and `auth_issuer` values remain historical metadata; new bootstrap leaves them NULL. Existing business RPCs retain an ignored `p_project_ref` compatibility argument; the web sends NULL. Existing write-enabled databases verify their predecessor authority receipt before migration and receive one successor receipt without repeating cutover. A failed predecessor verification aborts the migration. Uninitialized and read-only databases are not promoted.

The web and migration introduce successor context/report/receipt payload versions together. Old Admin or v2 execution builds can fail closed during a deployment mismatch and are not rollback targets after this migration; use the matching build. Pre-bootstrap and pre-cutover v1 AI traffic remains supported. Historical reports retain their hashes and formats; generate fresh validation/readback evidence for new publication or reopen operations. Already committed operations retain their original idempotent replay result.
