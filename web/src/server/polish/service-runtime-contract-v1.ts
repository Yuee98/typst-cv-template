import { createHash } from "node:crypto";

import {
  DEEPSEEK_LEGAL_MANIFEST_ID,
  INITIAL_LEGAL_BUNDLE_VERSION,
  LEGAL_FINGERPRINT_V1_DESCRIPTORS,
  LEGAL_FINGERPRINT_V1_EXPECTED_SHA256,
  LEGAL_FINGERPRINT_V1_PROFILE_MAPPING,
  deriveRequiredServiceFactPairs,
} from "./legal-fingerprint-v1-descriptors";
import { fingerprintLegalDescriptorV1 } from "./legal-fingerprint-v1";
import type {
  RuntimeExecutionTargetV1,
  RuntimeRouteDescriptorV1,
  RuntimeTargetResolverV1,
} from "./lifecycle-v2-contract";
import { resolveProfile } from "./profile-registry";

export const DEEPSEEK_SERVICE_RUNTIME_CONTRACT_ID =
  "runtime.deepseek-v2.v1" as const;
export const DEEPSEEK_SERVICE_RUNTIME_TARGET_ID =
  "runtime-target.deepseek.official.deepseek-v4-flash.chat.v1" as const;
export const DEEPSEEK_PROFILE_KEY =
  "deepseek.official.deepseek-v4-flash.chat.v1" as const;
export const DEEPSEEK_PROFILE_VERSION_ID =
  "11111111-1111-4111-8111-111111111111" as const;
export const DEEPSEEK_REVIEWED_SOURCE_COMMIT_OID =
  "sha1:b2390ff817612df7e3eed40aa775ff4cd4228085" as const;

const DEEPSEEK_ROUTE_DESCRIPTOR_ID = "route.deepseek.official.v1" as const;
const DEEPSEEK_DISPLAY_DISCLOSURE_KEY = "deepseek-official-v1" as const;
const SERVICE_RUNTIME_REGISTRY_KEYS = [
  "schemaVersion",
  "reviewedSourceCommitOid",
  "legalBundleVersion",
  "bundleContractSha256",
  "requiredServiceFacts",
  "evidence",
  "targets",
  "contract",
  "contractSha256",
  "runtimeTargetSetSha256",
] as const;
const FACT_PAIR_KEYS = ["id", "sha256"] as const;
const HASHED_EVIDENCE_KEYS = ["descriptor", "sha256"] as const;
const HASHED_TARGET_KEYS = [
  "descriptor",
  "sha256",
  "profileVersionId",
  "executionTarget",
] as const;
const EVIDENCE_DESCRIPTOR_KEYS = [
  "schema_version",
  "runtime_evidence_id",
  "authority_kind",
  "supported_fact_id",
  "supported_fact_sha256",
  "source_repo_path",
  "source_git_blob_sha256",
] as const;
const TARGET_DESCRIPTOR_KEYS = [
  "schema_version",
  "runtime_target_id",
  "profile_key",
  "legal_manifest_id",
  "legal_manifest_sha256",
  "route_descriptor_id",
  "route_descriptor_sha256",
] as const;
const CONTRACT_DESCRIPTOR_KEYS = [
  "schema_version",
  "runtime_contract_id",
  "reviewed_source_commit_oid",
  "legal_bundle_version",
  "bundle_contract_sha256",
  "runtime_target_ids",
  "runtime_target_sha256s",
  "service_fact_ids",
  "service_fact_sha256s",
  "runtime_evidence_ids",
  "runtime_evidence_sha256s",
] as const;
const EXECUTION_TARGET_KEYS = [
  "schemaVersion",
  "runtimeContractId",
  "runtimeContractSha256",
  "legalBundleVersion",
  "profileVersionId",
  "profileKey",
  "legalManifestId",
  "routeDescriptor",
] as const;
const RUNTIME_ROUTE_DESCRIPTOR_KEYS = [
  "gatewayKind",
  "adapterKind",
  "wireApiKind",
  "credentialAlias",
  "endpointAlias",
  "modelId",
  "capabilityContractId",
  "cachePolicyId",
  "calculatorKind",
  "displayDisclosureKey",
] as const;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/u;
const PORTABLE_REPO_PATH = /^[A-Za-z0-9._/-]+$/u;

type RuntimeEvidenceAuthorityKind =
  | "service-implementation"
  | "service-test";

export interface ServiceRuntimeEvidenceDescriptorV1 {
  readonly schema_version: "ai_service_runtime_evidence_v1";
  readonly runtime_evidence_id: string;
  readonly authority_kind: RuntimeEvidenceAuthorityKind;
  readonly supported_fact_id: string;
  readonly supported_fact_sha256: string;
  readonly source_repo_path: string;
  readonly source_git_blob_sha256: string;
}

export interface ServiceRuntimeTargetDescriptorV1 {
  readonly schema_version: "ai_service_runtime_target_v1";
  readonly runtime_target_id: string;
  readonly profile_key: string;
  readonly legal_manifest_id: string;
  readonly legal_manifest_sha256: string;
  readonly route_descriptor_id: string;
  readonly route_descriptor_sha256: string;
}

export interface ServiceRuntimeContractDescriptorV1 {
  readonly schema_version: "ai_service_runtime_contract_v1";
  readonly runtime_contract_id: string;
  readonly reviewed_source_commit_oid: string;
  readonly legal_bundle_version: string;
  readonly bundle_contract_sha256: string;
  readonly runtime_target_ids: readonly string[];
  readonly runtime_target_sha256s: readonly string[];
  readonly service_fact_ids: readonly string[];
  readonly service_fact_sha256s: readonly string[];
  readonly runtime_evidence_ids: readonly string[];
  readonly runtime_evidence_sha256s: readonly string[];
}

export interface ServiceRuntimeFactPairV1 {
  readonly id: string;
  readonly sha256: string;
}

export interface HashedServiceRuntimeEvidenceV1 {
  readonly descriptor: Readonly<ServiceRuntimeEvidenceDescriptorV1>;
  readonly sha256: string;
}

export interface HashedServiceRuntimeTargetV1 {
  readonly descriptor: Readonly<ServiceRuntimeTargetDescriptorV1>;
  readonly sha256: string;
  readonly profileVersionId: string;
  readonly executionTarget: Readonly<RuntimeExecutionTargetV1>;
}

export interface ServiceRuntimeContractRegistryV1 {
  readonly schemaVersion: "service_runtime_contract_registry_v1";
  readonly reviewedSourceCommitOid: string;
  readonly legalBundleVersion: string;
  readonly bundleContractSha256: string;
  readonly requiredServiceFacts: readonly Readonly<ServiceRuntimeFactPairV1>[];
  readonly evidence: readonly Readonly<HashedServiceRuntimeEvidenceV1>[];
  readonly targets: readonly Readonly<HashedServiceRuntimeTargetV1>[];
  readonly contract: Readonly<ServiceRuntimeContractDescriptorV1>;
  readonly contractSha256: string;
  readonly runtimeTargetSetSha256: string;
}

