import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

export const E2E_USERS = {
  admin: {
    email: "admin-e2e-admin@example.test",
    password: "AdminE2E!local-2026",
  },
  ordinary: {
    email: "admin-e2e-ordinary@example.test",
    password: "OrdinaryE2E!local-2026",
  },
};

const DB_CONTAINER = "supabase_db_typst-cv-template";

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function uuidArray(ids) {
  return `array[${ids.map((id) => `${sql(id)}::uuid`).join(",")}]`;
}

function ownerSql(statement) {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      DB_CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "--set",
      "ON_ERROR_STOP=1",
      "--no-psqlrc",
    ],
    { input: statement, encoding: "utf8", timeout: 60_000 },
  );
  if (result.status !== 0) {
    throw new Error(`owner SQL failed: ${result.stderr || result.stdout}`);
  }
}

function removeFixtureRows(ids) {
  if (ids.length === 0) return;
  const users = uuidArray(ids);
  const actorIds = ids.map(sql).join(",");
  // Product audit/operation rows are append-only. This owner-only test
  // cleanup removes only rows tied to fixed synthetic user IDs so repeated
  // local runs leave no login, MFA seed, principal or operation behind.
  ownerSql(`
    begin;
    alter table public.admin_committed_operations
      disable trigger admin_committed_operation_append_only;
    alter table public.admin_audit_events
      disable trigger admin_audit_append_only;
    delete from public.admin_committed_operations
      where actor_user_id=any(${users});
    delete from public.admin_principals where user_id=any(${users});
    delete from public.admin_environment
      where id=true and environment='local' and exists(
        select 1 from public.admin_audit_events
        where operation='admin_bootstrap' and target_id=any(${users})
      );
    delete from public.admin_audit_events
      where target_id=any(${users}) or actor in (${actorIds});
    alter table public.admin_audit_events
      enable trigger admin_audit_append_only;
    alter table public.admin_committed_operations
      enable trigger admin_committed_operation_append_only;
    commit;
  `);
}

function serviceClient(url, secretKey) {
  if (!url || !secretKey) throw new Error("Admin E2E credentials are missing");
  return createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function fixtureUsers(service) {
  const { data, error } = await service.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  return data.users.filter((user) => user.email?.startsWith("admin-e2e-"));
}

async function removeFixtureUsers(service) {
  const users = await fixtureUsers(service);
  removeFixtureRows(users.map((user) => user.id));
  for (const user of users) {
    const { error } = await service.auth.admin.deleteUser(user.id);
    if (error) throw error;
  }
}

export async function setupAdminE2e({ url, secretKey }) {
  const service = serviceClient(url, secretKey);
  await removeFixtureUsers(service);
  const created = {};
  try {
    for (const [name, spec] of Object.entries(E2E_USERS)) {
      const { data, error } = await service.auth.admin.createUser({
        email: spec.email,
        password: spec.password,
        email_confirm: true,
      });
      if (error || !data.user) {
        throw error ?? new Error(`failed to create ${name}`);
      }
      created[name] = { ...spec, id: data.user.id };
    }
    ownerSql(`
      select public.admin_bootstrap_v1(
        ${sql(created.admin.id)},'local','local',
        ${sql(new URL(url).origin + "/auth/v1")},
        'admin UI E2E bootstrap'
      );
      -- The authority-cutover algorithm has its own DB suite. This fixture
      -- enables the cut-over JWT path solely to exercise the real UI, Auth
      -- session, recent TOTP and typed membership RPC together.
      update public.admin_environment
        set control_plane_mode='jwt_v1',revision=revision+1
        where id=true and environment='local';
    `);
  } catch (error) {
    removeFixtureRows(Object.values(created).map((user) => user.id));
    for (const user of Object.values(created)) {
      await service.auth.admin.deleteUser(user.id);
    }
    throw error;
  }
}

export async function cleanupAdminE2e({ url, secretKey }) {
  await removeFixtureUsers(serviceClient(url, secretKey));
}
