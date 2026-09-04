import { expect, it, vi } from "vitest";

import {
  parseReviewedDeploymentImport,
  reviewedDeploymentImportSql,
  runReviewedDeploymentImport,
  parseRuntimeAdmissionImport,
  runtimeAdmissionImportSql,
} from "./admin-reviewed-deployment-import.mjs";

const future = "2099-01-01T00:00:00.000Z";
const input = {
  schemaVersion: "admin_reviewed_deployment_import_v1",
  id: "11111111-1111-4111-8111-111111111111",
  environment: "preview",
  projectRef: "preview-project",
  runtimeBuildId: "build:2026-09-04",
  bindingManifestRevision: "manifest-2026-09-04",
  bindingManifestSha256: "1".repeat(64),
  codeCapabilityIds: ["runtime-capability.mimo", "runtime-capability.deepseek"],
  reviewedEvidenceIds: ["evidence.z", "evidence.a"],
  reviewedSourceCommitOid: `sha1:${"2".repeat(40)}`,
  reviewedSourceSha256: "3".repeat(64),
  validUntil: future,
};

it("validates and canonicalizes reviewed deployment sets", () => {
  const parsed = parseReviewedDeploymentImport(input, 0);
  expect(parsed.codeCapabilityIds).toEqual([
    "runtime-capability.deepseek",
    "runtime-capability.mimo",
  ]);
  expect(parsed.reviewedEvidenceIds).toEqual(["evidence.a", "evidence.z"]);
  const sql = reviewedDeploymentImportSql(input);
  expect(sql).toContain("select public.admin_import_reviewed_deployment_v1(");
  expect(sql).toContain("'preview', 'preview-project'");
  expect(sql.indexOf("runtime-capability.deepseek")).toBeLessThan(
    sql.indexOf("runtime-capability.mimo"),
  );
  expect(sql).not.toContain("PGPASSWORD");
});

it("rejects unknown fields, duplicate evidence, and expired inputs", () => {
  expect(() => parseReviewedDeploymentImport({ ...input, secret: "hidden" }, 0)).toThrow();
  expect(() => parseReviewedDeploymentImport({
    ...input,
    reviewedEvidenceIds: ["evidence.a", "evidence.a"],
  }, 0)).toThrow();
  expect(() => parseReviewedDeploymentImport({
    ...input,
    validUntil: "2020-01-01T00:00:00.000Z",
  })).toThrow();
  expect(() => parseReviewedDeploymentImport({
    ...input,
    validUntil: "2099",
  }, 0)).toThrow();
});

it("prints by default and requires exact environment acknowledgement to execute", () => {
  const stdout = { write: vi.fn() };
  expect(runReviewedDeploymentImport(["input.json"], {
    readFile: () => JSON.stringify(input),
    stdout,
  })).toBe(0);
  expect(stdout.write).toHaveBeenCalledOnce();

  const spawn = vi.fn().mockReturnValue({ status: 0 });
  expect(() => runReviewedDeploymentImport([
    "--execute", "--ack", "production/preview-project", "input.json",
  ], { readFile: () => JSON.stringify(input), spawn, stdout })).toThrow(
    /acknowledgement/,
  );
  expect(spawn).not.toHaveBeenCalled();

  expect(runReviewedDeploymentImport([
    "--execute", "--ack", "preview/preview-project", "input.json",
  ], {
    readFile: () => JSON.stringify(input),
    spawn,
    stdout,
    env: { PGHOST: "db.example.test", PGDATABASE: "postgres", PGUSER: "postgres.preview-project" },
  })).toBe(0);
  expect(spawn).toHaveBeenCalledWith(
    "psql",
    ["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--file", "-"],
    expect.objectContaining({
      input: expect.stringContaining("begin;"),
      env: expect.objectContaining({ PGUSER: "postgres.preview-project" }),
    }),
  );
});

it("requires an exact canonical v2 deployment target set", () => {
  const admission = {
    schemaVersion: "admin_runtime_admission_import_v2",
    reviewedDeploymentId: input.id,
    targets: [{
      runtimeContractId: "runtime.mimo.v2",
      runtimeTargetId: "target.mimo.v2",
      validationReportId: "22222222-2222-4222-8222-222222222222",
    }, {
      runtimeContractId: "runtime.deepseek.v2",
      runtimeTargetId: "target.deepseek.v2",
      validationReportId: "33333333-3333-4333-8333-333333333333",
    }],
    reason: "operator admission",
  };
  const parsed = parseRuntimeAdmissionImport(admission);
  expect(parsed.targets.map((target) => target.runtimeTargetId)).toEqual([
    "target.deepseek.v2", "target.mimo.v2",
  ]);
  const sql = runtimeAdmissionImportSql(admission);
  expect(sql).toContain("admin_admit_runtime_deployment_v2");
  expect(sql).toContain("::jsonb");
  expect(sql).not.toContain("\\nbegin;");
  expect(() => parseRuntimeAdmissionImport({
    ...admission,
    targets: [...admission.targets, admission.targets[0]],
  })).toThrow(/unique/);
  expect(() => parseRuntimeAdmissionImport({
    ...admission,
    targets: [{ ...admission.targets[0], targetId: "forged" }],
  })).toThrow();

  const spawn = vi.fn().mockReturnValue({ status: 0 });
  expect(() => runReviewedDeploymentImport([
    "--execute", "--ack", "preview/preview-project", "input.json",
  ], {
    readFile: () => JSON.stringify(admission), spawn,
    env: { PGHOST: "db.example.test", PGDATABASE: "postgres", PGUSER: "postgres.preview-project" },
  })).toThrow(/acknowledgement/);
  expect(runReviewedDeploymentImport([
    "--execute", "--ack", `admission/${input.id}`, "input.json",
  ], {
    readFile: () => JSON.stringify(admission), spawn,
    env: { PGHOST: "db.example.test", PGDATABASE: "postgres", PGUSER: "postgres.preview-project" },
  })).toBe(0);
});