interface SourceBlobV1 {
  readonly path: string;
  readonly sha256: string;
}

interface FactEvidenceRouteV1 {
  readonly factId: string;
  readonly implementation: readonly SourceBlobV1[];
  readonly test: readonly SourceBlobV1[];
}

const source = (
  path: string,
  sha256: string,
): Readonly<SourceBlobV1> => Object.freeze({ path, sha256 });

const sourceSet = (
  ...entries: readonly Readonly<SourceBlobV1>[]
): readonly Readonly<SourceBlobV1>[] => Object.freeze(entries);

const SOURCE_BLOBS = Object.freeze({
  reserve: source(
    "supabase/migrations/20260823234000_reserve_ai_polish_v2.sql",
    "79a9f42b08ede44337a2c054cc89d3f25c0285c4940208745232cd968d5f6e1b",
  ),
  reserveTest: source(
    "web/test/db/reserve-v2-route-snapshot.test.ts",
    "dd8b3c394c20e7e04dfdfda760ceeb2b036db060cd64c4205cd2fcfef6662f8c",
  ),
  adapterRegistry: source(
    "web/src/server/polish/adapter-registry.ts",
    "51dacd9e8a2d5721036294c4af609a36415cd47f50a1982f2b13e4deac969b15",
  ),
  adapterRegistryTest: source(
    "web/src/server/polish/adapter-registry.test.ts",
    "757afb31b8ce7773e8570a67ab2240771f194fe311e3e22dfd56ff377b424287",
  ),
  availabilityTest: source(
    "web/src/server/polish/lifecycle-availability.test.ts",
    "43a5d667d37313b428823066f1f0218c11f774d9048e09a2acbd143035a7bbf5",
  ),
  availabilityDbTest: source(
    "web/test/db/ai-polish-availability-v1.test.ts",
    "25efda681c279adcfb18cdce607fb1e045f128c1769bd6f36afd08cb6f5286db",
  ),
  availabilityServer: source(
    "web/src/server/polish/lifecycle-availability.ts",
    "ea09dde773e91f1ec71b6be5894674a6f58cfc877fe452a94f44e87b4317f346",
  ),
  profileRegistry: source(
    "web/src/server/polish/profile-registry.ts",
    "b379ba9f9907360f76ac50c8f676e009d194dadd49707afd24732fc6c9e326b6",
  ),
  profileRegistryTest: source(
    "web/src/server/polish/profile-registry.test.ts",
    "00499529d6dc9cf2f9226d4ac9eef646dac76d8cd876ab225824a62bfc1f9993",
  ),
  executionContractTest: source(
    "web/src/server/polish/ai-runtime-execution-contract-v1.test.ts",
    "c70f74b498ebdd4bb5c423513c926faff06089dfea548dbe07be872a3d340392",
  ),
  providerSubject: source(
    "web/src/server/polish/provider-subject-v2.ts",
    "785281d70c7f4cf42234d13597e9d0b1422dbdcc5ca64dc3addd3bb4f37ffad4",
  ),
  providerSubjectTest: source(
    "web/src/server/polish/provider-subject-v2.test.ts",
    "47eae5f28de31c2ee86b1ad5ed90a83360267f07ab2ded03a570fae5fa459a86",
  ),
  deepseek: source(
    "web/src/server/polish/deepseek.ts",
    "8e92348f8471bb0806bc1a86a66326d697c08f62986e15e85c087b6e34dcdd74",
  ),
  deepseekTest: source(
    "web/src/server/polish/deepseek.test.ts",
    "40627e2935c03c38d6f3978048f5ca19cfda6f0b49d7f82f4159a1fa930d8eae",
  ),
  quota: source(
    "web/src/server/polish/quota.ts",
    "00cfc0bf32b40e7726a8e6426cd20d6fd7af201f824a6cd4610f3c3f54efb271",
  ),
  quotaTest: source(
    "web/src/server/polish/quota-v2.test.ts",
    "b79ea98a972b67fd005091b075e394db65d693eca82ede889fc075270a8cfc3d",
  ),
  handler: source(
    "web/src/server/polish/handler.ts",
    "8fc828a6670a0d0f24a78031408ac6220cd6c524f5f97fd737fafb26cf761c84",
  ),
  handlerTest: source(
    "web/src/server/polish/handler.test.ts",
    "10c5a0923a2fe817a623799e992ee9d647f32af1ab1ef3b813d94e98a37e3fa1",
  ),
  ledgerRequest: source(
    "supabase/migrations/20260823231000_ai_provider_ledger_legal_expand.sql",
    "3df36029fb38b296dbc198d6dd3cc54555cf1fc63b9aa063d72235dd57d47101",
  ),
  ledgerRequestTest: source(
    "web/test/db/provider-ledger-expand.test.ts",
    "8eaf85e09c352b61280638cabfa9459de1feec8016a84544c0188d8138aee087",
  ),
  attemptLedger: source(
    "supabase/migrations/20260823234500_add_ai_provider_attempt_ledger.sql",
    "2f8d70000112b0ef4f0769a7b6f5b04fa594e6d3a129910da759affea316fe52",
  ),
  attemptLedgerTest: source(
    "web/test/db/provider-attempt-schema.test.ts",
    "b74e0d63644e001f0975fab9d1e9e36f4fd56d2e5a712d99fb592ce243cdfb5a",
  ),
  lifecycleV2: source(
    "web/src/server/polish/lifecycle-v2.ts",
    "ee01910e11617bd28f1490538f21b90e5aa3be4e3ed470e4d1e07801029b4e10",
  ),
  lifecycleV2Test: source(
    "web/src/server/polish/__tests__/lifecycle/v2.test.ts",
    "e84c75f1c96c76700d757ce5c52405e49076af5a08e875f5cdcb4b185071d173",
  ),
  attemptComplete: source(
    "supabase/migrations/20260824000000_complete_ai_polish_provider_attempt.sql",
    "d6e9e8f83d56e75333a2d6649d5da7941d55ca4510948467056ba2d85cc56c01",
  ),
  attemptCompleteTest: source(
    "web/test/db/provider-attempt-complete.test.ts",
    "405019a43de2c60f4ebb7019a44a2ad1c343728380b41499f113bd5fbbf254a4",
  ),
  attemptStartTest: source(
    "web/test/db/provider-attempt-start.test.ts",
    "33299870fc394e74ffb00d410d5d701576e9553a650227cc2235b5d0c54bc4ce",
  ),
  attemptFinalizeTest: source(
    "web/test/db/provider-attempt-finalize.test.ts",
    "606161a35db9fed4c2c5e063a8d4999f6271423f13318ccb6a3d6c189a36ec78",
  ),
  attemptReconcile: source(
    "supabase/migrations/20260824001000_secure_reconcile_ai_provider_attempts.sql",
    "18b4e398df8b9915796e7d01ac71f555003d027adc73a6dbd58d0032be2a2dc2",
  ),
  attemptReconcileTest: source(
    "web/test/db/provider-attempt-reconcile.test.ts",
    "20bc28790a1edf9fc4ba94e24797dfa7d3b8f756c95f379582eb7728917d56b2",
  ),
  durableTransmission: source(
    "supabase/migrations/20260824001500_durable_attempt_transmission_quota.sql",
    "0552ee6226e89fdafd2bb6e1b26b3ee588a46df93d3852b0fc125fdea849672a",
  ),
  durableTransmissionTest: source(
    "web/test/db/provider-attempt-transmission.test.ts",
    "d01e166070927e13d68a352f04a57ebf72e3324d08217323037b22d418e1fb12",
  ),
  durableCancellationSequence: source(
    "supabase/migrations/20260824001600_durable_request_cancellation_sequence.sql",
    "f6f2fcf7146529b16357b2b92711390581c8c240accd0b758fbceddf2d35008c",
  ),
  retention: source(
    "supabase/migrations/20260824001000_secure_reconcile_ai_provider_attempts.sql",
    "18b4e398df8b9915796e7d01ac71f555003d027adc73a6dbd58d0032be2a2dc2",
  ),
  retentionTest: source(
    "web/test/db/reconcile-cleanup.test.ts",
    "deb3a02590c3fac78d5fa02ca120bd4eb5ad10a8118d6352c2584649b6d7b4be",
  ),
  orchestrator: source(
    "web/src/server/polish/orchestrator.ts",
    "d7d14dc420629ec6234a373c70ac35d79410605fc18926740badc5127901dba4",
  ),
  orchestratorTest: source(
    "web/src/server/polish/orchestrator.test.ts",
    "eba96c7b6034b71d3e57ec7176026ce55e93df2dcaed28ffd8583bdcab94d61d",
  ),
  scopeBuilder: source(
    "web/src/components/cv-builder/polish/scope-builder.ts",
    "6e971fe30b7ed1d2f2d1e7da4ff8e6047546f32975f4fc24235070106ff37f7e",
  ),
  scopeBuilderTest: source(
    "web/src/components/cv-builder/polish/scope-builder.test.ts",
    "59165cb8531f4fde00f6187c19fcda2d5232b0a9964c813dc1c76ef2550e2396",
  ),
  legalEn: source(
    "web/src/content/legal/en.ts",
    "6ae774d66dcd2a43c9d33c10cb09e55c9eec835e2e5e1952618b9834580caba7",
  ),
  legalTest: source(
    "web/src/content/legal/legal.test.ts",
    "552887a885ac9700e50c48267a9802fea573a2c1463013b48f14d114d01e1a05",
  ),
  flow: source(
    "web/src/components/cv-builder/polish/use-polish-flow.ts",
    "4d7a9fc7507c0fcc8a30f30e5234e623fb17a41f9b7081060d4ca6a25958ad11",
  ),
  routeAssertionTest: source(
    "web/src/components/cv-builder/polish/__tests__/use-polish-flow/route-assertion.test.tsx",
    "1774dfea2839d61c2db3ae592a800cb4f42599055c87a58a476d6d99de53becc",
  ),
  configPhase: source(
    "web/src/components/cv-builder/polish/polish-config-phase.tsx",
    "d06c23f4d0f0cfb4d4af6e773860475148624b7e5ae2c136274f165a1bdc9293",
  ),
  dialogTest: source(
    "web/src/components/cv-builder/polish/polish-dialog.test.tsx",
    "9d2795b58d69506e461df6f135f67b02bacbd6eae3efd81141c23215efc07cae",
  ),
});

