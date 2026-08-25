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
  "sha1:9fef6614b71ec420df303025e73f4b6b6580460f" as const;

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
  readonly implementation: SourceBlobV1;
  readonly test: SourceBlobV1;
}

const source = (
  path: string,
  sha256: string,
): Readonly<SourceBlobV1> => Object.freeze({ path, sha256 });

const SOURCE_BLOBS = Object.freeze({
  reserve: source(
    "supabase/migrations/20260823234000_reserve_ai_polish_v2.sql",
    "79a9f42b08ede44337a2c054cc89d3f25c0285c4940208745232cd968d5f6e1b",
  ),
  reserveTest: source(
    "web/test/db/reserve-v2-route-snapshot.test.ts",
    "d451ddb008bc16e3797c386fa542945a14385fb43db10fbdf3f86a220c1ecad1",
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
  profileRegistry: source(
    "web/src/server/polish/profile-registry.ts",
    "b379ba9f9907360f76ac50c8f676e009d194dadd49707afd24732fc6c9e326b6",
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
    "2d0315146a262fb3bdb9cd926cb70ec3943b1163c185391ac8a5b7f10c8e79fe",
  ),
  quotaTest: source(
    "web/src/server/polish/quota-v2.test.ts",
    "6e10e3087145010c9dd5565d67488a3368068818c8b87f8ec5787eb789b0ceb3",
  ),
  ledger: source(
    "supabase/migrations/20260823231000_ai_provider_ledger_legal_expand.sql",
    "3df36029fb38b296dbc198d6dd3cc54555cf1fc63b9aa063d72235dd57d47101",
  ),
  ledgerTest: source(
    "web/test/db/provider-ledger-expand.test.ts",
    "8eaf85e09c352b61280638cabfa9459de1feec8016a84544c0188d8138aee087",
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
    "09d6d5fff3bc8f772744088af386ed1096860ba8c5321b79bd0aee5c91762bfe",
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
      implementation: SOURCE_BLOBS.reserve,
      test: SOURCE_BLOBS.reserveTest,
    }),
    Object.freeze({
      factId: "fact.deepseek.adapter.wire.v1",
      implementation: SOURCE_BLOBS.adapterRegistry,
      test: SOURCE_BLOBS.adapterRegistryTest,
    }),
    Object.freeze({
      factId: "fact.deepseek.display.registration.v1",
      implementation: SOURCE_BLOBS.adapterRegistry,
      test: SOURCE_BLOBS.availabilityTest,
    }),
    Object.freeze({
      factId: "fact.deepseek.display.selection.v1",
      implementation: SOURCE_BLOBS.profileRegistry,
      test: SOURCE_BLOBS.executionContractTest,
    }),
    Object.freeze({
      factId: "fact.deepseek.endpoint.resolution.v1",
      implementation: SOURCE_BLOBS.adapterRegistry,
      test: SOURCE_BLOBS.adapterRegistryTest,
    }),
    Object.freeze({
      factId: "fact.deepseek.endpoint.selection.v1",
      implementation: SOURCE_BLOBS.profileRegistry,
      test: SOURCE_BLOBS.executionContractTest,
    }),
    Object.freeze({
      factId: "fact.deepseek.gateway.service.v1",
      implementation: SOURCE_BLOBS.profileRegistry,
      test: SOURCE_BLOBS.executionContractTest,
    }),
    Object.freeze({
      factId: "fact.deepseek.model.selection.v1",
      implementation: SOURCE_BLOBS.profileRegistry,
      test: SOURCE_BLOBS.executionContractTest,
    }),
    Object.freeze({
      factId: "fact.deepseek.subject.derivation.v1",
      implementation: SOURCE_BLOBS.providerSubject,
      test: SOURCE_BLOBS.providerSubjectTest,
    }),
    Object.freeze({
      factId: "fact.deepseek.subject.send.v1",
      implementation: SOURCE_BLOBS.deepseek,
      test: SOURCE_BLOBS.deepseekTest,
    }),
    Object.freeze({
      factId: "fact.deepseek.submitted.v1",
      implementation: SOURCE_BLOBS.deepseek,
      test: SOURCE_BLOBS.deepseekTest,
    }),
    Object.freeze({
      factId: "fact.deepseek.wire.selection.v1",
      implementation: SOURCE_BLOBS.profileRegistry,
      test: SOURCE_BLOBS.executionContractTest,
    }),
    Object.freeze({
      factId: "fact.material.reaccept.v1",
      implementation: SOURCE_BLOBS.reserve,
      test: SOURCE_BLOBS.reserveTest,
    }),
    Object.freeze({
      factId: "fact.neutral.ledger.v1",
      implementation: SOURCE_BLOBS.ledger,
      test: SOURCE_BLOBS.ledgerTest,
    }),
    Object.freeze({
      factId: "fact.neutral.plaintext.v1",
      implementation: SOURCE_BLOBS.deepseek,
      test: SOURCE_BLOBS.deepseekTest,
    }),
    Object.freeze({
      factId: "fact.neutral.quota.v1",
      implementation: SOURCE_BLOBS.quota,
      test: SOURCE_BLOBS.quotaTest,
    }),
    Object.freeze({
      factId: "fact.neutral.retention.v1",
      implementation: SOURCE_BLOBS.retention,
      test: SOURCE_BLOBS.retentionTest,
    }),
    Object.freeze({
      factId: "fact.neutral.retry.v1",
      implementation: SOURCE_BLOBS.orchestrator,
      test: SOURCE_BLOBS.orchestratorTest,
    }),
    Object.freeze({
      factId: "fact.neutral.scope.v1",
      implementation: SOURCE_BLOBS.scopeBuilder,
      test: SOURCE_BLOBS.scopeBuilderTest,
    }),
    Object.freeze({
      factId: "fact.privacy.recipient.deepseek.v1",
      implementation: SOURCE_BLOBS.legalEn,
      test: SOURCE_BLOBS.legalTest,
    }),
    Object.freeze({
      factId: "fact.route.change-gate.v1",
      implementation: SOURCE_BLOBS.flow,
      test: SOURCE_BLOBS.routeAssertionTest,
    }),
    Object.freeze({
      factId: "fact.route.no-fallback.deepseek.v1",
      implementation: SOURCE_BLOBS.orchestrator,
      test: SOURCE_BLOBS.orchestratorTest,
    }),
    Object.freeze({
      factId: "fact.route.no-selector.v1",
      implementation: SOURCE_BLOBS.configPhase,
      test: SOURCE_BLOBS.dialogTest,
    }),
    Object.freeze({
      factId: "fact.route.readonly.v1",
      implementation: SOURCE_BLOBS.configPhase,
      test: SOURCE_BLOBS.dialogTest,
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
): string {
  const authority =
    authorityKind === "service-implementation" ? "implementation" : "test";
  return `runtime-evidence.${factId.slice("fact.".length)}.${authority}.v1`;
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
  ] as const).map(([authorityKind, blob]) => {
    const pair = REQUIRED_FACT_BY_ID.get(route.factId);
    if (pair === undefined) {
      throw new Error(`runtime evidence references a non-required fact: ${route.factId}`);
    }
    const descriptor = deepFreeze<ServiceRuntimeEvidenceDescriptorV1>({
      schema_version: "ai_service_runtime_evidence_v1",
      runtime_evidence_id: evidenceId(route.factId, authorityKind),
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
).sort((left, right) =>
  compareUtf8(
    left.descriptor.runtime_evidence_id,
    right.descriptor.runtime_evidence_id,
  ),
);

const EXPECTED_RUNTIME_EVIDENCE_SHA256 = Object.freeze({
  "runtime-evidence.acceptance.authorization.v1.implementation.v1":
    "5e510bd592b1f032d93255bf4d967c29c2dc94d56f737e8382f465946298f557",
  "runtime-evidence.acceptance.authorization.v1.test.v1":
    "c0f5be9749f68ecc468b566a086a571b02bab152c49093969cc949cd5521681b",
  "runtime-evidence.deepseek.adapter.wire.v1.implementation.v1":
    "b0337d2f1c667bec19f76d6f0c6f5e1640351e584781702fd7468640504c93c9",
  "runtime-evidence.deepseek.adapter.wire.v1.test.v1":
    "c3f7ba4ad5f48d178e6ca0dfb5a551f11f253ac5d992885481d985bcbc0d8003",
  "runtime-evidence.deepseek.display.registration.v1.implementation.v1":
    "58009824f216005c5c8ff2ce6f4d01736f55d9eb66b3fd5ed5cbdb8b40e393fd",
  "runtime-evidence.deepseek.display.registration.v1.test.v1":
    "8d83dae6698541ba36fcec836db860b685a58ae74eb4dc2ac79850d0017fb58d",
  "runtime-evidence.deepseek.display.selection.v1.implementation.v1":
    "7c9a2f214a573eaa1228e7de9c4a2c6b728622eeb2dd978bc76cded5c8b6d818",
  "runtime-evidence.deepseek.display.selection.v1.test.v1":
    "e0ce7f048c56be39a77fc16e08e877465059e9a8784a170e93a43cf7af0ed14f",
  "runtime-evidence.deepseek.endpoint.resolution.v1.implementation.v1":
    "27a9640ef0a6d77811fdbf3ca22467498b5873bc653f11ebcc16a11e928b3bc7",
  "runtime-evidence.deepseek.endpoint.resolution.v1.test.v1":
    "a8e97f34326963faeda44e5ee5bf1f5d9c6e00a065998e2e325be104b2bd7a86",
  "runtime-evidence.deepseek.endpoint.selection.v1.implementation.v1":
    "8ba4d9bcf7951fef86e1028e8c5ba02663ee1387a0bcab8c01e727d5543ae004",
  "runtime-evidence.deepseek.endpoint.selection.v1.test.v1":
    "f5b6f3e5f2f4dc91f637892e2358c47ec7b416a72c75d4f11300f78bb79998c1",
  "runtime-evidence.deepseek.gateway.service.v1.implementation.v1":
    "5555341712668235d96b213666d3794f10cbe5e6e770f1df498f200556ec102b",
  "runtime-evidence.deepseek.gateway.service.v1.test.v1":
    "3be408e1b07c3b392cd329516b82279121b26495c5f93baaee1750dcddde1de7",
  "runtime-evidence.deepseek.model.selection.v1.implementation.v1":
    "4c178ed80ba446be13d12bc31fe1fe84884c8c00377c622f7f72000109e2530c",
  "runtime-evidence.deepseek.model.selection.v1.test.v1":
    "63f4b20861873b7ec7d232a0131f13cc349aa39dc68db001e04b644b610d9d15",
  "runtime-evidence.deepseek.subject.derivation.v1.implementation.v1":
    "9b50bd24eaecb5157b691672af0ec3165bf86586bcd8869f9e5d8b5a8fd4d740",
  "runtime-evidence.deepseek.subject.derivation.v1.test.v1":
    "4d6b6b99c8775d08f6503df0043e57f3828032fbfad1353f099dc9b9f38cf611",
  "runtime-evidence.deepseek.subject.send.v1.implementation.v1":
    "0e757c7d1c9b1f0570b4cdf59fd089f35199c61162da04acee1ef428782fa7c4",
  "runtime-evidence.deepseek.subject.send.v1.test.v1":
    "56cddc315cd174748c8df56754e4f10dab081ff2fbed195a4409c088d4a6e044",
  "runtime-evidence.deepseek.submitted.v1.implementation.v1":
    "2b4c22cb9d0ee54fc8d862df54f76cbc0e7c1ea04e05c24aae769b525e7419a7",
  "runtime-evidence.deepseek.submitted.v1.test.v1":
    "23b6ee356cfa066b0318d3128d9262a4509b96dccbb707139a113ab60bf6afb2",
  "runtime-evidence.deepseek.wire.selection.v1.implementation.v1":
    "cdeb18f16e11755a82c160a6c837b881eed8b9ece31a8f4a9dca4a2b2fc23fe4",
  "runtime-evidence.deepseek.wire.selection.v1.test.v1":
    "a9d4c8c305397728fc009c963e359560bc4821b1c97db49fc380dc92361f972f",
  "runtime-evidence.material.reaccept.v1.implementation.v1":
    "f19f9072a5291d5946372a455c6dc246f0ed8e1f92fda0a0e090f2b257256cd2",
  "runtime-evidence.material.reaccept.v1.test.v1":
    "64479c23783fb7e6ec767c05ee2a0e71be4860af845d251e66a44d9198c08990",
  "runtime-evidence.neutral.ledger.v1.implementation.v1":
    "f94d45fa2f91f2b734bf30c73810a0c7e2791a1d9803f7d38820e52eec36085e",
  "runtime-evidence.neutral.ledger.v1.test.v1":
    "ebacde90e8f1c478ad2872efdad217ddf889c842fb9c9aa2c2e0052f815b3302",
  "runtime-evidence.neutral.plaintext.v1.implementation.v1":
    "cba613e5804455bc2c526fe69e85527b5af1c3ca89ee4a12e370f01520d8ac5e",
  "runtime-evidence.neutral.plaintext.v1.test.v1":
    "5e97f83792a283a40eeedf3245d077952f3d752b101d22ab59916b62e19f2d96",
  "runtime-evidence.neutral.quota.v1.implementation.v1":
    "4fb0d50e9fe7ab046122c3294d5691e8986b037498ad4ad46b092da55cae679c",
  "runtime-evidence.neutral.quota.v1.test.v1":
    "4feb992c83f68deb963c9641fe7bff923f89fa0aafdaf1c4b11041a01cebb86b",
  "runtime-evidence.neutral.retention.v1.implementation.v1":
    "491f5a5f3399222c458b1115ad5679f42260b40171a773fdb55f44f728cee553",
  "runtime-evidence.neutral.retention.v1.test.v1":
    "cd98d40ebae3e88a244396dd5978591f6aea11c4ca188ba315371255e3219814",
  "runtime-evidence.neutral.retry.v1.implementation.v1":
    "59c5b8bcaf9bf863a0bc27c98cdbb27954573ee86545dbb57ca9b8507e9b0f9b",
  "runtime-evidence.neutral.retry.v1.test.v1":
    "1f2abeb489b6714574e9930df0a000167d474601144f725a7403e80ceadb05c9",
  "runtime-evidence.neutral.scope.v1.implementation.v1":
    "9e96cd0ffe2474d530fe3d0d31bf3d907020deb5f886fd0165c9b58130d1126a",
  "runtime-evidence.neutral.scope.v1.test.v1":
    "e508d2498783be96d0c1f157a1870a13b939ea3b74b31baa26918dd1179743d4",
  "runtime-evidence.privacy.recipient.deepseek.v1.implementation.v1":
    "edc9ce05f42505b3754d7850e16a0de48273d1249b3383e60fb974d909baed05",
  "runtime-evidence.privacy.recipient.deepseek.v1.test.v1":
    "f45075671f1cfa2828aeb74fa3488366fee1d9145bbd1b335d828378dbe57640",
  "runtime-evidence.route.change-gate.v1.implementation.v1":
    "6fd4bd6cfc72c275851266d1135724d7d8ea9c444e55e42cac04cadd294c25e1",
  "runtime-evidence.route.change-gate.v1.test.v1":
    "228899834e402630f89939284d577751683127759f11f0de0b0f0b7f0107cd39",
  "runtime-evidence.route.no-fallback.deepseek.v1.implementation.v1":
    "9001653618605cfc193bebd446a8423459d23e24a84c28bdab532e7d720b1066",
  "runtime-evidence.route.no-fallback.deepseek.v1.test.v1":
    "ec5e6649de1f4cac406da85ad1e931c4ab100e2cdfd21914ae833e5fb9fb84af",
  "runtime-evidence.route.no-selector.v1.implementation.v1":
    "3b59cb1f0835f350ca09966e4a2b58958dbcd5111a7c53fed8e5eaf532380c73",
  "runtime-evidence.route.no-selector.v1.test.v1":
    "3fa69914b17b36d81474d2d4da8b33edde366e35bf81e479a7b7e4cf7c7d7587",
  "runtime-evidence.route.readonly.v1.implementation.v1":
    "a32b8543da81932ab07060da7472fab91c6ad4e3bf042a265ea2abd784f80ba9",
  "runtime-evidence.route.readonly.v1.test.v1":
    "69f5dcc0d35e2d4a3deb01b9eab172b951acb4730f618a06a483fb9ee23009e5",
});

if (
  EVIDENCE.length !== Object.keys(EXPECTED_RUNTIME_EVIDENCE_SHA256).length ||
  EVIDENCE.some(
    (item) =>
      EXPECTED_RUNTIME_EVIDENCE_SHA256[
        item.descriptor
          .runtime_evidence_id as keyof typeof EXPECTED_RUNTIME_EVIDENCE_SHA256
      ] !== item.sha256,
  )
) {
  throw new Error("reviewed runtime evidence descriptor hash drift");
}

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
  "a07228f777d4c61aacfb7ee452c100806c4b4c0eb996b3a639771891c0a9b79b";
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
