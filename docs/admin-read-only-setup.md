# Read-only Admin setup

This entry applies only after `20260903000000_admin_read_foundation.sql` is installed. It does not replace the existing AI operator runbook or enable Admin writes. No AI route, gate, legal bundle or quota is changed by the migration.

The same `web` server deployment hosts `/zh/admin`, `/en/admin` and the protected API. Static exports contain neither Admin routes nor its client entry. Set `ADMIN_ENVIRONMENT` explicitly to `local`, `preview` or `production`; the server compares the deployment and Supabase project to the owner-initialized DB identity. Vercel deployments additionally require `VERCEL_ENV` to agree. Existing public Supabase URL/publishable key settings remain in use. Browser and server Admin reads use the signed-in user's bearer, never the service-role key.

Create and confirm an ordinary Auth user first. Then generate a complete owner-executed SQL script from the deployment's existing configuration. The helper derives `project_ref` and `auth_issuer` from `NEXT_PUBLIC_SUPABASE_URL`; you do not enter either value or any API key. The SQL still calls the existing DB-owner-only `admin_bootstrap_v1` function.

For the canonical Preview deployment, run from `web/` with the Vercel CLI signed in and linked to this web project (`vercel link` if it is not linked yet):

```sh
vercel env run -e preview --git-branch main -- pnpm --silent admin:bootstrap --user-id <existing-confirmed-auth-user-uuid> --environment preview --reason "Initialize project owner" --out ../tmp/admin-bootstrap-preview.sql
```

[Vercel env run](https://vercel.com/docs/cli/env#running-commands-with-environment-variables) injects the linked project's variables without writing an environment file. This includes the Supabase app's synchronized values. The `main` branch selector is intentional: do not pick a feature branch's Supabase environment when initializing the canonical Preview database. Production uses `-e production`, `--environment production` and its own output filename instead.

If the environment has already been exported to a file, select it explicitly (paths are relative to `web/`):

```sh
pnpm --silent admin:bootstrap --env-file .env.preview.local --user-id <existing-confirmed-auth-user-uuid> --environment preview --reason "Initialize project owner" --out ../tmp/admin-bootstrap-preview.sql
```

The required configuration is `ADMIN_ENVIRONMENT` and `NEXT_PUBLIC_SUPABASE_URL`. The selected environment must match `--environment`; local URLs follow the same restrictions as the Admin server. An explicit env file is the sole configuration source, so stale process values cannot fill missing fields. Without `--env-file`, only process variables are read; `.env.local` is never loaded implicitly. The helper does not use or output credentials, connect to a database, or execute SQL. `--out` creates a new file and any parent directories; it refuses to overwrite an existing file. Without `--out`, it prints SQL to stdout.

Open the generated SQL, confirm its target environment/project/URL match the Supabase project open in SQL Editor, and execute it as `postgres`. A successful readback shows your UUID with `revoked_at = null` and `control_plane_mode = legacy`. Current AI routes and gates remain unchanged. The initial Admin can sign in at `/zh/admin` or `/en/admin` and enroll TOTP in Security settings; configuration writes remain unavailable until the separate owner authority cutover.

The direct SQL form remains available for database operators and recovery documentation:

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

Local identity is `local` / `local`. The helper targets this repository's standard local Supabase stack, whose Auth issuer is `http://127.0.0.1:54321/auth/v1`, even when the client API URL uses `localhost`. A custom stack with an overridden Auth issuer must use the direct owner SQL form with its actual issuer; do not use the helper for that configuration. The generated readback includes the stored issuer. Bootstrap is executable only through a direct database-owner connection and refuses any prior membership. It is not exposed as a service-role or browser bootstrap. Recovery after a lost account remains a direct, separately reviewed DB operator action; there is no automatic takeover.

Sign in at the Admin page with the existing email/password or GitHub account. Reads require a confirmed account, current active membership and live session. Revoking membership or banning the Auth account invalidates reads even with an unexpired JWT. Membership prevents cascading Auth deletion. This release exposes Overview, Users, Profiles, Pricing, Routing Policies and Audit as read-only. AI being disabled does not disable Admin access.

The initial audit feed and config feeds retain the existing database retention. Pagination is by immutable UUID; time-ordered audit and analytics are later packages. Credentials themselves, Auth internals and resume contents are not returned. Audit retains manual bootstrap events independently of subsequent test-user or Auth account cleanup.
