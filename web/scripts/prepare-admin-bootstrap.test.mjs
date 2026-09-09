import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAdminBootstrap, runAdminBootstrapCli } from "./prepare-admin-bootstrap.mjs";

const userId = "11111111-1111-4111-8111-111111111111";
const input = { userId, environment: "preview", reason: "Initialize project owner" };
const env = { ADMIN_ENVIRONMENT: "preview", NEXT_PUBLIC_SUPABASE_URL: "https://preview-project.supabase.co" };
const args = ["--user-id", userId, "--environment", "preview", "--reason", input.reason];
const directories = [];
function temporary() {
  const directory = mkdtempSync(path.join(tmpdir(), "admin-bootstrap-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("owner bootstrap SQL preparation", () => {
  it.each(["preview", "production"])("derives %s identity from the existing URL without keys", (environment) => {
    const sql = prepareAdminBootstrap({ ...input, environment }, { ...env, ADMIN_ENVIRONMENT: environment });
    expect(sql).toContain("p_project_ref := E'preview-project'");
    expect(sql).toContain("p_auth_issuer := E'https://preview-project.supabase.co/auth/v1'");
    expect(sql).toContain(`p_environment := E'${environment}'`);
    expect(sql).toContain(`p_user_id := E'${userId}'::uuid`);
    expect(sql).toContain("select public.admin_bootstrap_v1(");
    expect(sql).toContain("commit;");
  });

  it.each(["127.0.0.1", "localhost"])("uses the canonical local Auth issuer with API host %s", (host) => {
    const sql = prepareAdminBootstrap({ ...input, environment: "local" }, {
      ADMIN_ENVIRONMENT: "local", NEXT_PUBLIC_SUPABASE_URL: `http://${host}:54321/`,
    });
    expect(sql).toContain("p_project_ref := E'local'");
    expect(sql).toContain("p_auth_issuer := E'http://127.0.0.1:54321/auth/v1'");
  });

  it("escapes quotes and backslashes in the reason as one SQL literal", () => {
    const sql = prepareAdminBootstrap({ ...input, reason: "Owner's \\path'); select 1; --" }, env);
    expect(sql).toContain("p_reason := E'Owner''s \\\\path''); select 1; --'");
  });

  it.each([
    "http://preview-project.supabase.co", "https://example.com", "https://127.0.0.1",
    "https://secret:password@preview-project.supabase.co", "https://preview-project.supabase.co/path",
    "https://preview-project.supabase.co/?secret=value", "https://preview-project.supabase.co/#fragment",
    "https://preview-project.supabase.co:8443", "invalid", "",
  ])("rejects invalid hosted URL %s without reflecting it", (url) => {
    expect(() => prepareAdminBootstrap(input, { ...env, NEXT_PUBLIC_SUPABASE_URL: url })).toThrow(/SUPABASE_URL/);
  });

  it.each([
    { ...env, ADMIN_ENVIRONMENT: "production" },
    { NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL },
    { ...env, VERCEL: "1", VERCEL_ENV: "production" },
  ])("rejects missing or conflicting deployment identity", (values) => {
    expect(() => prepareAdminBootstrap(input, values)).toThrow(/environment|ENVIRONMENT/);
  });

  it.each([
    { userId: "'); select 1; --" }, { environment: "staging" },
    { reason: "" }, { reason: " padded " }, { reason: "a\ncomment" },
    { reason: "a\u0000b" }, { reason: "x".repeat(501) },
  ])("rejects invalid user-supplied arguments", (patch) => {
    expect(() => prepareAdminBootstrap({ ...input, ...patch }, env)).toThrow();
  });

  it("uses a selected env file exclusively, including quoted values", () => {
    const file = path.join(temporary(), ".env.preview");
    writeFileSync(file, 'ADMIN_ENVIRONMENT="preview"\nNEXT_PUBLIC_SUPABASE_URL="https://from-file.supabase.co"\nSUPABASE_SERVICE_ROLE_KEY=secret-sentinel\n');
    const sql = runAdminBootstrapCli([...args, "--env-file", file], { ADMIN_ENVIRONMENT: "production", NEXT_PUBLIC_SUPABASE_URL: "https://stale.supabase.co" });
    expect(sql).toContain("p_project_ref := E'from-file'");
    expect(sql).not.toContain("stale");
    expect(sql).not.toContain("secret-sentinel");
    writeFileSync(file, "ADMIN_ENVIRONMENT=preview\n");
    expect(() => runAdminBootstrapCli([...args, "--env-file", file], env)).toThrow(/SUPABASE_URL/);
  });

  it("creates a new output file and refuses to overwrite existing content", () => {
    const file = path.join(temporary(), "nested", "bootstrap.sql");
    expect(runAdminBootstrapCli([...args, "--out", file], env)).toContain("No database changes made");
    const sql = readFileSync(file, "utf8");
    expect(sql).toBe(prepareAdminBootstrap(input, env));
    expect(() => runAdminBootstrapCli([...args, "--out", file], env)).toThrow(/new file/);
    expect(readFileSync(file, "utf8")).toBe(sql);
  });

  it("runs the actual CLI with only existing public config and never prints unrelated secrets", () => {
    const cli = fileURLToPath(new URL("./prepare-admin-bootstrap.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env, VERCEL: "", SUPABASE_SERVICE_ROLE_KEY: "secret-sentinel" }, encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(prepareAdminBootstrap(input, env));
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("secret-sentinel");
    const failed = spawnSync(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env, VERCEL: "", NEXT_PUBLIC_SUPABASE_URL: "https://secret-sentinel:password@host.supabase.co" }, encoding: "utf8",
    });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).not.toContain("secret-sentinel");
  });

  it("does not load configuration for help and rejects unknown flags", () => {
    expect(runAdminBootstrapCli(["--help"], {})).toContain("Usage:");
    expect(() => runAdminBootstrapCli([...args, "--execute"], env)).toThrow(/Invalid arguments/);
  });
});
