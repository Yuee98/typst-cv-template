# Read-only Admin setup

This entry applies only after `20260903000000_admin_read_foundation.sql` is installed. It does not replace the existing AI operator runbook or enable Admin writes. No AI route, gate, legal bundle or quota is changed by the migration.

The same `web` server deployment hosts `/zh/admin`, `/en/admin` and the protected API. Static exports contain neither Admin routes nor its client entry. Set `ADMIN_ENVIRONMENT` explicitly to `local`, `preview` or `production`; the server compares the deployment and Supabase project to the owner-initialized DB identity. Vercel deployments additionally require `VERCEL_ENV` to agree. Existing public Supabase URL/publishable key settings remain in use. Browser and server Admin reads use the signed-in user's bearer, never the service-role key.

Create and confirm an ordinary Auth user first. Then an authorized database operator binds that existing UUID directly in the intended database. Replace the example values after checking the environment identity; do not execute an example against an unverified hosted project.

```sql
begin;
select public.admin_bootstrap_v1(
  p_user_id := '<existing-confirmed-auth-user-uuid>'::uuid,
  p_environment := 'preview',
  p_project_ref := '<preview-supabase-project-ref>',
  p_auth_issuer := 'https://<preview-supabase-project-ref>.supabase.co/auth/v1',
  p_reason := 'Initial administrator approved by project owner'
);
select environment, project_ref, control_plane_mode, revision
from public.admin_environment;
select user_id, revoked_at, revision from public.admin_principals;
commit;
```

Local identity is `local` / `local` and its exact Auth issuer (normally `http://127.0.0.1:54321/auth/v1`). Bootstrap is executable only through a direct database-owner connection and refuses any prior membership. It is not exposed as a service-role or browser bootstrap. Recovery after a lost account remains a direct, separately reviewed DB operator action; there is no automatic takeover.

Sign in at the Admin page with the existing email/password or GitHub account. Reads require a confirmed account, current active membership and live session. Revoking membership or banning the Auth account invalidates reads even with an unexpired JWT. Membership prevents cascading Auth deletion. This release exposes Overview, Users, Profiles, Pricing, Routing Policies and Audit as read-only. AI being disabled does not disable Admin access.

The initial audit feed and config feeds retain the existing database retention. Pagination is by immutable UUID; time-ordered audit and analytics are later packages. Credentials themselves, Auth internals and resume contents are not returned. Audit retains manual bootstrap events independently of subsequent test-user or Auth account cleanup.
