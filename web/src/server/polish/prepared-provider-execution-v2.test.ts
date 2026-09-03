import { describe, expect, it, vi } from "vitest";

import fixtures from "../../../test/fixtures/profile-execution-v2.json";
import {
  createPreparedProviderExecutionV2,
  isPreparedProviderExecutionV2,
  readPreparedProviderExecutionV2,
} from "./prepared-provider-execution-v2";
import { prepareProviderTransportV2 } from "./provider-binding-v2";
import { validateProfileExecutionConfigV2 } from "./profile-execution-v2";

const PROFILE = validateProfileExecutionConfigV2(fixtures.deepseek);

function prepare(
  runtimeBuildId = "test-build:a",
  revision = "test-binding-a",
) {
  return prepareProviderTransportV2({
    profile: PROFILE,
    recipient: {
      providerId: fixtures.deepseek.providerId,
      recipientKey: "deepseek",
    },
    manifest: {
      schemaVersion: "ai_provider_bindings_v1",
      revision,
      bindings: [
        {
          credentialEnvName: fixtures.deepseek.credentialEnvName,
          providerId: fixtures.deepseek.providerId,
          recipientKey: "deepseek",
          origin: "https://api.deepseek.com",
        },
      ],
    },
    expectedManifestRevision: revision,
    runtimeBuildId,
    resolveSecret: () => "fake-provider-key",
  });
}

describe("prepared provider execution v2", () => {
  it("derives the provider and persisted provenance from one opaque transport", () => {
    const execution = createPreparedProviderExecutionV2(prepare(), vi.fn());
    const facts = readPreparedProviderExecutionV2(
      execution,
      PROFILE,
    );
    expect(facts.provider).toBe(execution.provider);
    expect(facts.runtimeProvenance).toEqual({
      runtimeBuildId: "test-build:a",
      bindingManifestRevision: "test-binding-a",
    });
    expect(Object.isFrozen(facts.runtimeProvenance)).toBe(true);
  });

  it("rejects a crossed or copied execution before either transport can send", () => {
    const fetchA = vi.fn<typeof fetch>();
    const fetchB = vi.fn<typeof fetch>();
    const executionA = createPreparedProviderExecutionV2(
      prepare("test-build:a", "test-binding-a"),
      fetchA,
    );
    const executionB = createPreparedProviderExecutionV2(
      prepare("test-build:b", "test-binding-b"),
      fetchB,
    );
    const crossed = {
      ...executionA,
      provider: executionB.provider,
      runtimeBuildId: "test-build:b",
      bindingManifestRevision: "test-binding-b",
    };

    expect(isPreparedProviderExecutionV2(crossed)).toBe(false);
    expect(() =>
      readPreparedProviderExecutionV2(crossed, PROFILE),
    ).toThrow();
    expect(fetchA).not.toHaveBeenCalled();
    expect(fetchB).not.toHaveBeenCalled();
  });

  it("rejects a branded execution when the DB profile differs", () => {
    const execution = createPreparedProviderExecutionV2(prepare(), vi.fn());
    expect(() =>
      readPreparedProviderExecutionV2(
        execution,
        validateProfileExecutionConfigV2({
          ...fixtures.deepseek,
          modelId: "different-model",
        }),
      ),
    ).toThrow();
  });
});