const FACT_EVIDENCE_ROUTES: readonly Readonly<FactEvidenceRouteV1>[] =
  Object.freeze([
    Object.freeze({
      factId: "fact.acceptance.authorization.v1",
      implementation: sourceSet(SOURCE_BLOBS.reserve),
      test: sourceSet(SOURCE_BLOBS.reserveTest),
    }),
    Object.freeze({
      factId: "fact.deepseek.adapter.wire.v1",
      implementation: sourceSet(SOURCE_BLOBS.adapterRegistry),
      test: sourceSet(SOURCE_BLOBS.adapterRegistryTest),
    }),
    Object.freeze({
      factId: "fact.deepseek.display.registration.v1",
      implementation: sourceSet(SOURCE_BLOBS.adapterRegistry),
      test: sourceSet(SOURCE_BLOBS.availabilityTest),
    }),
    Object.freeze({
      factId: "fact.deepseek.display.selection.v1",
      implementation: sourceSet(SOURCE_BLOBS.profileRegistry),
      test: sourceSet(
        SOURCE_BLOBS.profileRegistryTest,
        SOURCE_BLOBS.executionContractTest,
      ),
    }),
    Object.freeze({
      factId: "fact.deepseek.endpoint.resolution.v1",
      implementation: sourceSet(SOURCE_BLOBS.adapterRegistry),
      test: sourceSet(SOURCE_BLOBS.adapterRegistryTest),
    }),
    Object.freeze({
      factId: "fact.deepseek.endpoint.selection.v1",
      implementation: sourceSet(SOURCE_BLOBS.profileRegistry),
      test: sourceSet(
        SOURCE_BLOBS.profileRegistryTest,
        SOURCE_BLOBS.executionContractTest,
      ),
    }),
    Object.freeze({
      factId: "fact.deepseek.gateway.service.v1",
      implementation: sourceSet(SOURCE_BLOBS.profileRegistry),
      test: sourceSet(
        SOURCE_BLOBS.profileRegistryTest,
        SOURCE_BLOBS.executionContractTest,
      ),
    }),
    Object.freeze({
      factId: "fact.deepseek.model.selection.v1",
      implementation: sourceSet(SOURCE_BLOBS.profileRegistry),
      test: sourceSet(
        SOURCE_BLOBS.profileRegistryTest,
        SOURCE_BLOBS.executionContractTest,
      ),
    }),
    Object.freeze({
      factId: "fact.deepseek.subject.derivation.v1",
      implementation: sourceSet(SOURCE_BLOBS.providerSubject),
      test: sourceSet(SOURCE_BLOBS.providerSubjectTest),
    }),
    Object.freeze({
      factId: "fact.deepseek.subject.send.v1",
      implementation: sourceSet(SOURCE_BLOBS.deepseek, SOURCE_BLOBS.lifecycleV2),
      test: sourceSet(SOURCE_BLOBS.deepseekTest, SOURCE_BLOBS.lifecycleV2Test),
    }),
    Object.freeze({
      factId: "fact.deepseek.submitted.v1",
      implementation: sourceSet(SOURCE_BLOBS.deepseek, SOURCE_BLOBS.lifecycleV2),
      test: sourceSet(SOURCE_BLOBS.deepseekTest, SOURCE_BLOBS.lifecycleV2Test),
    }),
    Object.freeze({
      factId: "fact.deepseek.wire.selection.v1",
      implementation: sourceSet(SOURCE_BLOBS.profileRegistry),
      test: sourceSet(
        SOURCE_BLOBS.profileRegistryTest,
        SOURCE_BLOBS.executionContractTest,
      ),
    }),
    Object.freeze({
      factId: "fact.material.reaccept.v1",
      implementation: sourceSet(SOURCE_BLOBS.reserve),
      test: sourceSet(SOURCE_BLOBS.reserveTest),
    }),
    Object.freeze({
      factId: "fact.neutral.ledger.v1",
      implementation: sourceSet(
        SOURCE_BLOBS.ledgerRequest,
        SOURCE_BLOBS.attemptLedger,
        SOURCE_BLOBS.durableTransmission,
        SOURCE_BLOBS.durableCancellationSequence,
        SOURCE_BLOBS.quota,
        SOURCE_BLOBS.lifecycleV2,
        SOURCE_BLOBS.handler,
      ),
      test: sourceSet(
        SOURCE_BLOBS.ledgerRequestTest,
        SOURCE_BLOBS.attemptLedgerTest,
        SOURCE_BLOBS.durableTransmissionTest,
        SOURCE_BLOBS.quotaTest,
        SOURCE_BLOBS.lifecycleV2Test,
        SOURCE_BLOBS.handlerTest,
        SOURCE_BLOBS.attemptCompleteTest,
        SOURCE_BLOBS.attemptFinalizeTest,
        SOURCE_BLOBS.attemptReconcileTest,
      ),
    }),
    Object.freeze({
      factId: "fact.neutral.plaintext.v1",
      implementation: sourceSet(SOURCE_BLOBS.deepseek),
      test: sourceSet(SOURCE_BLOBS.deepseekTest),
    }),
    Object.freeze({
      factId: "fact.neutral.quota.v1",
      implementation: sourceSet(
        SOURCE_BLOBS.quota,
        SOURCE_BLOBS.lifecycleV2,
        SOURCE_BLOBS.reserve,
        SOURCE_BLOBS.attemptComplete,
        SOURCE_BLOBS.attemptReconcile,
        SOURCE_BLOBS.durableTransmission,
        SOURCE_BLOBS.durableCancellationSequence,
        SOURCE_BLOBS.handler,
      ),
      test: sourceSet(
        SOURCE_BLOBS.quotaTest,
        SOURCE_BLOBS.lifecycleV2Test,
        SOURCE_BLOBS.reserveTest,
        SOURCE_BLOBS.attemptCompleteTest,
        SOURCE_BLOBS.attemptFinalizeTest,
        SOURCE_BLOBS.attemptReconcileTest,
        SOURCE_BLOBS.durableTransmissionTest,
        SOURCE_BLOBS.handlerTest,
      ),
    }),
    Object.freeze({
      factId: "fact.neutral.retention.v1",
      implementation: sourceSet(SOURCE_BLOBS.retention),
      test: sourceSet(SOURCE_BLOBS.retentionTest),
    }),
    Object.freeze({
      factId: "fact.neutral.retry.v1",
      implementation: sourceSet(
        SOURCE_BLOBS.orchestrator,
        SOURCE_BLOBS.lifecycleV2,
        SOURCE_BLOBS.quota,
        SOURCE_BLOBS.durableCancellationSequence,
      ),
      test: sourceSet(
        SOURCE_BLOBS.orchestratorTest,
        SOURCE_BLOBS.lifecycleV2Test,
        SOURCE_BLOBS.quotaTest,
        SOURCE_BLOBS.attemptStartTest,
        SOURCE_BLOBS.attemptCompleteTest,
        SOURCE_BLOBS.durableTransmissionTest,
      ),
    }),
    Object.freeze({
      factId: "fact.neutral.scope.v1",
      implementation: sourceSet(SOURCE_BLOBS.scopeBuilder, SOURCE_BLOBS.lifecycleV2),
      test: sourceSet(SOURCE_BLOBS.scopeBuilderTest, SOURCE_BLOBS.lifecycleV2Test),
    }),
    Object.freeze({
      factId: "fact.privacy.recipient.deepseek.v1",
      implementation: sourceSet(SOURCE_BLOBS.legalEn),
      test: sourceSet(SOURCE_BLOBS.legalTest),
    }),
    Object.freeze({
      factId: "fact.route.change-gate.v1",
      implementation: sourceSet(SOURCE_BLOBS.reserve),
      test: sourceSet(SOURCE_BLOBS.reserveTest),
    }),
    Object.freeze({
      factId: "fact.route.no-fallback.deepseek.v1",
      implementation: sourceSet(SOURCE_BLOBS.orchestrator, SOURCE_BLOBS.lifecycleV2),
      test: sourceSet(SOURCE_BLOBS.orchestratorTest, SOURCE_BLOBS.lifecycleV2Test),
    }),
    Object.freeze({
      factId: "fact.route.no-selector.v1",
      implementation: sourceSet(SOURCE_BLOBS.configPhase),
      test: sourceSet(SOURCE_BLOBS.dialogTest),
    }),
    Object.freeze({
      factId: "fact.route.readonly.v1",
      implementation: sourceSet(
        SOURCE_BLOBS.reserve,
        SOURCE_BLOBS.availabilityServer,
        SOURCE_BLOBS.flow,
        SOURCE_BLOBS.configPhase,
      ),
      test: sourceSet(
        SOURCE_BLOBS.availabilityDbTest,
        SOURCE_BLOBS.availabilityTest,
        SOURCE_BLOBS.routeAssertionTest,
        SOURCE_BLOBS.dialogTest,
      ),
    }),
  ]);

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    seen.has(value as object)
  ) {
    return value;
  }
  seen.add(value as object);
  for (const key of Reflect.ownKeys(value as object)) {
    deepFreeze(Reflect.get(value as object, key), seen);
  }
  return Object.freeze(value);
}

