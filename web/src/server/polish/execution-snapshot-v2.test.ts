import { describe, expect, it } from "vitest";

import runtimeFixture from "../../../test/fixtures/ai-runtime-execution-contract-v1.json";
import profileFixture from "../../../test/fixtures/profile-execution-v2.json";
import {
  EMPTY_RUNTIME_TARGET_RESOLVER_V2,
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
const v2 = {
  ...v1,
  schemaVersion: "ai_polish_execution_snapshot_v2",
  routeSnapshot: route,
  profileExecutionConfig: v2Profile,
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
    });
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
  });
});
