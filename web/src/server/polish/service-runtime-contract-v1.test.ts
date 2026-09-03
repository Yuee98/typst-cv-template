import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { fingerprintLegalDescriptorV1 } from "./legal-fingerprint-v1";
import { MIMO_V2_SEED_IDENTITY_V1 } from "./mimo-v2-seed-identity-v1";
import {
  DEEPSEEK_MIMO_DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1,
  DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1,
  DEEPSEEK_MIMO_RUNTIME_CONTRACT_DB_FIXTURE_V1,
  DEEPSEEK_MIMO_RUNTIME_TARGET_RESOLVER_V1,
  DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_ID,
  DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_V1,
  DEEPSEEK_MIMO_SERVICE_RUNTIME_TARGET_SET_V1_SHA256,
  DEEPSEEK_PROFILE_KEY,
  DEEPSEEK_PROFILE_VERSION_ID,
  DEEPSEEK_RUNTIME_CONTRACT_DB_FIXTURE_V1,
  DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1,
  DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1,
  DEEPSEEK_SERVICE_RUNTIME_CONTRACT_ID,
  DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1,
  DEEPSEEK_SERVICE_RUNTIME_TARGET_ID,
  DEEPSEEK_SERVICE_RUNTIME_TARGET_SET_V1_SHA256,
  DEEPSEEK_SERVICE_RUNTIME_TARGET_V1_SHA256,
  MIMO_PROFILE_KEY,
  MIMO_PROFILE_VERSION_ID,
  MIMO_SERVICE_RUNTIME_TARGET_ID,
  MIMO_SERVICE_RUNTIME_TARGET_V1_SHA256,
  type HashedServiceRuntimeTargetV1,
  type ServiceRuntimeContractRegistryV1,
  validateDeepSeekMiMoServiceRuntimeContractV1Registry,
  validateServiceRuntimeContractV1Registry,
} from "./service-runtime-contract-v1";

const MIMO_EVIDENCE_PATHS = [
  "web/src/server/polish/mimo.ts",
  "web/src/server/polish/mimo.test.ts",
  "web/src/server/polish/mimo.live.test.ts",
  "web/test/fixtures/mimo-responses/content-filter.json",
  "web/test/fixtures/mimo-responses/incomplete-max-output.json",
  "web/test/fixtures/mimo-responses/success.json",
] as const;

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function expectDeeplyFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeeplyFrozen(child);
}

