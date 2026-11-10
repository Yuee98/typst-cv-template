import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireAcceptedTest, type RebuildState } from "./db-safety.ts";
import { readPrivateJson, writePrivateJsonNew } from "./db-hosted-state.ts";
import { APPLICATION_GATES, evidenceRef, parseApplicationEvidence, parseCIInput, parseTestRevalidation, requireRevalidatedTest, requireRevalidationInputs, requireVerifiedTestCatalog, validateCIOrigin, type TestRevalidation } from "./db-test-revalidation.ts";

const source = "b".repeat(40), original = "a".repeat(40), project = "c".repeat(20), instance = "00000000-0000-4000-8000-000000000071";
const manifest = { baseline_digest: "1".repeat(64), migration_manifest_digest: "2".repeat(64) };
const cleanup = { reset_method: "application_allowlist" as const, cleanup_sql_digest: "3".repeat(64), retired_inventory_digest: "4".repeat(64) };
const ref = { path: "evidence.json", sha256: "5".repeat(64) }, acceptedDigest = "6".repeat(64);
const accepted: RebuildState = { operation_id: "00000000-0000-4000-8000-000000000072", target: "test", project, source_sha: original, ...manifest, ...cleanup, instance, history: ["20261108123100"], phase: "accepted", maintenance: false, intent_time: "2026-11-09T00:00:00Z" };
const ciInput = { format: "candidate_ci_evidence_1", repository: "Yuee98/typst-cv-template", source_sha: source, web_run_id: 11, database_run_id: 12, artifact_id: 13, artifact_archive: { ...ref, path: "ci.zip" } };
const web = { id: 11, head_sha: source, path: ".github/workflows/ci.yml", status: "completed", conclusion: "success", event: "push", run_attempt: 1 };
const database = { ...web, id: 12, path: ".github/workflows/db-tests.yml", event: "workflow_dispatch" };
const artifact = { id: 13, name: "database-rehearsal-evidence", expired: false, digest: `sha256:${ref.sha256}`, workflow_run: { id: 12, head_sha: source } };
const app = { format: "test_application_acceptance_1", source_sha: source, project, database_instance_id: instance, environment: "PREVIEW", deployment_id: "deployment-synthetic", deployed_source_sha: source, gates: Object.fromEntries(APPLICATION_GATES.map(name => [name, { passed: true, evidence: ref }])) };
const proof: TestRevalidation = { format: "test_release_revalidation_1", project, source_sha: source, accepted_source_sha: original, accepted_checkpoint_sha256: acceptedDigest, database_instance_id: instance, contract_code: "cv_app_db_2", history: accepted.history!, verified_at: "2026-11-11T00:00:00Z", ...manifest, ...cleanup, ci: { web_run: web, database_run: database, artifact, archive_sha256: ref.sha256, origin_verified_at: "2026-11-11T00:00:00Z" }, application_deployment_id: app.deployment_id, evidence: { ci: ref, rehearsal: ref, application: ref, verification: ref } };

test("a newer candidate needs a detached proof bound to the untouched accepted checkpoint", () => {
  assert.throws(() => requireAcceptedTest(accepted, project, source, manifest));
  const evidence = { proof, acceptedDigest, cleanup, rehearsalDigest: ref.sha256 };
  // Calling the existing public guard proves the old same-SHA-only behavior RED.
  assert.doesNotThrow(() => Reflect.apply(requireAcceptedTest, undefined, [accepted, project, source, manifest, evidence]));
  assert.doesNotThrow(() => requireAcceptedTest(accepted, project, original, manifest));
});

test("detached bindings reject changed original bytes, candidate, instance, history, manifests and cleanup", () => {
  for (const change of [
    { accepted_checkpoint_sha256: "7".repeat(64) }, { source_sha: original }, { accepted_source_sha: source },
    { project: "d".repeat(20) }, { database_instance_id: "00000000-0000-4000-8000-000000000079" },
    { history: ["20261108123101"] }, { contract_code: "cv_app_db_1" }, { baseline_digest: "8".repeat(64) },
    { migration_manifest_digest: "8".repeat(64) }, { cleanup_sql_digest: "8".repeat(64) }, { retired_inventory_digest: "8".repeat(64) }
  ]) {
    assert.throws(() => {
      const changed = parseTestRevalidation({ ...proof, ...change });
      requireRevalidatedTest(changed, accepted, acceptedDigest, source, project, manifest, cleanup, ref.sha256);
    }, JSON.stringify(change));
  }
  assert.throws(() => requireRevalidatedTest(proof, accepted, acceptedDigest, source, project, manifest, cleanup, "9".repeat(64)));
  for (const change of [{ phase: "DB-ready" }, { maintenance: true }, { target: "prod" }, { instance: undefined }, { history: [] }]) {
    assert.throws(() => requireRevalidationInputs({ ...accepted, ...change }, source, project, manifest, cleanup));
  }
});