function evidenceId(
  factId: string,
  authorityKind: RuntimeEvidenceAuthorityKind,
  sourceIndex: number,
): string {
  const authority =
    authorityKind === "service-implementation" ? "implementation" : "test";
  return `runtime-evidence.${factId.slice("fact.".length)}.${authority}.${String(sourceIndex + 1).padStart(2, "0")}.v1`;
}

const REQUIRED_SERVICE_FACTS = deriveRequiredServiceFactPairs(
  new Set([DEEPSEEK_PROFILE_KEY]),
);
const REQUIRED_FACT_BY_ID = new Map(
  REQUIRED_SERVICE_FACTS.map((pair) => [pair.id, pair]),
);

const EVIDENCE = FACT_EVIDENCE_ROUTES.flatMap((route) =>
  ([
    ["service-implementation", route.implementation],
    ["service-test", route.test],
  ] as const).flatMap(([authorityKind, blobs]) =>
    blobs.map((blob, sourceIndex) => {
    const pair = REQUIRED_FACT_BY_ID.get(route.factId);
    if (pair === undefined) {
      throw new Error(`runtime evidence references a non-required fact: ${route.factId}`);
    }
    const descriptor = deepFreeze<ServiceRuntimeEvidenceDescriptorV1>({
      schema_version: "ai_service_runtime_evidence_v1",
      runtime_evidence_id: evidenceId(route.factId, authorityKind, sourceIndex),
      authority_kind: authorityKind,
      supported_fact_id: pair.id,
      supported_fact_sha256: pair.sha256,
      source_repo_path: blob.path,
      source_git_blob_sha256: blob.sha256,
    });
    return deepFreeze<HashedServiceRuntimeEvidenceV1>({
      descriptor,
      sha256: fingerprintLegalDescriptorV1(descriptor).sha256,
    });
    }),
  ),
).sort((left, right) =>
  compareUtf8(
    left.descriptor.runtime_evidence_id,
    right.descriptor.runtime_evidence_id,
  ),
);

