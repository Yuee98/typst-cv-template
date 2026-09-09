# Admin setup

Applies after `20260910000000_admin_drafts_before_cutover.sql` and the matching web build are deployed. Bootstrap creates the first administrator and environment label. Administrators can immediately prepare configuration drafts while AI continues using its current route. Bootstrap does not change AI routing, gates, legal bundles or quotas.

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

Sign in at `/zh/admin` or `/en/admin` with that account. You can edit Provider defaults and create Profile, Price and Routing drafts without disabling AI, configuring future credentials or performing authority cutover. **Create version** saves an immutable draft; it does not change the running configuration. Existing references, supported adapters and input constraints still apply. See [draft preparation](admin-draft-preparation.md) for the boundary.

Enroll TOTP under Security before high-risk operations. Actual activation, route changes, AI controls and administrator membership still use the separate owner authority cutover and current validation workflow. Read access and draft preparation do not depend on whether AI is enabled.

Every API request verifies the bearer with Supabase Auth and forwards the same bearer to the database. The database checks its own user/session, active membership, account availability and environment label. Revocation, banning or session deletion invalidates access even with an unexpired JWT. Preview and Production must use their intended Supabase connections; there is no additional persisted project identity to detect two environments accidentally configured to the same backend.

Upgrades preserve existing membership, environment/control revisions, gates, pointers and historical audit/report rows. Old `project_ref` and `auth_issuer` values remain historical metadata; new bootstrap leaves them NULL. Existing business RPCs retain an ignored `p_project_ref` compatibility argument; the web sends NULL. The earlier bootstrap simplification verifies and advances an existing runtime authority receipt. The subsequent draft-preparation migration changes no runtime-tracked function or grant and leaves those receipts byte-identical. Uninitialized and legacy databases are not promoted to runtime-write authority.

Use the matching web build: draft preparation introduces `admin_context_v3` with separate `drafts` and `writes` capabilities. An old Admin build fails closed on this new context rather than misinterpreting permissions; this migration does not change the AI execution protocol. Pre-bootstrap and pre-cutover v1 AI traffic remains supported. Historical reports retain their hashes and formats; generate fresh validation/readback evidence for new publication or reopen operations. Already committed operations retain their original idempotent replay result.
