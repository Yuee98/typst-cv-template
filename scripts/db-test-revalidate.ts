/** Detached, read-only release verification. Never advances a rebuild checkpoint. */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { checkContract } from "./db-contract-check.ts";
import { input, jsonQueryReadOnly, migrationManifest, root, run } from "./db-common.ts";
import { readPrivateBytes, readPrivateCheckpoint, readPrivateJson, writePrivateJsonNew } from "./db-hosted-state.ts";
import { requireRehearsalEvidence, validateDatabaseServer, validateProjectIdentity, type RebuildState } from "./db-safety.ts";
import { APPLICATION_GATES, evidenceRef, parseApplicationEvidence, parseCIInput, parseTestRevalidation, REVALIDATION_REPOSITORY, requireRevalidatedTest, requireRevalidationInputs, requireVerifiedTestCatalog, validateCIOrigin, type CleanupBinding, type EvidenceRef, type ManifestBinding, type TestRevalidation } from "./db-test-revalidation.ts";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function currentCleanup(): CleanupBinding {
  return { reset_method: "application_allowlist", cleanup_sql_digest: digest(readFileSync(resolve(root, "supabase/retired-application-reset.sql"))), retired_inventory_digest: digest(readFileSync(resolve(root, "scripts/database-retired-objects.json"))) };
}
function privateDirectory(path: string) {
  if (!isAbsolute(path)) throw new Error("An absolute private evidence directory is required");
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.()) throw new Error("Evidence directory must be owned 0700");
  return realpathSync(path);
}
function reference(directory: string, path: string): EvidenceRef {
  if (!isAbsolute(path)) throw new Error("Evidence files must use absolute paths");
  const actual = realpathSync(path), name = relative(directory, actual).split(sep).join("/");
  const ref = evidenceRef({ path: name, sha256: readPrivateBytes(path).digest });
  if (resolve(directory, ref.path) !== actual) throw new Error("Evidence escaped its output directory");
  return ref;
}
function referred(directory: string, ref: EvidenceRef) {
  const path = resolve(directory, evidenceRef(ref).path);
  if (reference(directory, path).sha256 !== ref.sha256) throw new Error("Referenced evidence bytes changed");
  return path;
}
function github(path: string, projection: string) {
  // Existing operator gh identity only; no token provisioning or writes.
  const result = spawnSync("gh", ["api", `repos/${REVALIDATION_REPOSITORY}/${path}`, "--jq", projection], { encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024 });
  if (result.error || result.status !== 0) throw new Error("CI origin lookup failed; captured output is withheld");
  return JSON.parse(result.stdout);
}
function requireReadOnlyObservation(value: unknown) {
  const server = value as Record<string, unknown> | null;
  if (!server || server.transaction_read_only !== "on" || server.statement_timeout !== "20s" || server.lock_timeout !== "3s") throw new Error("Actual read-only transaction and timeout observations are required");
}
function verifySupportingEvidence(directory: string, sourceSha: string, project: string, state: RebuildState, manifest: ManifestBinding, cleanup: CleanupBinding, files: { ci: string; rehearsal: string; application: string }, online: boolean) {
  const refs = { ci: reference(directory, files.ci), rehearsal: reference(directory, files.rehearsal), application: reference(directory, files.application) };
  const ci = parseCIInput(readPrivateJson(files.ci).value, sourceSha);
  const zipPath = referred(directory, ci.artifact_archive);
  const rehearsal = readPrivateJson(files.rehearsal);
  requireRehearsalEvidence(rehearsal.value as Record<string, unknown>, sourceSha, manifest, cleanup);
  // Extract one fixed member to memory: no filesystem extraction or untrusted paths.
  const zipped = spawnSync("unzip", ["-p", zipPath, "remote-rehearsal-proof.json"], { encoding: "buffer", timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
  if (zipped.error || zipped.status !== 0 || digest(zipped.stdout) !== rehearsal.digest) throw new Error("G3 bytes differ from the CI artifact member");
  const app = parseApplicationEvidence(readPrivateJson(files.application).value, sourceSha, project, state.instance!);
  for (const name of APPLICATION_GATES) referred(directory, app.gates[name].evidence);
  if (!online) return { refs, app, ci, verifiedCI: null };
  const runProjection = "{id,head_sha,path,status,conclusion,event,run_attempt}";
  const verifiedCI = { ...validateCIOrigin(ci,
    github(`actions/runs/${ci.web_run_id}`, runProjection),
    github(`actions/runs/${ci.database_run_id}`, runProjection),
    github(`actions/artifacts/${ci.artifact_id}`, "{id,name,expired,digest,workflow_run:{id:.workflow_run.id,head_sha:.workflow_run.head_sha}}")), origin_verified_at: new Date().toISOString() };
  return { refs, app, ci, verifiedCI };
}

/** Offline consumption of controlled private operator material, not a signed attestation.
 * CI origin is checked at creation; archived bytes remain usable after artifact expiry. */
export function loadTestRevalidation(path: string, state: RebuildState, acceptedDigest: string, sourceSha: string, project: string, manifest: ManifestBinding, cleanup: CleanupBinding, rehearsalDigest: string) {
  const file = readPrivateJson(path), proof = parseTestRevalidation(file.value);
  const directory = privateDirectory(dirname(path));
  requireRevalidatedTest(proof, state, acceptedDigest, sourceSha, project, manifest, cleanup, rehearsalDigest);
  const supported = verifySupportingEvidence(directory, sourceSha, project, state, manifest, cleanup, {
    ci: referred(directory, proof.evidence.ci), rehearsal: referred(directory, proof.evidence.rehearsal), application: referred(directory, proof.evidence.application)
  }, false);
  const verification = readPrivateJson(referred(directory, proof.evidence.verification)).value as Record<string, unknown>;
  if (verification.source_sha !== sourceSha || verification.project !== project || verification.read_only !== true) throw new Error("Verification report source/target mismatch");
  requireReadOnlyObservation(verification.server);
  requireVerifiedTestCatalog(verification.catalog, state, manifest);
  const archivedCI = validateCIOrigin(supported.ci, proof.ci.web_run, proof.ci.database_run, proof.ci.artifact);
  if (archivedCI.archive_sha256 !== proof.ci.archive_sha256 || supported.app.deployment_id !== proof.application_deployment_id) throw new Error("Detached CI/application binding changed");
  return { proof, digest: file.digest };
}

export function main() {
  let stage = "local_preflight";
  try {
    const allowed = new Set(["source-sha", "expected-project-ref", "test-state", "ci-evidence", "rehearsal-evidence", "application-evidence", "output"]);
    if (process.argv.slice(2).some(arg => arg !== "--execute-read-only" && (!arg.startsWith("--") || !allowed.has(arg.slice(2).split("=")[0]) || !arg.includes("=")))) throw new Error("Unsupported revalidation argument");
    if (process.env.GITHUB_ACTIONS === "true") throw new Error("Read-only hosted revalidation runs on the operator machine");
    const sourceSha = input("source-sha"), project = input("expected-project-ref"), statePath = input("test-state"), output = input("output");
    if (!/^[0-9a-f]{40}$/.test(sourceSha) || run("git", ["rev-parse", "HEAD"]) !== sourceSha) throw new Error("Checkout must equal the exact candidate");
    if (run("git", ["status", "--porcelain", "--untracked-files=normal"])) throw new Error("Revalidation requires a clean checkout");
    const directory = privateDirectory(dirname(output));
    if (!isAbsolute(output) || existsSync(output)) throw new Error("Proof output must be a new absolute file");
    const accepted = readPrivateCheckpoint(statePath), manifest = migrationManifest(), cleanup = currentCleanup();
    requireRevalidationInputs(accepted.state, sourceSha, project, manifest, cleanup);
    const files = { ci: input("ci-evidence"), rehearsal: input("rehearsal-evidence"), application: input("application-evidence") };
    const execute = process.argv.includes("--execute-read-only");
    // Plan checks only local materials. It never invokes psql, gh or a hosted API.
    const supported = verifySupportingEvidence(directory, sourceSha, project, accepted.state, manifest, cleanup, files, false);
    if (!execute) {
      console.log(JSON.stringify({ mode: "plan", destructive: false, connects_to_database: false, project, source_sha: sourceSha, accepted_source_sha: accepted.state.source_sha, accepted_checkpoint_sha256: accepted.digest, ...manifest, ...cleanup, evidence: supported.refs }));
      return;
    }
    stage = "candidate_and_target";
    validateProjectIdentity("test", project, process.env);
    run("git", ["merge-base", "--is-ancestor", sourceSha, "origin/main"]);
    run("git", ["merge-base", "--is-ancestor", accepted.state.source_sha, sourceSha]);
    stage = "ci_origin";
    const verified = verifySupportingEvidence(directory, sourceSha, project, accepted.state, manifest, cleanup, files, true);
    stage = "read_only_catalog";
    const server = jsonQueryReadOnly("select jsonb_build_object('server_version_num',current_setting('server_version_num'),'database',current_database(),'current_user',current_user,'transaction_read_only',current_setting('transaction_read_only'),'default_transaction_read_only',current_setting('default_transaction_read_only'),'statement_timeout',current_setting('statement_timeout'),'lock_timeout',current_setting('lock_timeout'));", false);
    validateDatabaseServer(server);
    requireReadOnlyObservation(server);
    const catalog = checkContract(false, jsonQueryReadOnly);
    requireVerifiedTestCatalog(catalog, accepted.state, manifest);
    const runtime = jsonQueryReadOnly("select jsonb_build_object('enabled',enabled,'audience',audience,'revision',revision::text,'user_daily_limit',user_daily_limit::text,'global_daily_limit',global_daily_limit::text,'user_minute_limit',user_minute_limit::text) from ai.runtime_control where id=1;", false);
    if (readPrivateCheckpoint(statePath).digest !== accepted.digest) throw new Error("Original accepted checkpoint changed during verification");
    const verifiedAt = new Date().toISOString(), reportPath = resolve(directory, `verification-${randomUUID()}.json`);
    writePrivateJsonNew(reportPath, { source_sha: sourceSha, project, verified_at: verifiedAt, read_only: true, scope: "current contract, permissions, identity and complete recorded migration history; not a live function-body byte comparison", server, catalog, runtime });
    const proof: TestRevalidation = { format: "test_release_revalidation_1", project, source_sha: sourceSha, accepted_source_sha: accepted.state.source_sha, accepted_checkpoint_sha256: accepted.digest, database_instance_id: accepted.state.instance!, contract_code: "cv_app_db_2", history: accepted.state.history!, verified_at: verifiedAt, baseline_digest: manifest.baseline_digest, migration_manifest_digest: manifest.migration_manifest_digest, ...cleanup, ci: verified.verifiedCI!, application_deployment_id: verified.app.deployment_id, evidence: { ...verified.refs, verification: reference(directory, reportPath) } };
    writePrivateJsonNew(output, proof);
    console.log(JSON.stringify({ result: "PASS", source_sha: sourceSha, proof_sha256: readPrivateBytes(output).digest, original_checkpoint_unchanged: true, read_only: true }));
  } catch {
    console.error(`Test revalidation stopped during ${stage}; no checkpoint, application data, Auth, jobs or acceptance state was written. Inspect private local evidence; exception/SQL/credentials are omitted.`);
    process.exitCode = 1;
  }
}
if (import.meta.main) main();
