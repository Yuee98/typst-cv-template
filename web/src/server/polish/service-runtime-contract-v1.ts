import { createHash } from "node:crypto";

import {
  DEEPSEEK_LEGAL_MANIFEST_ID,
  INITIAL_LEGAL_BUNDLE_VERSION,
  LEGAL_FINGERPRINT_V1_DESCRIPTORS,
  LEGAL_FINGERPRINT_V1_EXPECTED_SHA256,
  LEGAL_FINGERPRINT_V1_PROFILE_MAPPING,
  MIMO_LEGAL_MANIFEST_ID,
  deriveRequiredServiceFactPairs,
} from "./legal-fingerprint-v1-descriptors";
import { fingerprintLegalDescriptorV1 } from "./legal-fingerprint-v1";
import type {
  RuntimeExecutionTargetV1,
  RuntimeRouteDescriptorV1,
  RuntimeTargetResolverV1,
} from "./lifecycle-v2-contract";
import { MIMO_V2_SEED_IDENTITY_V1 } from "./mimo-v2-seed-identity-v1";
import { resolveProfile } from "./profile-registry";

export const DEEPSEEK_SERVICE_RUNTIME_CONTRACT_ID =
  "runtime.deepseek-v2.v1" as const;
export const DEEPSEEK_SERVICE_RUNTIME_TARGET_ID =
  "runtime-target.deepseek.official.deepseek-v4-flash.chat.v1" as const;
export const DEEPSEEK_PROFILE_KEY =
  "deepseek.official.deepseek-v4-flash.chat.v1" as const;
export const DEEPSEEK_PROFILE_VERSION_ID =
  "11111111-1111-4111-8111-111111111111" as const;
export const DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_ID =
  MIMO_V2_SEED_IDENTITY_V1.runtime.runtimeContractId;
export const MIMO_SERVICE_RUNTIME_TARGET_ID =
  MIMO_V2_SEED_IDENTITY_V1.runtime.runtimeTargetId;
export const MIMO_PROFILE_KEY =
  MIMO_V2_SEED_IDENTITY_V1.profile.profileKey;
export const MIMO_PROFILE_VERSION_ID =
  MIMO_V2_SEED_IDENTITY_V1.profile.profileVersionId;

const DEEPSEEK_ROUTE_DESCRIPTOR_ID = "route.deepseek.official.v1" as const;
const DEEPSEEK_DISPLAY_DISCLOSURE_KEY = "deepseek-official-v1" as const;
const MIMO_ROUTE_DESCRIPTOR_ID =
  MIMO_V2_SEED_IDENTITY_V1.profile.routeDescriptorId;
const MIMO_DISPLAY_DISCLOSURE_KEY =
  MIMO_V2_SEED_IDENTITY_V1.profile.displayDisclosureKey;
const SERVICE_RUNTIME_REGISTRY_KEYS = [
  "schemaVersion",
  "legalBundleVersion",
  "bundleContractSha256",
  "requiredServiceFacts",
  "evidence",
  "targets",
  "contract",
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
  "legal_bundle_version",
  "bundle_contract_sha256",
  "runtime_target_ids",
  "runtime_target_sha256s",
  "service_fact_ids",
  "service_fact_sha256s",
] as const;
const EXECUTION_TARGET_KEYS = [
  "schemaVersion",
  "runtimeContractId",
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

function legalDescriptorSha256(id: string): string {
  const sha256 = (
    LEGAL_FINGERPRINT_V1_EXPECTED_SHA256 as Readonly<Record<string, string>>
  )[id];
  if (sha256 === undefined) {
    throw new Error(`unknown reviewed legal descriptor: ${id}`);
  }
  return sha256;
}

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
  readonly legal_bundle_version: string;
  readonly bundle_contract_sha256: string;
  readonly runtime_target_ids: readonly string[];
  readonly runtime_target_sha256s: readonly string[];
  readonly service_fact_ids: readonly string[];
  readonly service_fact_sha256s: readonly string[];
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
  readonly legalBundleVersion: string;
  readonly bundleContractSha256: string;
  readonly requiredServiceFacts: readonly Readonly<ServiceRuntimeFactPairV1>[];
  readonly evidence: readonly Readonly<HashedServiceRuntimeEvidenceV1>[];
  readonly targets: readonly Readonly<HashedServiceRuntimeTargetV1>[];
  readonly contract: Readonly<ServiceRuntimeContractDescriptorV1>;
  readonly runtimeTargetSetSha256: string;
}

interface RuntimeTargetAuthorityV1 {
  readonly runtimeTargetId: string;
  readonly profileKey: string;
  readonly profileVersionId: string;
  readonly legalManifestId: string;
  readonly routeDescriptorId: string;
  readonly routeDescriptor: Readonly<RuntimeRouteDescriptorV1>;
}

interface ServiceRuntimeRegistryAuthorityV1 {
  readonly contractId: string;
  readonly profileKeys: readonly string[];
  readonly targets: readonly Readonly<RuntimeTargetAuthorityV1>[];
  readonly registry: Readonly<ServiceRuntimeContractRegistryV1>;
}

