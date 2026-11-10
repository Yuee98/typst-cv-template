/** Pure evidence bindings. A revalidation is not a second accepted checkpoint. */
import type { RebuildState } from "./db-safety.ts";

export const REVALIDATION_REPOSITORY = "Yuee98/typst-cv-template";
export const APPLICATION_GATES = ["anonymous_and_legal", "authenticated_cloud_cv", "account_isolation_and_encrypted_logout", "latest_export_roundtrip", "admin_authorization_and_save", "ai_runtime_scope"] as const;
export type EvidenceRef = { path: string; sha256: string };
export type ManifestBinding = { baseline_digest: string; migration_manifest_digest: string };
export type CleanupBinding = { reset_method: "application_allowlist"; cleanup_sql_digest: string; retired_inventory_digest: string };
export type CIInput = {
  format: "candidate_ci_evidence_1";
  repository: typeof REVALIDATION_REPOSITORY;
  source_sha: string;
  web_run_id: number;
  database_run_id: number;
  artifact_id: number;
  artifact_archive: EvidenceRef;
};
export type ApplicationEvidence = {
  format: "test_application_acceptance_1";
  source_sha: string;
  project: string;
  database_instance_id: string;
  environment: "PREVIEW";
  deployment_id: string;
  deployed_source_sha: string;
  gates: Record<typeof APPLICATION_GATES[number], { passed: true; evidence: EvidenceRef }>;
};
export type VerifiedCI = { web_run: Record<string, unknown>; database_run: Record<string, unknown>; artifact: Record<string, unknown>; archive_sha256: string; origin_verified_at: string };
export type TestRevalidation = ManifestBinding & CleanupBinding & {
  format: "test_release_revalidation_1";
  project: string;
  source_sha: string;
  accepted_source_sha: string;
  accepted_checkpoint_sha256: string;
  database_instance_id: string;
  contract_code: "cv_app_db_2";
  history: string[];
  verified_at: string;
  ci: VerifiedCI;
  application_deployment_id: string;
  evidence: { ci: EvidenceRef; rehearsal: EvidenceRef; application: EvidenceRef; verification: EvidenceRef };
};
const hex = (value: unknown, length: number) => typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function requireFact(value: unknown, reason: string): asserts value { if (!value) throw new Error(`Revalidation evidence rejected: ${reason}`); }
function record(value: unknown): Record<string, unknown> {
  requireFact(value && typeof value === "object" && !Array.isArray(value), "object required");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]) {
  requireFact(Object.keys(value).sort().join("|") === [...expected].sort().join("|"), "unexpected or missing fields");
}
export function evidenceRef(value: unknown): EvidenceRef {
  const ref = record(value); keys(ref, ["path", "sha256"]);
  requireFact(typeof ref.path === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/.test(ref.path) && !ref.path.split("/").some(part => !part || part === "." || part === "..") && hex(ref.sha256, 64), "invalid relative evidence reference");
  return ref as EvidenceRef;
}
export function parseCIInput(value: unknown, sourceSha: string): CIInput {
  const ci = record(value); keys(ci, ["format", "repository", "source_sha", "web_run_id", "database_run_id", "artifact_id", "artifact_archive"]);
  requireFact(ci.format === "candidate_ci_evidence_1" && ci.repository === REVALIDATION_REPOSITORY && ci.source_sha === sourceSha, "CI source/repository mismatch");
  for (const key of ["web_run_id", "database_run_id", "artifact_id"]) requireFact(Number.isSafeInteger(ci[key]) && Number(ci[key]) > 0, "invalid CI identity");
  requireFact(ci.web_run_id !== ci.database_run_id, "distinct CI workflows required");
  evidenceRef(ci.artifact_archive);
  return ci as CIInput;
}
export function validateCIOrigin(input: CIInput, webValue: unknown, databaseValue: unknown, artifactValue: unknown): Omit<VerifiedCI, "origin_verified_at"> {
  const web = record(webValue), database = record(databaseValue), artifact = record(artifactValue);
  for (const [run, id, path] of [[web, input.web_run_id, ".github/workflows/ci.yml"], [database, input.database_run_id, ".github/workflows/db-tests.yml"]] as const) {
    requireFact(run.id === id && run.head_sha === input.source_sha && run.path === path && run.status === "completed" && run.conclusion === "success" && ["push", "workflow_dispatch"].includes(String(run.event)), "CI run is not a successful actual-candidate workflow");
  }
  const workflow = record(artifact.workflow_run);
  requireFact(artifact.id === input.artifact_id && artifact.name === "database-rehearsal-evidence" && artifact.expired === false && workflow.id === input.database_run_id && workflow.head_sha === input.source_sha && artifact.digest === `sha256:${input.artifact_archive.sha256}`, "CI artifact origin/digest mismatch");
  return { web_run: web, database_run: database, artifact, archive_sha256: input.artifact_archive.sha256 };
}
export function parseApplicationEvidence(value: unknown, sourceSha: string, project: string, instance: string): ApplicationEvidence {
  const app = record(value); keys(app, ["format", "source_sha", "project", "database_instance_id", "environment", "deployment_id", "deployed_source_sha", "gates"]);
  requireFact(app.format === "test_application_acceptance_1" && app.source_sha === sourceSha && app.deployed_source_sha === sourceSha && app.project === project && app.database_instance_id === instance && app.environment === "PREVIEW" && typeof app.deployment_id === "string" && /^[A-Za-z0-9_-]{6,120}$/.test(app.deployment_id), "application deployment/target mismatch");
  const gates = record(app.gates); keys(gates, APPLICATION_GATES);
  for (const name of APPLICATION_GATES) { const gate = record(gates[name]); keys(gate, ["passed", "evidence"]); requireFact(gate.passed === true, "required application gate failed"); evidenceRef(gate.evidence); }
  return app as ApplicationEvidence;
}
export function requireRevalidationInputs(state: RebuildState, sourceSha: string, project: string, manifest: ManifestBinding, cleanup: CleanupBinding) {
  requireFact(state.target === "test" && state.project === project && state.phase === "accepted" && state.maintenance === false && uuid(state.instance) && Array.isArray(state.history) && state.history.length > 0, "original accepted test state required");
  requireFact(hex(sourceSha, 40) && state.baseline_digest === manifest.baseline_digest && state.migration_manifest_digest === manifest.migration_manifest_digest, "unchanged complete migration manifest required");
  requireFact(state.reset_method === cleanup.reset_method && state.cleanup_sql_digest === cleanup.cleanup_sql_digest && state.retired_inventory_digest === cleanup.retired_inventory_digest, "unchanged cleanup method/inventory required");
}
export function requireVerifiedTestCatalog(value: unknown, state: RebuildState, manifest: ManifestBinding) {
  const checked = record(value), context = record(checked.context);
  requireFact(context.ready === true && context.environment === "PREVIEW" && context.contract_code === "cv_app_db_2" && context.database_instance_id === state.instance, "live test environment/contract/instance mismatch");
  requireFact(JSON.stringify(checked.history) === JSON.stringify(state.history) && checked.baseline_digest === manifest.baseline_digest && checked.migration_manifest_digest === manifest.migration_manifest_digest, "live test history/manifest mismatch");
}
export function parseTestRevalidation(value: unknown): TestRevalidation {
  const proof = record(value);
  keys(proof, ["format", "project", "source_sha", "accepted_source_sha", "accepted_checkpoint_sha256", "database_instance_id", "contract_code", "history", "verified_at", "baseline_digest", "migration_manifest_digest", "reset_method", "cleanup_sql_digest", "retired_inventory_digest", "ci", "application_deployment_id", "evidence"]);
  requireFact(proof.format === "test_release_revalidation_1" && hex(proof.source_sha, 40) && hex(proof.accepted_source_sha, 40) && hex(proof.accepted_checkpoint_sha256, 64) && uuid(proof.database_instance_id) && proof.contract_code === "cv_app_db_2" && Array.isArray(proof.history) && proof.history.length > 0 && proof.history.every(version => typeof version === "string" && /^\d{14}$/.test(version)) && typeof proof.verified_at === "string" && Number.isFinite(Date.parse(proof.verified_at)), "invalid detached proof");
  for (const key of ["baseline_digest", "migration_manifest_digest", "cleanup_sql_digest", "retired_inventory_digest"]) requireFact(hex(proof[key], 64), "invalid proof digest");
  requireFact(proof.reset_method === "application_allowlist", "unsupported proof method");
  const refs = record(proof.evidence); keys(refs, ["ci", "rehearsal", "application", "verification"]);
  Object.values(refs).forEach(evidenceRef);
  const ci = record(proof.ci); keys(ci, ["web_run", "database_run", "artifact", "archive_sha256", "origin_verified_at"]);
  requireFact(typeof ci.origin_verified_at === "string" && Number.isFinite(Date.parse(ci.origin_verified_at)) && Date.parse(ci.origin_verified_at) <= Date.parse(proof.verified_at as string), "CI origin verification time required");
  requireFact(typeof proof.application_deployment_id === "string" && /^[A-Za-z0-9_-]{6,120}$/.test(proof.application_deployment_id), "application deployment required");
  return proof as TestRevalidation;
}
export function requireRevalidatedTest(proof: TestRevalidation, state: RebuildState, acceptedDigest: string, sourceSha: string, project: string, manifest: ManifestBinding, cleanup: CleanupBinding, rehearsalDigest: string) {
  requireRevalidationInputs(state, sourceSha, project, manifest, cleanup);
  requireFact(proof.project === project && proof.source_sha === sourceSha && proof.accepted_source_sha === state.source_sha && proof.accepted_checkpoint_sha256 === acceptedDigest && proof.database_instance_id === state.instance && JSON.stringify(proof.history) === JSON.stringify(state.history), "detached proof is not bound to this original checkpoint/candidate");
  for (const key of ["baseline_digest", "migration_manifest_digest"] as const) requireFact(proof[key] === manifest[key], "detached migration digest mismatch");
  for (const key of ["reset_method", "cleanup_sql_digest", "retired_inventory_digest"] as const) requireFact(proof[key] === cleanup[key], "detached cleanup digest mismatch");
  requireFact(proof.evidence.rehearsal.sha256 === rehearsalDigest, "detached G3 differs from production rehearsal input");
}