function runtimeTargetSetSha256(
  targets: readonly Readonly<HashedServiceRuntimeTargetV1>[],
): string {
  const body = [...targets]
    .sort((left, right) =>
      Buffer.from(left.descriptor.runtime_target_id).compare(
        Buffer.from(right.descriptor.runtime_target_id),
      ),
    )
    .map(
      (target) =>
        `${Buffer.byteLength(target.descriptor.runtime_target_id, "utf8")}:${target.descriptor.runtime_target_id}:${target.sha256}`,
    )
    .join("\n");
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function expectRejectedMutation(
  source: Readonly<ServiceRuntimeContractRegistryV1>,
  validate: (value: unknown) => void,
  mutate: (candidate: Record<string, unknown>) => void,
): void {
  const candidate = structuredClone(source) as unknown as Record<string, unknown>;
  mutate(candidate);
  deepFreeze(candidate);
  expect(() => validate(candidate)).toThrow(/invalid DeepSeek service runtime contract/u);
}

function expectEvidenceClosure(registry: Readonly<ServiceRuntimeContractRegistryV1>): void {
  const expectedFacts = registry.requiredServiceFacts.map((fact) => fact.id);
  expect(expectedFacts).toEqual([...expectedFacts].sort());
  expect(new Set(expectedFacts).size).toBe(expectedFacts.length);

  for (const factId of expectedFacts) {
    const kinds = new Set(
      registry.evidence
        .filter((item) => item.descriptor.supported_fact_id === factId)
        .map((item) => item.descriptor.authority_kind),
    );
    expect(kinds, factId).toEqual(
      new Set(["service-implementation", "service-test"]),
    );
  }
}

describe("versioned service runtime contract registry", () => {
  it("keeps runtime identity ID-only and immutable in code", () => {
    validateServiceRuntimeContractV1Registry(DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1);
    validateDeepSeekMiMoServiceRuntimeContractV1Registry(
      DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_V1,
    );
    expectDeeplyFrozen(DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1);
    expectDeeplyFrozen(DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_V1);

    expect(DEEPSEEK_SERVICE_RUNTIME_CONTRACT_ID).toBe("runtime.deepseek-v2.v1");
    expect(DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_ID).toBe(
      "runtime.deepseek-v2-mimo-v2.5-pro.v2",
    );
    for (const registry of [
      DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1,
      DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_V1,
    ]) {
      expect(registry).not.toHaveProperty("contractSha256");
      expect(registry).not.toHaveProperty("reviewedSourceCommitOid");
      expect(registry.contract).not.toHaveProperty("reviewed_source_commit_oid");
      expect(registry.contract).not.toHaveProperty("runtime_evidence_sha256s");
      for (const evidence of registry.evidence) {
        expect(evidence.descriptor).not.toHaveProperty("source_git_blob_sha256");
      }
    }
  });

  it("closes every legal service fact with implementation and test evidence", () => {
    expectEvidenceClosure(DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1);
    expectEvidenceClosure(DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_V1);

    const combinedPaths = new Set(
      DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_V1.evidence.map(
        (item) => item.descriptor.source_repo_path,
      ),
    );
    for (const path of MIMO_EVIDENCE_PATHS) expect(combinedPaths).toContain(path);
  });

  it("retains content hashes only for DB-authored target and legal facts", () => {
    for (const registry of [
      DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1,
      DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_V1,
    ]) {
      for (const target of registry.targets) {
        expect(fingerprintLegalDescriptorV1(target.descriptor).sha256).toBe(
          target.sha256,
        );
      }
      expect(runtimeTargetSetSha256(registry.targets)).toBe(
        registry.runtimeTargetSetSha256,
      );
    }
    expect(DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1.targets[0].sha256).toBe(
      DEEPSEEK_SERVICE_RUNTIME_TARGET_V1_SHA256,
    );
    expect(DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_V1.targets[1].sha256).toBe(
      MIMO_SERVICE_RUNTIME_TARGET_V1_SHA256,
    );
    expect(DEEPSEEK_SERVICE_RUNTIME_TARGET_SET_V1_SHA256).toBe(
      DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1.runtimeTargetSetSha256,
    );
    expect(DEEPSEEK_MIMO_SERVICE_RUNTIME_TARGET_SET_V1_SHA256).toBe(
      DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_V1.runtimeTargetSetSha256,
    );
  });

  it("publishes exact profile, adapter, wire, model and endpoint aliases per ID", () => {
    expect(DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1).toMatchObject({
      runtimeContractId: DEEPSEEK_SERVICE_RUNTIME_CONTRACT_ID,
      profileVersionId: DEEPSEEK_PROFILE_VERSION_ID,
      profileKey: DEEPSEEK_PROFILE_KEY,
      routeDescriptor: {
        gatewayKind: "direct_deepseek",
        adapterKind: "deepseek_chat_v1",
        wireApiKind: "chat_completions_v1",
        endpointAlias: "deepseek_official",
        modelId: "deepseek-v4-flash",
      },
    });
    expect(DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1).toMatchObject({
      runtimeContractId: DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_ID,
      profileVersionId: MIMO_PROFILE_VERSION_ID,
      profileKey: MIMO_PROFILE_KEY,
      routeDescriptor: {
        gatewayKind: MIMO_V2_SEED_IDENTITY_V1.profile.gatewayKind,
        adapterKind: MIMO_V2_SEED_IDENTITY_V1.profile.adapterKind,
        wireApiKind: MIMO_V2_SEED_IDENTITY_V1.profile.wireApiKind,
        endpointAlias: MIMO_V2_SEED_IDENTITY_V1.profile.endpointAlias,
        modelId: MIMO_V2_SEED_IDENTITY_V1.profile.modelId,
      },
    });
  });

  it("mirrors the ID-only roots and exact targets in DB seed fixtures", () => {
    expect(DEEPSEEK_RUNTIME_CONTRACT_DB_FIXTURE_V1.contract).toEqual({
      runtimeContractId: DEEPSEEK_SERVICE_RUNTIME_CONTRACT_ID,
      legalBundleVersion: DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1.legalBundleVersion,
      bundleContractSha256:
        DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1.bundleContractSha256,
      runtimeTargetSetSha256:
        DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1.runtimeTargetSetSha256,
    });
    expect(DEEPSEEK_MIMO_RUNTIME_CONTRACT_DB_FIXTURE_V1.contract).toEqual({
      runtimeContractId: DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_ID,
      legalBundleVersion:
        DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_V1.legalBundleVersion,
      bundleContractSha256:
        DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_V1.bundleContractSha256,
      runtimeTargetSetSha256:
        DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_V1.runtimeTargetSetSha256,
    });
    expect(DEEPSEEK_RUNTIME_CONTRACT_DB_FIXTURE_V1.targets[0]).toMatchObject({
      runtimeTargetId: DEEPSEEK_SERVICE_RUNTIME_TARGET_ID,
      profileVersionId: DEEPSEEK_PROFILE_VERSION_ID,
      profileKey: DEEPSEEK_PROFILE_KEY,
    });
    expect(DEEPSEEK_MIMO_RUNTIME_CONTRACT_DB_FIXTURE_V1.targets[1]).toMatchObject({
      runtimeTargetId: MIMO_SERVICE_RUNTIME_TARGET_ID,
      profileVersionId: MIMO_PROFILE_VERSION_ID,
      profileKey: MIMO_PROFILE_KEY,
    });
  });

  it("resolves only exact targets belonging to the selected versioned ID", () => {
    expect(
      DEEPSEEK_RUNTIME_TARGET_RESOLVER_V1(
        structuredClone(DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1),
      ),
    ).toBe(true);
    for (const target of [
      DEEPSEEK_MIMO_DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1,
      DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1,
    ]) {
      expect(DEEPSEEK_MIMO_RUNTIME_TARGET_RESOLVER_V1(structuredClone(target))).toBe(
        true,
      );
      expect(
        DEEPSEEK_MIMO_RUNTIME_TARGET_RESOLVER_V1({
          ...structuredClone(target),
          runtimeContractId: "runtime.deepseek-v2-mimo-v2.5-pro.v1",
        }),
      ).toBe(false);
    }
    expect(
      DEEPSEEK_MIMO_RUNTIME_TARGET_RESOLVER_V1({
        ...structuredClone(DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1),
        profileKey: DEEPSEEK_PROFILE_KEY,
      }),
    ).toBe(false);
  });

  it("fails closed on root, evidence, route and cardinality drift", () => {
    expectRejectedMutation(
      DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1,
      validateServiceRuntimeContractV1Registry,
      (candidate) => {
        candidate.extra = true;
      },
    );
    expectRejectedMutation(
      DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1,
      validateServiceRuntimeContractV1Registry,
      (candidate) => {
        (candidate.contract as Record<string, unknown>).runtime_contract_id =
          "runtime.deepseek-v2.v2";
      },
    );
    expectRejectedMutation(
      DEEPSEEK_SERVICE_RUNTIME_CONTRACT_V1,
      validateServiceRuntimeContractV1Registry,
      (candidate) => {
        const evidence = candidate.evidence as Array<{
          descriptor: Record<string, unknown>;
        }>;
        evidence[0].descriptor.source_repo_path =
          "web/src/server/polish/service-runtime-contract-v1.ts";
      },
    );
    expectRejectedMutation(
      DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_V1,
      validateDeepSeekMiMoServiceRuntimeContractV1Registry,
      (candidate) => {
        const targets = candidate.targets as Array<{
          executionTarget: { routeDescriptor: Record<string, unknown> };
        }>;
        targets[1].executionTarget.routeDescriptor.modelId = "mimo-other";
      },
    );
    expectRejectedMutation(
      DEEPSEEK_MIMO_SERVICE_RUNTIME_CONTRACT_V1,
      validateDeepSeekMiMoServiceRuntimeContractV1Registry,
      (candidate) => {
        (candidate.targets as unknown[]).pop();
      },
    );
  });
});