const TARGET_DESCRIPTOR = deepFreeze<ServiceRuntimeTargetDescriptorV1>({
  schema_version: "ai_service_runtime_target_v1",
  runtime_target_id: DEEPSEEK_SERVICE_RUNTIME_TARGET_ID,
  profile_key: DEEPSEEK_PROFILE_KEY,
  legal_manifest_id: DEEPSEEK_LEGAL_MANIFEST_ID,
  legal_manifest_sha256:
    LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[DEEPSEEK_LEGAL_MANIFEST_ID],
  route_descriptor_id: DEEPSEEK_ROUTE_DESCRIPTOR_ID,
  route_descriptor_sha256:
    LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[DEEPSEEK_ROUTE_DESCRIPTOR_ID],
});
const TARGET_SHA256 = fingerprintLegalDescriptorV1(TARGET_DESCRIPTOR).sha256;
const EXPECTED_TARGET_SHA256 =
  "aa4948f6f0060a08ada1d0b831babd17c37287be02a9a8f2f9ec69c0f2bed119";
if (TARGET_SHA256 !== EXPECTED_TARGET_SHA256) {
  throw new Error("reviewed DeepSeek runtime target hash drift");
}

const CONTRACT_DESCRIPTOR = deepFreeze<ServiceRuntimeContractDescriptorV1>({
  schema_version: "ai_service_runtime_contract_v1",
  runtime_contract_id: DEEPSEEK_SERVICE_RUNTIME_CONTRACT_ID,
  reviewed_source_commit_oid: DEEPSEEK_REVIEWED_SOURCE_COMMIT_OID,
  legal_bundle_version: INITIAL_LEGAL_BUNDLE_VERSION,
  bundle_contract_sha256:
    LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[INITIAL_LEGAL_BUNDLE_VERSION],
  runtime_target_ids: Object.freeze([
    TARGET_DESCRIPTOR.runtime_target_id,
  ]),
  runtime_target_sha256s: Object.freeze([TARGET_SHA256]),
  service_fact_ids: Object.freeze(
    REQUIRED_SERVICE_FACTS.map((pair) => pair.id),
  ),
  service_fact_sha256s: Object.freeze(
    REQUIRED_SERVICE_FACTS.map((pair) => pair.sha256),
  ),
  runtime_evidence_ids: Object.freeze(
    EVIDENCE.map((item) => item.descriptor.runtime_evidence_id),
  ),
  runtime_evidence_sha256s: Object.freeze(
    EVIDENCE.map((item) => item.sha256),
  ),
});
const CONTRACT_SHA256 = fingerprintLegalDescriptorV1(CONTRACT_DESCRIPTOR).sha256;
const EXPECTED_CONTRACT_SHA256 =
  "229ee6ca2b1ff78c81fc5748f01a285ac5936c1f8f06961c6c339ca808752ca9";
if (CONTRACT_SHA256 !== EXPECTED_CONTRACT_SHA256) {
  throw new Error("reviewed DeepSeek runtime contract hash drift");
}

const RUNTIME_ROUTE_DESCRIPTOR = deepFreeze<RuntimeRouteDescriptorV1>({
  gatewayKind: "direct_deepseek",
  adapterKind: "deepseek_chat_v1",
  wireApiKind: "chat_completions_v1",
  credentialAlias: "deepseek_api_key",
  endpointAlias: "deepseek_official",
  modelId: "deepseek-v4-flash",
  capabilityContractId: "deepseek_chat_json_object_v1",
  cachePolicyId: "deepseek_automatic_context_cache_v1",
  calculatorKind: "linear_token_v1",
  displayDisclosureKey: DEEPSEEK_DISPLAY_DISCLOSURE_KEY,
});

export const DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1 =
  deepFreeze<RuntimeExecutionTargetV1>({
    schemaVersion: "runtime_execution_target_v1",
    runtimeContractId: DEEPSEEK_SERVICE_RUNTIME_CONTRACT_ID,
    runtimeContractSha256: CONTRACT_SHA256,
    legalBundleVersion: INITIAL_LEGAL_BUNDLE_VERSION,
    profileVersionId: DEEPSEEK_PROFILE_VERSION_ID,
    profileKey: DEEPSEEK_PROFILE_KEY,
    legalManifestId: DEEPSEEK_LEGAL_MANIFEST_ID,
    routeDescriptor: RUNTIME_ROUTE_DESCRIPTOR,
  });

const HASHED_TARGET = deepFreeze<HashedServiceRuntimeTargetV1>({
  descriptor: TARGET_DESCRIPTOR,
  sha256: TARGET_SHA256,
  profileVersionId: DEEPSEEK_PROFILE_VERSION_ID,
  executionTarget: DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1,
});