test("CI must be successful actual-candidate workflows and the exact downloadable artifact", () => {
  const ci = parseCIInput(ciInput, source);
  assert.doesNotThrow(() => validateCIOrigin(ci, web, database, artifact));
  for (const change of [{ head_sha: original }, { conclusion: "failure" }, { status: "in_progress" }, { event: "pull_request" }, { path: ".github/workflows/other.yml" }]) assert.throws(() => validateCIOrigin(ci, { ...web, ...change }, database, artifact));
  for (const change of [{ id: 14 }, { expired: true }, { digest: `sha256:${"9".repeat(64)}` }, { workflow_run: { id: 12, head_sha: original } }]) assert.throws(() => validateCIOrigin(ci, web, database, { ...artifact, ...change }));
  assert.throws(() => parseCIInput({ all_gates_passed: true }, source));
  assert.throws(() => parseCIInput({ ...ciInput, source_sha: original }, source));
});

test("application acceptance requires this deployment, exact candidate, test instance and every explicit gate", () => {
  assert.doesNotThrow(() => parseApplicationEvidence(app, source, project, instance));
  for (const change of [{ source_sha: original }, { deployed_source_sha: original }, { environment: "PRODUCTION" }, { project: "d".repeat(20) }, { database_instance_id: "00000000-0000-4000-8000-000000000079" }, { gates: { all_gates_passed: true } }]) assert.throws(() => parseApplicationEvidence({ ...app, ...change }, source, project, instance));
  assert.throws(() => parseApplicationEvidence({ ...app, gates: { ...app.gates, ai_runtime_scope: { passed: false, evidence: ref } } }, source, project, instance));
});

test("live catalog binding checks instance, PREVIEW, contract and complete history without an AI-off requirement", () => {
  const catalog = { context: { ready: true, environment: "PREVIEW", contract_code: "cv_app_db_2", database_instance_id: instance }, history: accepted.history, ...manifest, runtime: { enabled: true } };
  assert.doesNotThrow(() => requireVerifiedTestCatalog(catalog, accepted, manifest));
  for (const change of [{ ready: false }, { environment: "PRODUCTION" }, { database_instance_id: null }, { contract_code: "cv_app_db_1" }]) assert.throws(() => requireVerifiedTestCatalog({ ...catalog, context: { ...catalog.context, ...change } }, accepted, manifest));
  assert.throws(() => requireVerifiedTestCatalog({ ...catalog, history: [] }, accepted, manifest));
});

test("private evidence publication is atomic, no-replace and refuses unsafe files or relative references", () => {
  const directory = mkdtempSync(join(tmpdir(), "cv-test-revalidation-")), path = join(directory, "proof.json");
  try {
    writePrivateJsonNew(path, proof);
    const before = readFileSync(path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readPrivateJson(path).value, proof);
    assert.throws(() => writePrivateJsonNew(path, { overwritten: true }));
    assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(readdirSync(directory), ["proof.json"]);
    const link = join(directory, "link.json"); symlinkSync(path, link);
    assert.throws(() => readPrivateJson(link));
    const hard = join(directory, "hard.json"); linkSync(path, hard);
    assert.throws(() => readPrivateJson(path));
    chmodSync(directory, 0o755);
    assert.throws(() => writePrivateJsonNew(join(directory, "unsafe.json"), proof));
    assert.equal(existsSync(join(directory, "unsafe.json")), false);
    for (const path of ["/absolute", "../outside", "a/../../outside", "a//b", "a/./b", "a\\b"]) assert.throws(() => evidenceRef({ ...ref, path }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
