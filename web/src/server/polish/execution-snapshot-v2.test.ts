import { describe, expect, it } from "vitest";

import runtimeFixture from "../../../test/fixtures/ai-runtime-execution-contract-v1.json";
import profileFixture from "../../../test/fixtures/profile-execution-v2.json";
import {
  EMPTY_RUNTIME_TARGET_RESOLVER_V2,
  parseRuntimeExecutionEvidenceV2,
  parseVersionedExecutionSnapshot,
} from "./execution-snapshot-v2";
import { parseRouteSnapshotV1 } from "./lifecycle-v2-contract";

const v1 = runtimeFixture.executionSnapshot.successes[0].value;
const originalRoute = parseRouteSnapshotV1(v1.routeSnapshot);
const v2Profile = {
  ...profileFixture.deepseek,
  legalManifestId: v1.profileExecutionConfig.legalManifestId,
  displayDisclosureKey: originalRoute.displayDisclosureKey,
};
const route = {
  ...originalRoute,
  modelId: v2Profile.modelId,
};
const runtimeEvidence = {
  schemaVersion: "runtime_execution_evidence_v2",
  runtimeContractId: route.runtimeContractId,
  runtimeTargetId: "runtime-target.deepseek-v2.test",
  runtimeTargetSha256:
    "1000000000000000000000000000000000000000000000000000000000000000",
  routeDescriptorId: "route-descriptor.deepseek-v2.test",
  routeDescriptorSha256:
    "2000000000000000000000000000000000000000000000000000000000000000",
  profileVersionId: route.profileVersionId,
  priceVersionId: route.priceVersionId,
  providerId: v2Profile.providerId,
  recipientKey: "deepseek",
  codeCapabilityId: "runtime-capability.deepseek-chat-v1.2026-09-04",
  codeCapabilitySha256:
    "4e5a92750f77f148e6422dcf05b03d99333b357879dba5fdb7248d16dd08bdf2",
  gatewayKind: v2Profile.gatewayKind,
  adapterKind: v2Profile.adapterKind,
  wireApiKind: v2Profile.wireApiKind,
  endpointUrl: v2Profile.endpointUrl,
  credentialEnvName: v2Profile.credentialEnvName,
  modelId: v2Profile.modelId,
  capabilityContractId: v2Profile.capabilityContractId,
  cachePolicyId: v2Profile.cachePolicyId,
  calculatorKind: v2Profile.calculatorKind,
  legalBundleVersion: route.legalBundleVersion,
  legalManifestId: v2Profile.legalManifestId,
  legalManifestSha256:
    "3000000000000000000000000000000000000000000000000000000000000000",
  displayDisclosureKey: route.displayDisclosureKey,
  externalEvidenceIds: ["evidence.deepseek-v2.test"],
};
const v2 = {
  ...v1,
  schemaVersion: "ai_polish_execution_snapshot_v2",
  routeSnapshot: route,
  profileExecutionConfig: v2Profile,
  runtimeEvidence,
};
const expected = {
  reservationId: v1.reservationId,
  reserveRoute: route,
  runtimeTargetResolverV1: () => true,
  runtimeTargetResolverV2: () => true,
};

describe("versioned execution snapshot", () => {
  it("preserves the frozen v1 parser and resolver", () => {
    const parsed = parseVersionedExecutionSnapshot(v1, {
      ...expected,
      reserveRoute: originalRoute,
    });
    expect(parsed.schemaVersion).toBe("ai_polish_execution_snapshot_v1");
  });

  it("accepts one coherent v2 snapshot through an explicit runtime resolver", () => {
    const parsed = parseVersionedExecutionSnapshot(v2, expected);
    expect(parsed).toMatchObject({
      schemaVersion: "ai_polish_execution_snapshot_v2",
      profileExecutionConfig: {
        endpointUrl: v2Profile.endpointUrl,
        modelId: v2Profile.modelId,
      },
      runtimeEvidence: {
        recipientKey: "deepseek",
        codeCapabilityId: "runtime-capability.deepseek-chat-v1.2026-09-04",
      },
    });
  });

  it("accepts a coherent successor legal bundle outside the frozen v1 catalog", () => {
    const successorBundle = "legal-bundle.successor-v2";
    const successorManifest = "provider-manifest.successor-v2";
    const successorRoute = { ...route, legalBundleVersion: successorBundle };
    const successorProfile = {
      ...v2Profile,
      legalManifestId: successorManifest,
    };
    const successorEvidence = {
      ...runtimeEvidence,
      legalBundleVersion: successorBundle,
      legalManifestId: successorManifest,
    };
    const resolver = (target: {
      legalBundleVersion: string;
      evidence: { legalManifestId: string };
    }) =>
      target.legalBundleVersion === successorBundle &&
      target.evidence.legalManifestId === successorManifest;

    expect(
      parseVersionedExecutionSnapshot(
        {
          ...v2,
          routeSnapshot: successorRoute,
          profileExecutionConfig: successorProfile,
          runtimeEvidence: successorEvidence,
        },
        {
          ...expected,
          reserveRoute: successorRoute,
          runtimeTargetResolverV2: resolver,
        },
      ),
    ).toMatchObject({
      routeSnapshot: { legalBundleVersion: successorBundle },
      profileExecutionConfig: { legalManifestId: successorManifest },
    });

    expect(() =>
      parseVersionedExecutionSnapshot(
        {
          ...v2,
          routeSnapshot: successorRoute,
          profileExecutionConfig: successorProfile,
          runtimeEvidence: {
            ...successorEvidence,
            legalManifestId: "provider-manifest.crossed-v2",
          },
        },
        {
          ...expected,
          reserveRoute: successorRoute,
          runtimeTargetResolverV2: () => true,
        },
      ),
    ).toThrow(/authority mismatch/u);
  });

  it("uses the same 64-item external evidence bound as the database", () => {
    for (const count of [32, 33, 64]) {
      expect(() =>
        parseRuntimeExecutionEvidenceV2({
          ...runtimeEvidence,
          externalEvidenceIds: Array.from(
            { length: count },
            (_, index) => `evidence.boundary-${index}`,
          ),
        }),
      ).not.toThrow();
    }
    expect(() =>
      parseRuntimeExecutionEvidenceV2({
        ...runtimeEvidence,
        externalEvidenceIds: Array.from(
          { length: 65 },
          (_, index) => `evidence.boundary-${index}`,
        ),
      }),
    ).toThrow(/externalEvidenceIds/u);
  });

  it("rejects unknown versions, crossed bindings and an unavailable runtime", () => {
    expect(() =>
      parseVersionedExecutionSnapshot({ ...v2, schemaVersion: "future" }, expected),
    ).toThrow();
    expect(() =>
      parseVersionedExecutionSnapshot(
        {
          ...v2,
          profileExecutionConfig: {
            ...v2Profile,
            modelId: "another-model",
          },
        },
        expected,
      ),
    ).toThrow(/authority mismatch/u);
    expect(() =>
      parseVersionedExecutionSnapshot(v2, {
        ...expected,
        runtimeTargetResolverV2: EMPTY_RUNTIME_TARGET_RESOLVER_V2,
      }),
    ).toThrow(/runtime target unavailable/u);
    expect(() =>
      parseVersionedExecutionSnapshot(
        {
          ...v2,
          runtimeEvidence: {
            ...runtimeEvidence,
            endpointUrl: "https://api.deepseek.com/another-path",
          },
        },
        expected,
      ),
    ).toThrow(/authority mismatch/u);
  });
});