function runtimeTargetSetSha256(
  targets: readonly Readonly<HashedServiceRuntimeTargetV1>[],
): string {
  const bytes = [...targets]
    .sort((left, right) =>
      compareUtf8(
        left.descriptor.runtime_target_id,
        right.descriptor.runtime_target_id,
      ),
    )
    .map(
      (target) =>
        `${Buffer.byteLength(target.descriptor.runtime_target_id, "utf8")}:${target.descriptor.runtime_target_id}:${target.sha256}`,
    )
    .join("\n");
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

const REGISTRY = deepFreeze<ServiceRuntimeContractRegistryV1>({
  schemaVersion: "service_runtime_contract_registry_v1",
  reviewedSourceCommitOid: DEEPSEEK_REVIEWED_SOURCE_COMMIT_OID,
  legalBundleVersion: INITIAL_LEGAL_BUNDLE_VERSION,
  bundleContractSha256:
    LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[INITIAL_LEGAL_BUNDLE_VERSION],
  requiredServiceFacts: REQUIRED_SERVICE_FACTS,
  evidence: EVIDENCE,
  targets: Object.freeze([HASHED_TARGET]),
  contract: CONTRACT_DESCRIPTOR,
  contractSha256: CONTRACT_SHA256,
  runtimeTargetSetSha256: runtimeTargetSetSha256([HASHED_TARGET]),
});
const EXPECTED_TARGET_SET_SHA256 =
  "5b7f5f2cd9d21c3c7409f02d7b65eda03999309c0ba3939e50fb81caca2c9340";
if (REGISTRY.runtimeTargetSetSha256 !== EXPECTED_TARGET_SET_SHA256) {
  throw new Error("reviewed DeepSeek runtime target-set hash drift");
}

function fail(message: string): never {
  throw new Error(`invalid DeepSeek service runtime contract: ${message}`);
}

function assertPlainRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail(`${label} contains a symbol key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      fail(`${label}.${key} must be an own data property`);
    }
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Reflect.ownKeys(value);
  const expected = new Set(keys);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !expected.has(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    fail(`${label} keys do not match the frozen schema`);
  }
}

function assertExactArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${label} must be an exact array`);
  }
  const expected = new Set([
    "length",
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !expected.has(key)) {
      fail(`${label} contains an extra array property`);
    }
    if (key !== "length") {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        fail(`${label}.${key} must be an own data property`);
      }
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, String(index))) {
      fail(`${label} contains a sparse index`);
    }
  }
}

function assertDeepFrozen(
  value: unknown,
  label: string,
  seen = new WeakSet<object>(),
): void {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return;
  }
  if (seen.has(value as object)) fail(`${label} contains a cycle`);
  seen.add(value as object);
  if (!Object.isFrozen(value)) fail(`${label} must be deeply frozen`);
  for (const key of Reflect.ownKeys(value as object)) {
    assertDeepFrozen(Reflect.get(value as object, key), `${label}.${String(key)}`, seen);
  }
  seen.delete(value as object);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function requireHash(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!LOWER_HEX_64.test(result)) fail(`${label} must be lowercase hex-64`);
  return result;
}

function requireStringArray(value: unknown, label: string): readonly string[] {
  assertExactArray(value, label);
  return value.map((item, index) => requireString(item, `${label}.${index}`));
}

function assertSameStrings(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    fail(`${label} does not match the frozen authority`);
  }
}

function assertExactReviewedValue(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      fail(`${label} does not match the frozen reviewed tuple`);
    }
    for (let index = 0; index < expected.length; index += 1) {
      assertExactReviewedValue(actual[index], expected[index], `${label}.${index}`);
    }
    return;
  }
  if (typeof expected === "object" && expected !== null) {
    assertPlainRecord(actual, label);
    assertPlainRecord(expected, `${label} authority`);
    const expectedKeys = Reflect.ownKeys(expected);
    if (
      Reflect.ownKeys(actual).length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.hasOwn(actual, key))
    ) {
      fail(`${label} keys do not match the frozen reviewed tuple`);
    }
    for (const key of expectedKeys) {
      if (typeof key !== "string") fail(`${label} authority contains a symbol key`);
      assertExactReviewedValue(actual[key], expected[key], `${label}.${key}`);
    }
    return;
  }
  if (actual !== expected) fail(`${label} does not match the frozen reviewed tuple`);
}

function assertSortedUnique(values: readonly string[], label: string): void {
  if (
    values.some(
      (value, index) =>
        index > 0 && compareUtf8(values[index - 1], value) >= 0,
    )
  ) {
    fail(`${label} must be C/UTF-8 sorted and unique`);
  }
}

function assertPortableEvidencePath(path: string): void {
  if (
    !PORTABLE_REPO_PATH.test(path) ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) =>
      segment === "" || segment === "." || segment === ".."
    ) ||
    /^[A-Za-z]:/u.test(path) ||
    path.startsWith("//")
  ) {
    fail("evidence source path is not portable repo-relative ASCII");
  }
  if (
    path === "web/src/server/polish/service-runtime-contract-v1.ts" ||
    path === "web/src/server/polish/service-runtime-contract-v1.test.ts" ||
    path === "web/src/server/polish/handler-runtime-authority.ts" ||
    path === "web/src/server/polish/handler-runtime-authority.test.ts"
  ) {
    fail("evidence cannot cite the attestation or its future binding files");
  }
}

function validateExecutionTarget(
  value: unknown,
  contractSha256: string,
): asserts value is RuntimeExecutionTargetV1 {
  assertPlainRecord(value, "execution target");
  assertExactKeys(value, EXECUTION_TARGET_KEYS, "execution target");
  if (
    value.schemaVersion !== "runtime_execution_target_v1" ||
    value.runtimeContractId !== DEEPSEEK_SERVICE_RUNTIME_CONTRACT_ID ||
    value.runtimeContractSha256 !== contractSha256 ||
    value.legalBundleVersion !== INITIAL_LEGAL_BUNDLE_VERSION ||
    value.profileVersionId !== DEEPSEEK_PROFILE_VERSION_ID ||
    value.profileKey !== DEEPSEEK_PROFILE_KEY ||
    value.legalManifestId !== DEEPSEEK_LEGAL_MANIFEST_ID
  ) {
    fail("execution target identity does not match the reviewed DeepSeek pair");
  }
  assertPlainRecord(value.routeDescriptor, "execution target route descriptor");
  assertExactKeys(
    value.routeDescriptor,
    RUNTIME_ROUTE_DESCRIPTOR_KEYS,
    "execution target route descriptor",
  );
  for (const key of RUNTIME_ROUTE_DESCRIPTOR_KEYS) {
    if (value.routeDescriptor[key] !== RUNTIME_ROUTE_DESCRIPTOR[key]) {
      fail(`execution target route descriptor ${key} drifted`);
    }
  }
}