interface SourceBlobV1 {
  readonly path: string;
}

interface FactEvidenceRouteV1 {
  readonly factId: string;
  readonly implementation: readonly SourceBlobV1[];
  readonly test: readonly SourceBlobV1[];
}

const source = (path: string): Readonly<SourceBlobV1> => Object.freeze({ path });

const sourceSet = (
  ...entries: readonly Readonly<SourceBlobV1>[]
): readonly Readonly<SourceBlobV1>[] => Object.freeze(entries);

const SOURCE_BLOBS = Object.freeze({
  reserve: source("supabase/migrations/20260823234000_reserve_ai_polish_v2.sql"),
  reserveTest: source("web/test/db/reserve-v2-route-snapshot.test.ts"),
  adapterRegistry: source("web/src/server/polish/adapter-registry.ts"),
  adapterRegistryTest: source("web/src/server/polish/adapter-registry.test.ts"),
  availabilityTest: source("web/src/server/polish/lifecycle-availability.test.ts"),
  availabilityDbTest: source("web/test/db/ai-polish-availability-v1.test.ts"),
  availabilityServer: source("web/src/server/polish/lifecycle-availability.ts"),
  profileRegistry: source("web/src/server/polish/profile-registry.ts"),
  profileRegistryTest: source("web/src/server/polish/profile-registry.test.ts"),
  executionContractTest: source(
    "web/src/server/polish/ai-runtime-execution-contract-v1.test.ts",
  ),
  providerSubject: source("web/src/server/polish/provider-subject-v2.ts"),
  providerSubjectTest: source("web/src/server/polish/provider-subject-v2.test.ts"),
  deepseek: source("web/src/server/polish/deepseek.ts"),
  deepseekTest: source("web/src/server/polish/deepseek.test.ts"),
  mimo: source("web/src/server/polish/mimo.ts"),
  mimoTest: source("web/src/server/polish/mimo.test.ts"),
  mimoLiveTest: source("web/src/server/polish/mimo.live.test.ts"),
  mimoContentFilterFixture: source(
    "web/test/fixtures/mimo-responses/content-filter.json",
  ),
  mimoIncompleteFixture: source(
    "web/test/fixtures/mimo-responses/incomplete-max-output.json",
  ),
  mimoSuccessFixture: source("web/test/fixtures/mimo-responses/success.json"),
  quota: source("web/src/server/polish/quota.ts"),
  quotaTest: source("web/src/server/polish/quota-v2.test.ts"),
  handler: source("web/src/server/polish/handler.ts"),
  handlerTest: source("web/src/server/polish/handler.test.ts"),
  ledgerRequest: source(
    "supabase/migrations/20260823231000_ai_provider_ledger_legal_expand.sql",
  ),
  ledgerRequestTest: source("web/test/db/provider-ledger-expand.test.ts"),
  attemptLedger: source(
    "supabase/migrations/20260823234500_add_ai_provider_attempt_ledger.sql",
  ),
  attemptLedgerTest: source("web/test/db/provider-attempt-schema.test.ts"),
  lifecycleV2: source("web/src/server/polish/lifecycle-v2.ts"),
  lifecycleV2Test: source("web/src/server/polish/__tests__/lifecycle/v2.test.ts"),
  attemptComplete: source(
    "supabase/migrations/20260824000000_complete_ai_polish_provider_attempt.sql",
  ),
  attemptCompleteTest: source("web/test/db/provider-attempt-complete.test.ts"),
  attemptStartTest: source("web/test/db/provider-attempt-start.test.ts"),
  attemptFinalizeTest: source("web/test/db/provider-attempt-finalize.test.ts"),
  attemptReconcile: source(
    "supabase/migrations/20260824001000_secure_reconcile_ai_provider_attempts.sql",
  ),
  attemptReconcileTest: source("web/test/db/provider-attempt-reconcile.test.ts"),
  durableTransmission: source(
    "supabase/migrations/20260824001500_durable_attempt_transmission_quota.sql",
  ),
  durableTransmissionTest: source(
    "web/test/db/provider-attempt-transmission.test.ts",
  ),
  durableCancellationSequence: source(
    "supabase/migrations/20260824001600_durable_request_cancellation_sequence.sql",
  ),
  retention: source(
    "supabase/migrations/20260824001000_secure_reconcile_ai_provider_attempts.sql",
  ),
  retentionTest: source("web/test/db/reconcile-cleanup.test.ts"),
  orchestrator: source("web/src/server/polish/orchestrator.ts"),
  orchestratorTest: source("web/src/server/polish/orchestrator.test.ts"),
  scopeBuilder: source("web/src/components/cv-builder/polish/scope-builder.ts"),
  scopeBuilderTest: source(
    "web/src/components/cv-builder/polish/scope-builder.test.ts",
  ),
  legalEn: source("web/src/content/legal/en.ts"),
  legalTest: source("web/src/content/legal/legal.test.ts"),
  flow: source("web/src/components/cv-builder/polish/use-polish-flow.ts"),
  routeAssertionTest: source(
    "web/src/components/cv-builder/polish/__tests__/use-polish-flow/route-assertion.test.tsx",
  ),
  configPhase: source(
    "web/src/components/cv-builder/polish/polish-config-phase.tsx",
  ),
  dialogTest: source("web/src/components/cv-builder/polish/polish-dialog.test.tsx"),
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

const MIMO_FACT_EVIDENCE_ROUTES: readonly Readonly<FactEvidenceRouteV1>[] =
  Object.freeze([
    Object.freeze({
      factId: "fact.mimo.adapter.wire.v1",
      implementation: sourceSet(SOURCE_BLOBS.adapterRegistry, SOURCE_BLOBS.mimo),
      test: sourceSet(
        SOURCE_BLOBS.adapterRegistryTest,
        SOURCE_BLOBS.mimoTest,
        SOURCE_BLOBS.mimoLiveTest,
        SOURCE_BLOBS.mimoContentFilterFixture,
        SOURCE_BLOBS.mimoIncompleteFixture,
        SOURCE_BLOBS.mimoSuccessFixture,
      ),
    }),
    Object.freeze({
      factId: "fact.mimo.display.registration.v1",
      implementation: sourceSet(SOURCE_BLOBS.adapterRegistry),
      test: sourceSet(
        SOURCE_BLOBS.adapterRegistryTest,
        SOURCE_BLOBS.availabilityTest,
      ),
    }),
    Object.freeze({
      factId: "fact.mimo.display.selection.v1",
      implementation: sourceSet(SOURCE_BLOBS.profileRegistry),
      test: sourceSet(
        SOURCE_BLOBS.profileRegistryTest,
        SOURCE_BLOBS.executionContractTest,
      ),
    }),
    Object.freeze({
      factId: "fact.mimo.endpoint.resolution.v1",
      implementation: sourceSet(SOURCE_BLOBS.adapterRegistry, SOURCE_BLOBS.mimo),
      test: sourceSet(
        SOURCE_BLOBS.adapterRegistryTest,
        SOURCE_BLOBS.mimoTest,
        SOURCE_BLOBS.mimoLiveTest,
      ),
    }),
    Object.freeze({
      factId: "fact.mimo.endpoint.selection.v1",
      implementation: sourceSet(SOURCE_BLOBS.profileRegistry),
      test: sourceSet(
        SOURCE_BLOBS.profileRegistryTest,
        SOURCE_BLOBS.executionContractTest,
      ),
    }),
    Object.freeze({
      factId: "fact.mimo.gateway.service.v1",
      implementation: sourceSet(SOURCE_BLOBS.profileRegistry),
      test: sourceSet(
        SOURCE_BLOBS.profileRegistryTest,
        SOURCE_BLOBS.executionContractTest,
      ),
    }),
    Object.freeze({
      factId: "fact.mimo.model.selection.v1",
      implementation: sourceSet(SOURCE_BLOBS.profileRegistry),
      test: sourceSet(
        SOURCE_BLOBS.profileRegistryTest,
        SOURCE_BLOBS.executionContractTest,
      ),
    }),
    Object.freeze({
      factId: "fact.mimo.subject.none.v1",
      implementation: sourceSet(SOURCE_BLOBS.mimo),
      test: sourceSet(SOURCE_BLOBS.mimoTest),
    }),
    Object.freeze({
      factId: "fact.mimo.submitted.v1",
      implementation: sourceSet(SOURCE_BLOBS.mimo, SOURCE_BLOBS.lifecycleV2),
      test: sourceSet(SOURCE_BLOBS.mimoTest, SOURCE_BLOBS.lifecycleV2Test),
    }),
    Object.freeze({
      factId: "fact.mimo.wire.selection.v1",
      implementation: sourceSet(SOURCE_BLOBS.profileRegistry),
      test: sourceSet(
        SOURCE_BLOBS.profileRegistryTest,
        SOURCE_BLOBS.executionContractTest,
      ),
    }),
    Object.freeze({
      factId: "fact.privacy.recipient.mimo.v1",
      implementation: sourceSet(SOURCE_BLOBS.legalEn),
      test: sourceSet(SOURCE_BLOBS.legalTest),
    }),
    Object.freeze({
      factId: "fact.route.no-fallback.mimo.v1",
      implementation: sourceSet(SOURCE_BLOBS.orchestrator, SOURCE_BLOBS.lifecycleV2),
      test: sourceSet(SOURCE_BLOBS.orchestratorTest, SOURCE_BLOBS.lifecycleV2Test),
    }),
  ]);

function extendCombinedEvidenceRoute(
  route: Readonly<FactEvidenceRouteV1>,
): Readonly<FactEvidenceRouteV1> {
  return Object.freeze({
    factId: route.factId,
    implementation: sourceSet(
      ...route.implementation,
      ...(route.factId === "fact.neutral.plaintext.v1"
        ? [SOURCE_BLOBS.mimo]
        : []),
    ),
    test: sourceSet(
      ...route.test,
      ...(route.factId === "fact.neutral.plaintext.v1"
        ? [SOURCE_BLOBS.mimoTest]
        : []),
    ),
  });
}

const DEEPSEEK_MIMO_FACT_EVIDENCE_ROUTES = Object.freeze([
  ...FACT_EVIDENCE_ROUTES.map(extendCombinedEvidenceRoute),
  ...MIMO_FACT_EVIDENCE_ROUTES.map(extendCombinedEvidenceRoute),
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
function buildRuntimeEvidence(
  routes: readonly Readonly<FactEvidenceRouteV1>[],
  requiredFacts: readonly Readonly<ServiceRuntimeFactPairV1>[],
): readonly Readonly<HashedServiceRuntimeEvidenceV1>[] {
  const requiredFactById = new Map(
    requiredFacts.map((pair) => [pair.id, pair]),
  );
  return routes.flatMap((route) =>
    ([
      ["service-implementation", route.implementation],
      ["service-test", route.test],
    ] as const).flatMap(([authorityKind, blobs]) =>
      blobs.map((blob, sourceIndex) => {
        const pair = requiredFactById.get(route.factId);
        if (pair === undefined) {
          throw new Error(
            `runtime evidence references a non-required fact: ${route.factId}`,
          );
        }
        const descriptor = deepFreeze<ServiceRuntimeEvidenceDescriptorV1>({
          schema_version: "ai_service_runtime_evidence_v1",
          runtime_evidence_id: evidenceId(
            route.factId,
            authorityKind,
            sourceIndex,
          ),
          authority_kind: authorityKind,
          supported_fact_id: pair.id,
          supported_fact_sha256: pair.sha256,
          source_repo_path: blob.path,
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
}

const EVIDENCE = buildRuntimeEvidence(
  FACT_EVIDENCE_ROUTES,
  REQUIRED_SERVICE_FACTS,
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
});
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
  legalBundleVersion: INITIAL_LEGAL_BUNDLE_VERSION,
  bundleContractSha256:
    LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[INITIAL_LEGAL_BUNDLE_VERSION],
  requiredServiceFacts: REQUIRED_SERVICE_FACTS,
  evidence: EVIDENCE,
  targets: Object.freeze([HASHED_TARGET]),
  contract: CONTRACT_DESCRIPTOR,
  runtimeTargetSetSha256: runtimeTargetSetSha256([HASHED_TARGET]),
});
const EXPECTED_TARGET_SET_SHA256 =
  "5b7f5f2cd9d21c3c7409f02d7b65eda03999309c0ba3939e50fb81caca2c9340";
if (REGISTRY.runtimeTargetSetSha256 !== EXPECTED_TARGET_SET_SHA256) {
  throw new Error("reviewed DeepSeek runtime target-set hash drift");
}

const DEEPSEEK_MIMO_REQUIRED_SERVICE_FACTS = deriveRequiredServiceFactPairs(
  new Set([DEEPSEEK_PROFILE_KEY, MIMO_PROFILE_KEY]),
);
const DEEPSEEK_MIMO_EVIDENCE = buildRuntimeEvidence(
  DEEPSEEK_MIMO_FACT_EVIDENCE_ROUTES,
  DEEPSEEK_MIMO_REQUIRED_SERVICE_FACTS,
);

const MIMO_TARGET_DESCRIPTOR = deepFreeze<ServiceRuntimeTargetDescriptorV1>({
  schema_version: "ai_service_runtime_target_v1",
  runtime_target_id: MIMO_SERVICE_RUNTIME_TARGET_ID,
  profile_key: MIMO_PROFILE_KEY,
  legal_manifest_id: MIMO_LEGAL_MANIFEST_ID,
  legal_manifest_sha256:
    LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[MIMO_LEGAL_MANIFEST_ID],
  route_descriptor_id: MIMO_ROUTE_DESCRIPTOR_ID,
  route_descriptor_sha256: legalDescriptorSha256(MIMO_ROUTE_DESCRIPTOR_ID),
});
const MIMO_TARGET_SHA256 = fingerprintLegalDescriptorV1(
  MIMO_TARGET_DESCRIPTOR,
).sha256;
const EXPECTED_MIMO_TARGET_SHA256 =
  "091416c8ff3d9c3b32c24d6906b8d618a70da91a9e3cd68132aadcfa964121a6";
if (MIMO_TARGET_SHA256 !== EXPECTED_MIMO_TARGET_SHA256) {
  throw new Error(
    `reviewed MiMo runtime target hash drift: ${MIMO_TARGET_SHA256}`,
  );
}

const DEEPSEEK_MIMO_CONTRACT_DESCRIPTOR =
  deepFreeze<ServiceRuntimeContractDescriptorV1>({
    schema_version: "ai_service_runtime_contract_v1",
    runtime_contract_id: DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_ID,
    legal_bundle_version: INITIAL_LEGAL_BUNDLE_VERSION,
    bundle_contract_sha256:
      LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[INITIAL_LEGAL_BUNDLE_VERSION],
    runtime_target_ids: Object.freeze([
      TARGET_DESCRIPTOR.runtime_target_id,
      MIMO_TARGET_DESCRIPTOR.runtime_target_id,
    ]),
    runtime_target_sha256s: Object.freeze([
      TARGET_SHA256,
      MIMO_TARGET_SHA256,
    ]),
    service_fact_ids: Object.freeze(
      DEEPSEEK_MIMO_REQUIRED_SERVICE_FACTS.map((pair) => pair.id),
    ),
    service_fact_sha256s: Object.freeze(
      DEEPSEEK_MIMO_REQUIRED_SERVICE_FACTS.map((pair) => pair.sha256),
    ),
  });
const MIMO_RUNTIME_ROUTE_DESCRIPTOR = deepFreeze<RuntimeRouteDescriptorV1>({
  gatewayKind: MIMO_V2_SEED_IDENTITY_V1.profile.gatewayKind,
  adapterKind: MIMO_V2_SEED_IDENTITY_V1.profile.adapterKind,
  wireApiKind: MIMO_V2_SEED_IDENTITY_V1.profile.wireApiKind,
  credentialAlias: MIMO_V2_SEED_IDENTITY_V1.profile.credentialAlias,
  endpointAlias: MIMO_V2_SEED_IDENTITY_V1.profile.endpointAlias,
  modelId: MIMO_V2_SEED_IDENTITY_V1.profile.modelId,
  capabilityContractId:
    MIMO_V2_SEED_IDENTITY_V1.profile.capabilityContractId,
  cachePolicyId: MIMO_V2_SEED_IDENTITY_V1.profile.cachePolicyId,
  calculatorKind: MIMO_V2_SEED_IDENTITY_V1.profile.calculatorKind,
  displayDisclosureKey: MIMO_DISPLAY_DISCLOSURE_KEY,
});

export const DEEPSEEK_MIMO_DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1 =
  deepFreeze<RuntimeExecutionTargetV1>({
    schemaVersion: "runtime_execution_target_v1",
    runtimeContractId: DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_ID,
    legalBundleVersion: INITIAL_LEGAL_BUNDLE_VERSION,
    profileVersionId: DEEPSEEK_PROFILE_VERSION_ID,
    profileKey: DEEPSEEK_PROFILE_KEY,
    legalManifestId: DEEPSEEK_LEGAL_MANIFEST_ID,
    routeDescriptor: RUNTIME_ROUTE_DESCRIPTOR,
  });

export const DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1 =
  deepFreeze<RuntimeExecutionTargetV1>({
    schemaVersion: "runtime_execution_target_v1",
    runtimeContractId: DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_ID,
    legalBundleVersion: INITIAL_LEGAL_BUNDLE_VERSION,
    profileVersionId: MIMO_PROFILE_VERSION_ID,
    profileKey: MIMO_PROFILE_KEY,
    legalManifestId: MIMO_LEGAL_MANIFEST_ID,
    routeDescriptor: MIMO_RUNTIME_ROUTE_DESCRIPTOR,
  });

const DEEPSEEK_MIMO_DEEPSEEK_HASHED_TARGET =
  deepFreeze<HashedServiceRuntimeTargetV1>({
    descriptor: TARGET_DESCRIPTOR,
    sha256: TARGET_SHA256,
    profileVersionId: DEEPSEEK_PROFILE_VERSION_ID,
    executionTarget: DEEPSEEK_MIMO_DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1,
  });
const DEEPSEEK_MIMO_MIMO_HASHED_TARGET =
  deepFreeze<HashedServiceRuntimeTargetV1>({
    descriptor: MIMO_TARGET_DESCRIPTOR,
    sha256: MIMO_TARGET_SHA256,
    profileVersionId: MIMO_PROFILE_VERSION_ID,
    executionTarget: DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1,
  });
const DEEPSEEK_MIMO_TARGETS = Object.freeze([
  DEEPSEEK_MIMO_DEEPSEEK_HASHED_TARGET,
  DEEPSEEK_MIMO_MIMO_HASHED_TARGET,
]);

const DEEPSEEK_MIMO_REGISTRY = deepFreeze<ServiceRuntimeContractRegistryV1>({
  schemaVersion: "service_runtime_contract_registry_v1",
  legalBundleVersion: INITIAL_LEGAL_BUNDLE_VERSION,
  bundleContractSha256:
    LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[INITIAL_LEGAL_BUNDLE_VERSION],
  requiredServiceFacts: DEEPSEEK_MIMO_REQUIRED_SERVICE_FACTS,
  evidence: DEEPSEEK_MIMO_EVIDENCE,
  targets: DEEPSEEK_MIMO_TARGETS,
  contract: DEEPSEEK_MIMO_CONTRACT_DESCRIPTOR,
  runtimeTargetSetSha256: runtimeTargetSetSha256(DEEPSEEK_MIMO_TARGETS),
});
const EXPECTED_DEEPSEEK_MIMO_TARGET_SET_SHA256 =
  "2ae3a6e969ceee2772d2863ffa23d11dd8e5e725b32df39969f5ade746b55878";
if (
  DEEPSEEK_MIMO_REGISTRY.runtimeTargetSetSha256 !==
  EXPECTED_DEEPSEEK_MIMO_TARGET_SET_SHA256
) {
  throw new Error(
    `reviewed DeepSeek+MiMo runtime target-set hash drift: ${DEEPSEEK_MIMO_REGISTRY.runtimeTargetSetSha256}`,
  );
}

const DEEPSEEK_TARGET_AUTHORITY = deepFreeze<RuntimeTargetAuthorityV1>({
  runtimeTargetId: DEEPSEEK_SERVICE_RUNTIME_TARGET_ID,
  profileKey: DEEPSEEK_PROFILE_KEY,
  profileVersionId: DEEPSEEK_PROFILE_VERSION_ID,
  legalManifestId: DEEPSEEK_LEGAL_MANIFEST_ID,
  routeDescriptorId: DEEPSEEK_ROUTE_DESCRIPTOR_ID,
  routeDescriptor: RUNTIME_ROUTE_DESCRIPTOR,
});
const MIMO_TARGET_AUTHORITY = deepFreeze<RuntimeTargetAuthorityV1>({
  runtimeTargetId: MIMO_SERVICE_RUNTIME_TARGET_ID,
  profileKey: MIMO_PROFILE_KEY,
  profileVersionId: MIMO_PROFILE_VERSION_ID,
  legalManifestId: MIMO_LEGAL_MANIFEST_ID,
  routeDescriptorId: MIMO_ROUTE_DESCRIPTOR_ID,
  routeDescriptor: MIMO_RUNTIME_ROUTE_DESCRIPTOR,
});
const DEEPSEEK_REGISTRY_AUTHORITY =
  deepFreeze<ServiceRuntimeRegistryAuthorityV1>({
    contractId: DEEPSEEK_SERVICE_RUNTIME_CONTRACT_ID,
    profileKeys: Object.freeze([DEEPSEEK_PROFILE_KEY]),
    targets: Object.freeze([DEEPSEEK_TARGET_AUTHORITY]),
    registry: REGISTRY,
  });
const DEEPSEEK_MIMO_REGISTRY_AUTHORITY =
  deepFreeze<ServiceRuntimeRegistryAuthorityV1>({
    contractId: DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_ID,
    profileKeys: Object.freeze([DEEPSEEK_PROFILE_KEY, MIMO_PROFILE_KEY]),
    targets: Object.freeze([
      DEEPSEEK_TARGET_AUTHORITY,
      MIMO_TARGET_AUTHORITY,
    ]),
    registry: DEEPSEEK_MIMO_REGISTRY,
  });

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
  contractId: string,
  authority: Readonly<RuntimeTargetAuthorityV1>,
): asserts value is RuntimeExecutionTargetV1 {
  assertPlainRecord(value, "execution target");
  assertExactKeys(value, EXECUTION_TARGET_KEYS, "execution target");
  if (
    value.schemaVersion !== "runtime_execution_target_v1" ||
    value.runtimeContractId !== contractId ||
    value.legalBundleVersion !== INITIAL_LEGAL_BUNDLE_VERSION ||
    value.profileVersionId !== authority.profileVersionId ||
    value.profileKey !== authority.profileKey ||
    value.legalManifestId !== authority.legalManifestId
  ) {
    fail("execution target identity does not match the reviewed profile/legal route");
  }
  assertPlainRecord(value.routeDescriptor, "execution target route descriptor");
  assertExactKeys(
    value.routeDescriptor,
    RUNTIME_ROUTE_DESCRIPTOR_KEYS,
    "execution target route descriptor",
  );
  for (const key of RUNTIME_ROUTE_DESCRIPTOR_KEYS) {
    if (value.routeDescriptor[key] !== authority.routeDescriptor[key]) {
      fail(`execution target route descriptor ${key} drifted`);
    }
  }
}

function validateServiceRuntimeRegistryAgainstAuthority(
  input: unknown,
  authority: Readonly<ServiceRuntimeRegistryAuthorityV1>,
): asserts input is ServiceRuntimeContractRegistryV1 {
  assertPlainRecord(input, "registry");
  assertExactKeys(input, SERVICE_RUNTIME_REGISTRY_KEYS, "registry");
  assertDeepFrozen(input, "registry");
  if (
    input.schemaVersion !== "service_runtime_contract_registry_v1" ||
    input.legalBundleVersion !== INITIAL_LEGAL_BUNDLE_VERSION ||
    input.bundleContractSha256 !==
      LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[INITIAL_LEGAL_BUNDLE_VERSION]
  ) {
    fail("registry root identity does not match the legal bundle");
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
    new Set(authority.profileKeys),
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
  const allowedOperationalScopes = new Set([
    "global",
    ...authority.profileKeys.map((profileKey) => `profile:${profileKey}`),
  ]);
  for (const pair of requiredPairs) {
    const fact = legalFacts.get(pair.id);
    if (
      fact === undefined ||
      fact.authority_class !== "service-operational" ||
      !allowedOperationalScopes.has(fact.operational_scope) ||
      fingerprintLegalDescriptorV1(fact).sha256 !== pair.sha256
    ) {
      fail(`required service fact does not resolve: ${pair.id}`);
    }
  }

  assertExactArray(input.evidence, "evidence");
  const evidenceIds: string[] = [];
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
    if (fingerprintLegalDescriptorV1(item.descriptor).sha256 !== hash) {
      fail(`evidence.${index} descriptor hash does not match`);
    }
    if (immutableIds.has(id)) fail(`duplicate or rebound evidence ID: ${id}`);
    immutableIds.set(id, hash);
    evidenceIds.push(id);
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
  if (input.targets.length !== authority.targets.length) {
    fail(`reviewed registry must contain ${authority.targets.length} targets`);
  }
  const validatedTargets: Readonly<HashedServiceRuntimeTargetV1>[] = [];
  const targetIds: string[] = [];
  const targetHashes: string[] = [];
  for (const [index, rawTarget] of input.targets.entries()) {
    const expectedTarget = authority.targets[index];
    const label = `targets.${index}`;
    assertPlainRecord(rawTarget, label);
    assertExactKeys(rawTarget, HASHED_TARGET_KEYS, label);
    assertPlainRecord(rawTarget.descriptor, `${label}.descriptor`);
    assertExactKeys(
      rawTarget.descriptor,
      TARGET_DESCRIPTOR_KEYS,
      `${label}.descriptor`,
    );
    if (
      rawTarget.descriptor.schema_version !== "ai_service_runtime_target_v1" ||
      rawTarget.descriptor.runtime_target_id !== expectedTarget.runtimeTargetId ||
      rawTarget.descriptor.profile_key !== expectedTarget.profileKey ||
      rawTarget.descriptor.legal_manifest_id !== expectedTarget.legalManifestId ||
      rawTarget.descriptor.legal_manifest_sha256 !==
        legalDescriptorSha256(expectedTarget.legalManifestId) ||
      rawTarget.descriptor.route_descriptor_id !==
        expectedTarget.routeDescriptorId ||
      rawTarget.descriptor.route_descriptor_sha256 !==
        legalDescriptorSha256(expectedTarget.routeDescriptorId) ||
      rawTarget.profileVersionId !== expectedTarget.profileVersionId
    ) {
      fail("runtime target does not resolve to the reviewed profile/legal route");
    }
    const targetHash = requireHash(rawTarget.sha256, `${label}.sha256`);
    if (
      fingerprintLegalDescriptorV1(rawTarget.descriptor).sha256 !== targetHash
    ) {
      fail("runtime target descriptor hash does not match");
    }
    if (immutableIds.has(rawTarget.descriptor.runtime_target_id)) {
      fail("runtime target ID collides with another immutable descriptor");
    }
    immutableIds.set(rawTarget.descriptor.runtime_target_id, targetHash);

    const legalManifest = LEGAL_FINGERPRINT_V1_DESCRIPTORS.manifests.find(
      (manifest) => manifest.manifest_id === expectedTarget.legalManifestId,
    );
    const legalRoute = LEGAL_FINGERPRINT_V1_DESCRIPTORS.routes.find(
      (route) => route.route_descriptor_id === expectedTarget.routeDescriptorId,
    );
    const profileMapping = LEGAL_FINGERPRINT_V1_PROFILE_MAPPING.find(
      (mapping) => mapping.profileKey === expectedTarget.profileKey,
    );
    if (
      legalManifest === undefined ||
      legalRoute === undefined ||
      profileMapping === undefined ||
      fingerprintLegalDescriptorV1(legalManifest).sha256 !==
        rawTarget.descriptor.legal_manifest_sha256 ||
      fingerprintLegalDescriptorV1(legalRoute).sha256 !==
        rawTarget.descriptor.route_descriptor_sha256 ||
      profileMapping.manifestId !== rawTarget.descriptor.legal_manifest_id ||
      profileMapping.routeDescriptorId !==
        rawTarget.descriptor.route_descriptor_id
    ) {
      fail("runtime target legal references do not close");
    }

    validateExecutionTarget(
      rawTarget.executionTarget,
      authority.contractId,
      expectedTarget,
    );
    const profile = resolveProfile(expectedTarget.profileKey);
    for (const key of RUNTIME_ROUTE_DESCRIPTOR_KEYS) {
      if (rawTarget.executionTarget.routeDescriptor[key] !== profile[key]) {
        fail(`execution target does not match profile registry field ${key}`);
      }
    }
    targetIds.push(rawTarget.descriptor.runtime_target_id);
    targetHashes.push(targetHash);
    validatedTargets.push(
      rawTarget as unknown as Readonly<HashedServiceRuntimeTargetV1>,
    );
  }
  assertSortedUnique(targetIds, "runtime target IDs");

  assertPlainRecord(input.contract, "contract");
  assertExactKeys(input.contract, CONTRACT_DESCRIPTOR_KEYS, "contract");
  if (
    input.contract.schema_version !== "ai_service_runtime_contract_v1" ||
    input.contract.runtime_contract_id !== authority.contractId ||
    input.contract.legal_bundle_version !== input.legalBundleVersion ||
    input.contract.bundle_contract_sha256 !== input.bundleContractSha256
  ) {
    fail("runtime contract root identity is invalid");
  }
  const contractTargetIds = requireStringArray(
    input.contract.runtime_target_ids,
    "contract target IDs",
  );
  const contractTargetHashes = requireStringArray(
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
  assertSameStrings(contractTargetIds, targetIds, "contract targets");
  assertSameStrings(contractTargetHashes, targetHashes, "contract target hashes");
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
  assertSortedUnique(contractTargetIds, "contract target IDs");
  assertSortedUnique(serviceFactIds, "contract fact IDs");
  if (
    requireHash(input.runtimeTargetSetSha256, "runtime target-set hash") !==
    runtimeTargetSetSha256(validatedTargets)
  ) {
    fail("runtime target-set hash does not match the DB formula");
  }

  // Structural/hash validation above establishes a sound candidate. This last
  // comparison is intentionally stricter: callers may validate only the one
  // declared authority, never a coherent re-sign of a different source path,
  // descriptor ID, target, root, order, or evidence cardinality.
  assertExactReviewedValue(input, authority.registry, "registry");
}

export function validateServiceRuntimeContractV1Registry(
  input: unknown,
): asserts input is ServiceRuntimeContractRegistryV1 {
  validateServiceRuntimeRegistryAgainstAuthority(input, DEEPSEEK_REGISTRY_AUTHORITY);
}

export function validateDeepSeekMiMoServiceRuntimeContractV1Registry(
  input: unknown,
): asserts input is ServiceRuntimeContractRegistryV1 {
  validateServiceRuntimeRegistryAgainstAuthority(
    input,
    DEEPSEEK_MIMO_REGISTRY_AUTHORITY,
  );
}

validateServiceRuntimeContractV1Registry(REGISTRY);
validateDeepSeekMiMoServiceRuntimeContractV1Registry(DEEPSEEK_MIMO_REGISTRY);

export const DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1 = REGISTRY;
export const DEEPSEEK_SERVICE_RUNTIME_TARGET_V1_SHA256 = TARGET_SHA256;
export const DEEPSEEK_SERVICE_RUNTIME_TARGET_SET_V1_SHA256 =
  REGISTRY.runtimeTargetSetSha256;
export const DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_V1 = DEEPSEEK_MIMO_REGISTRY;
export const MIMO_SERVICE_RUNTIME_TARGET_V1_SHA256 = MIMO_TARGET_SHA256;
export const DEEPSEEK_MIMO_SERVICE_RUNTIME_TARGET_SET_V1_SHA256 =
  DEEPSEEK_MIMO_REGISTRY.runtimeTargetSetSha256;

export const DEEPSEEK_RUNTIME_CONTRACT_DB_FIXTURE_V1 = deepFreeze({
  schemaVersion: "service_runtime_contract_db_fixture_v1" as const,
  contract: {
    runtimeContractId: DEEPSEEK_SERVICE_RUNTIME_CONTRACT_ID,
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

export const DEEPSEEK_MIMO_RUNTIME_CONTRACT_DB_FIXTURE_V1 = deepFreeze({
  schemaVersion: "service_runtime_contract_db_fixture_v1" as const,
  contract: {
    runtimeContractId: DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_ID,
    legalBundleVersion: INITIAL_LEGAL_BUNDLE_VERSION,
    bundleContractSha256:
      LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[INITIAL_LEGAL_BUNDLE_VERSION],
    runtimeTargetSetSha256: DEEPSEEK_MIMO_REGISTRY.runtimeTargetSetSha256,
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
    {
      runtimeTargetId: MIMO_SERVICE_RUNTIME_TARGET_ID,
      runtimeTargetSha256: MIMO_TARGET_SHA256,
      profileVersionId: MIMO_PROFILE_VERSION_ID,
      profileKey: MIMO_PROFILE_KEY,
      legalManifestId: MIMO_LEGAL_MANIFEST_ID,
      manifestSha256:
        LEGAL_FINGERPRINT_V1_EXPECTED_SHA256[MIMO_LEGAL_MANIFEST_ID],
      routeDescriptorId: MIMO_ROUTE_DESCRIPTOR_ID,
      routeDescriptorSha256: legalDescriptorSha256(MIMO_ROUTE_DESCRIPTOR_ID),
    },
  ],
});

function exactRuntimeTargetMatchesAuthority(
  value: unknown,
  contractId: string,
  authority: Readonly<RuntimeTargetAuthorityV1>,
): boolean {
  try {
    validateExecutionTarget(value, contractId, authority);
    const target = value as RuntimeExecutionTargetV1;
    for (const key of RUNTIME_ROUTE_DESCRIPTOR_KEYS) {
      if (target.routeDescriptor[key] !== authority.routeDescriptor[key]) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export const DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1: RuntimeTargetResolverV1 =
  (value) =>
    exactRuntimeTargetMatchesAuthority(
      value,
      DEEPSEEK_SERVICE_RUNTIME_CONTRACT_ID,
      DEEPSEEK_TARGET_AUTHORITY,
    );

export const DEEPSEEK_MIMO_RUNTIME_TARGET_RESOLVER_V1: RuntimeTargetResolverV1 =
  (value) =>
    DEEPSEEK_MIMO_REGISTRY_AUTHORITY.targets.some((targetAuthority) =>
      exactRuntimeTargetMatchesAuthority(
        value,
        DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_ID,
        targetAuthority,
      ),
    );