export function validateServiceRuntimeContractV1Registry(
  input: unknown,
): asserts input is ServiceRuntimeContractRegistryV1 {
  assertPlainRecord(input, "registry");
  assertExactKeys(input, SERVICE_RUNTIME_REGISTRY_KEYS, "registry");
  assertDeepFrozen(input, "registry");
  if (
    input.schemaVersion !== "service_runtime_contract_registry_v1" ||
    input.reviewedSourceCommitOid !== DEEPSEEK_REVIEWED_SOURCE_COMMIT_OID ||
    input.legalBundleVersion !== INITIAL_LEGAL_BUNDLE_VERSION ||
    input.bundleContractSha256 !==
      LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[INITIAL_LEGAL_BUNDLE_VERSION]
  ) {
    fail("registry root identity does not match the reviewed source and legal bundle");
  }

  const bundleHash = fingerprintLegalDescriptorV1(
    LEGAL_FINGERPRINT_V1_DESCRIPTORS.bundleContract,
  ).sha256;
  if (bundleHash !== input.bundleContractSha256) {
    fail("legal bundle descriptor does not resolve to the reviewed root hash");
  }

  assertExactArray(input.requiredServiceFacts, "required service facts");
  const requiredPairs = input.requiredServiceFacts.map((item, index) => {
    assertPlainRecord(item, `required service facts.${index}`);
    assertExactKeys(item, FACT_PAIR_KEYS, `required service facts.${index}`);
    return {
      id: requireString(item.id, `required service facts.${index}.id`),
      sha256: requireHash(
        item.sha256,
        `required service facts.${index}.sha256`,
      ),
    };
  });
  const derivedPairs = deriveRequiredServiceFactPairs(
    new Set([DEEPSEEK_PROFILE_KEY]),
  );
  assertSameStrings(
    requiredPairs.map((pair) => pair.id),
    derivedPairs.map((pair) => pair.id),
    "required service fact IDs",
  );
  assertSameStrings(
    requiredPairs.map((pair) => pair.sha256),
    derivedPairs.map((pair) => pair.sha256),
    "required service fact hashes",
  );
  assertSortedUnique(
    requiredPairs.map((pair) => pair.id),
    "required service fact IDs",
  );
  const legalFacts = new Map(
    LEGAL_FINGERPRINT_V1_DESCRIPTORS.facts.map((fact) => [fact.fact_id, fact]),
  );
  for (const pair of requiredPairs) {
    const fact = legalFacts.get(pair.id);
    if (
      fact === undefined ||
      fact.authority_class !== "service-operational" ||
      (fact.operational_scope !== "global" &&
        fact.operational_scope !== `profile:${DEEPSEEK_PROFILE_KEY}`) ||
      fingerprintLegalDescriptorV1(fact).sha256 !== pair.sha256
    ) {
      fail(`required service fact does not resolve: ${pair.id}`);
    }
  }

  assertExactArray(input.evidence, "evidence");
  const evidenceIds: string[] = [];
  const evidenceHashes: string[] = [];
  const authorities = new Map(
    requiredPairs.map((pair) => [pair.id, new Set<RuntimeEvidenceAuthorityKind>()]),
  );
  const immutableIds = new Map<string, string>();
  for (const [index, item] of input.evidence.entries()) {
    assertPlainRecord(item, `evidence.${index}`);
    assertExactKeys(item, HASHED_EVIDENCE_KEYS, `evidence.${index}`);
    assertPlainRecord(item.descriptor, `evidence.${index}.descriptor`);
    assertExactKeys(
      item.descriptor,
      EVIDENCE_DESCRIPTOR_KEYS,
      `evidence.${index}.descriptor`,
    );
    if (item.descriptor.schema_version !== "ai_service_runtime_evidence_v1") {
      fail(`evidence.${index} schema is invalid`);
    }
    const id = requireString(
      item.descriptor.runtime_evidence_id,
      `evidence.${index}.id`,
    );
    const hash = requireHash(item.sha256, `evidence.${index}.sha256`);
    const factId = requireString(
      item.descriptor.supported_fact_id,
      `evidence.${index}.fact`,
    );
    const factPair = requiredPairs.find((pair) => pair.id === factId);
    if (
      factPair === undefined ||
      item.descriptor.supported_fact_sha256 !== factPair.sha256
    ) {
      fail(`evidence.${index} supports an unresolved fact pair`);
    }
    if (
      item.descriptor.authority_kind !== "service-implementation" &&
      item.descriptor.authority_kind !== "service-test"
    ) {
      fail(`evidence.${index} uses a forbidden authority kind`);
    }
    assertPortableEvidencePath(
      requireString(
        item.descriptor.source_repo_path,
        `evidence.${index}.source path`,
      ),
    );
    requireHash(
      item.descriptor.source_git_blob_sha256,
      `evidence.${index}.source blob`,
    );
    if (fingerprintLegalDescriptorV1(item.descriptor).sha256 !== hash) {
      fail(`evidence.${index} descriptor hash does not match`);
    }
    if (immutableIds.has(id)) fail(`duplicate or rebound evidence ID: ${id}`);
    immutableIds.set(id, hash);
    evidenceIds.push(id);
    evidenceHashes.push(hash);
    authorities.get(factId)!.add(item.descriptor.authority_kind);
  }
  assertSortedUnique(evidenceIds, "runtime evidence IDs");
  for (const [factId, actual] of authorities) {
    if (
      !actual.has("service-implementation") ||
      !actual.has("service-test")
    ) {
      fail(`${factId} lacks implementation and test evidence`);
    }
  }

  assertExactArray(input.targets, "targets");
  if (input.targets.length !== 1) fail("initial registry must contain one target");
  const target = input.targets[0];
  assertPlainRecord(target, "targets.0");
  assertExactKeys(target, HASHED_TARGET_KEYS, "targets.0");
  assertPlainRecord(target.descriptor, "targets.0.descriptor");
  assertExactKeys(target.descriptor, TARGET_DESCRIPTOR_KEYS, "targets.0.descriptor");
  if (
    target.descriptor.schema_version !== "ai_service_runtime_target_v1" ||
    target.descriptor.runtime_target_id !== DEEPSEEK_SERVICE_RUNTIME_TARGET_ID ||
    target.descriptor.profile_key !== DEEPSEEK_PROFILE_KEY ||
    target.descriptor.legal_manifest_id !== DEEPSEEK_LEGAL_MANIFEST_ID ||
    target.descriptor.legal_manifest_sha256 !==
      LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[DEEPSEEK_LEGAL_MANIFEST_ID] ||
    target.descriptor.route_descriptor_id !== DEEPSEEK_ROUTE_DESCRIPTOR_ID ||
    target.descriptor.route_descriptor_sha256 !==
      LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[DEEPSEEK_ROUTE_DESCRIPTOR_ID] ||
    target.profileVersionId !== DEEPSEEK_PROFILE_VERSION_ID
  ) {
    fail("runtime target does not resolve to the reviewed profile/legal route");
  }
  const targetHash = requireHash(target.sha256, "targets.0.sha256");
  if (fingerprintLegalDescriptorV1(target.descriptor).sha256 !== targetHash) {
    fail("runtime target descriptor hash does not match");
  }
  if (immutableIds.has(target.descriptor.runtime_target_id)) {
    fail("runtime target ID collides with another immutable descriptor");
  }
  immutableIds.set(target.descriptor.runtime_target_id, targetHash);

  const legalManifest = LEGAL_FINGERPRINT_V1_DESCRIPTORS.manifests.find(
    (manifest) => manifest.manifest_id === DEEPSEEK_LEGAL_MANIFEST_ID,
  );
  const legalRoute = LEGAL_FINGERPRINT_V1_DESCRIPTORS.routes.find(
    (route) => route.route_descriptor_id === DEEPSEEK_ROUTE_DESCRIPTOR_ID,
  );
  const profileMapping = LEGAL_FINGERPRINT_V1_PROFILE_MAPPING.find(
    (mapping) => mapping.profileKey === DEEPSEEK_PROFILE_KEY,
  );
  if (
    legalManifest === undefined ||
    legalRoute === undefined ||
    profileMapping === undefined ||
    fingerprintLegalDescriptorV1(legalManifest).sha256 !==
      target.descriptor.legal_manifest_sha256 ||
    fingerprintLegalDescriptorV1(legalRoute).sha256 !==
      target.descriptor.route_descriptor_sha256 ||
    profileMapping.manifestId !== target.descriptor.legal_manifest_id ||
    profileMapping.routeDescriptorId !== target.descriptor.route_descriptor_id
  ) {
    fail("runtime target legal references do not close");
  }

  const contractSha256 = requireHash(input.contractSha256, "contract SHA-256");
  validateExecutionTarget(target.executionTarget, contractSha256);
  const profile = resolveProfile(DEEPSEEK_PROFILE_KEY);
  for (const key of RUNTIME_ROUTE_DESCRIPTOR_KEYS) {
    if (target.executionTarget.routeDescriptor[key] !== profile[key]) {
      fail(`execution target does not match profile registry field ${key}`);
    }
  }

  assertPlainRecord(input.contract, "contract");
  assertExactKeys(input.contract, CONTRACT_DESCRIPTOR_KEYS, "contract");
  if (
    input.contract.schema_version !== "ai_service_runtime_contract_v1" ||
    input.contract.runtime_contract_id !== DEEPSEEK_SERVICE_RUNTIME_CONTRACT_ID ||
    input.contract.reviewed_source_commit_oid !== input.reviewedSourceCommitOid ||
    input.contract.legal_bundle_version !== input.legalBundleVersion ||
    input.contract.bundle_contract_sha256 !== input.bundleContractSha256
  ) {
    fail("runtime contract root identity is invalid");
  }
  const targetIds = requireStringArray(
    input.contract.runtime_target_ids,
    "contract target IDs",
  );
  const targetHashes = requireStringArray(
    input.contract.runtime_target_sha256s,
    "contract target hashes",
  ).map((hash, index) => requireHash(hash, `contract target hashes.${index}`));
  const serviceFactIds = requireStringArray(
    input.contract.service_fact_ids,
    "contract fact IDs",
  );
  const serviceFactHashes = requireStringArray(
    input.contract.service_fact_sha256s,
    "contract fact hashes",
  ).map((hash, index) => requireHash(hash, `contract fact hashes.${index}`));
  const rootEvidenceIds = requireStringArray(
    input.contract.runtime_evidence_ids,
    "contract evidence IDs",
  );
  const rootEvidenceHashes = requireStringArray(
    input.contract.runtime_evidence_sha256s,
    "contract evidence hashes",
  ).map((hash, index) => requireHash(hash, `contract evidence hashes.${index}`));
  assertSameStrings(targetIds, [target.descriptor.runtime_target_id], "contract targets");
  assertSameStrings(targetHashes, [targetHash], "contract target hashes");
  assertSameStrings(
    serviceFactIds,
    requiredPairs.map((pair) => pair.id),
    "contract facts",
  );
  assertSameStrings(
    serviceFactHashes,
    requiredPairs.map((pair) => pair.sha256),
    "contract fact hashes",
  );
  assertSameStrings(rootEvidenceIds, evidenceIds, "contract evidence");
  assertSameStrings(rootEvidenceHashes, evidenceHashes, "contract evidence hashes");
  assertSortedUnique(targetIds, "contract target IDs");
  assertSortedUnique(serviceFactIds, "contract fact IDs");
  assertSortedUnique(rootEvidenceIds, "contract evidence IDs");
  if (fingerprintLegalDescriptorV1(input.contract).sha256 !== contractSha256) {
    fail("runtime contract root hash does not match");
  }
  if (
    requireHash(input.runtimeTargetSetSha256, "runtime target-set hash") !==
    runtimeTargetSetSha256([
      target as unknown as Readonly<HashedServiceRuntimeTargetV1>,
    ])
  ) {
    fail("runtime target-set hash does not match the DB formula");
  }

  // Structural/hash validation above establishes a sound candidate. This last
  // comparison is intentionally stricter: callers may validate only the one
  // reviewed authority, never a coherent re-sign of a different source path,
  // descriptor ID, target, root, order, or evidence cardinality.
  assertExactReviewedValue(input, REGISTRY, "registry");
}

validateServiceRuntimeContractV1Registry(REGISTRY);

export const DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1 = REGISTRY;
export const DEEPSEEK_SERVICE_RUNTIME_TARGET_V1_SHA256 = TARGET_SHA256;
export const DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1_SHA256 = CONTRACT_SHA256;
export const DEEPSEEK_SERVICE_RUNTIME_TARGET_SET_V1_SHA256 =
  REGISTRY.runtimeTargetSetSha256;

export const DEEPSEEK_RUNTIME_CONTRACT_DB_FIXTURE_V1 = deepFreeze({
  schemaVersion: "service_runtime_contract_db_fixture_v1" as const,
  contract: {
    runtimeContractId: DEEPSEEK_SERVICE_RUNTIME_CONTRACT_ID,
    runtimeContractSha256: CONTRACT_SHA256,
    reviewedSourceCommitOid: DEEPSEEK_REVIEWED_SOURCE_COMMIT_OID,
    legalBundleVersion: INITIAL_LEGAL_BUNDLE_VERSION,
    bundleContractSha256:
      LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[INITIAL_LEGAL_BUNDLE_VERSION],
    runtimeTargetSetSha256: REGISTRY.runtimeTargetSetSha256,
  },
  targets: [
    {
      runtimeTargetId: DEEPSEEK_SERVICE_RUNTIME_TARGET_ID,
      runtimeTargetSha256: TARGET_SHA256,
      profileVersionId: DEEPSEEK_PROFILE_VERSION_ID,
      profileKey: DEEPSEEK_PROFILE_KEY,
      legalManifestId: DEEPSEEK_LEGAL_MANIFEST_ID,
      manifestSha256:
        LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[DEEPSEEK_LEGAL_MANIFEST_ID],
      routeDescriptorId: DEEPSEEK_ROUTE_DESCRIPTOR_ID,
      routeDescriptorSha256:
        LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[DEEPSEEK_ROUTE_DESCRIPTOR_ID],
    },
  ],
});

function exactRuntimeTargetMatches(value: unknown): boolean {
  try {
    validateExecutionTarget(value, CONTRACT_SHA256);
    const target = value as RuntimeExecutionTargetV1;
    for (const key of RUNTIME_ROUTE_DESCRIPTOR_KEYS) {
      if (target.routeDescriptor[key] !== RUNTIME_ROUTE_DESCRIPTOR[key]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export const DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1: RuntimeTargetResolverV1 =
  exactRuntimeTargetMatches;
