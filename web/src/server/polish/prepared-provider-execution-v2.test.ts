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

function prepare() {
  return prepareProviderTransportV2({
    profile: PROFILE,
    recipient: {
      providerId: fixtures.deepseek.providerId,
      recipientKey: "deepseek",
    },
    resolveSecret: () => "fake-provider-key",
  });
}

describe("prepared provider execution v2", () => {
  it("derives the provider from one opaque transport", () => {
    const execution = createPreparedProviderExecutionV2(prepare(), vi.fn());
    const facts = readPreparedProviderExecutionV2(
      execution,
      PROFILE,
    );
    expect(Object.keys(execution)).toEqual(["schemaVersion"]);
    expect("provider" in execution).toBe(false);
    expect(Object.isFrozen(facts.provider)).toBe(true);
  });

  it("rejects a crossed or copied execution before either transport can send", () => {
    const fetchA = vi.fn<typeof fetch>();
    const fetchB = vi.fn<typeof fetch>();
    const executionA = createPreparedProviderExecutionV2(
      prepare(),
      fetchA,
    );
    createPreparedProviderExecutionV2(
      prepare(),
      fetchB,
    );
    const crossed = {
      ...executionA,
      provider: { complete: vi.fn() },
    };

    expect(isPreparedProviderExecutionV2(crossed)).toBe(false);
    expect(() =>
      readPreparedProviderExecutionV2(crossed, PROFILE),
    ).toThrow();
    expect(fetchA).not.toHaveBeenCalled();
    expect(fetchB).not.toHaveBeenCalled();
  });

  it("does not expose a mutable provider on the branded token", () => {
    const execution = createPreparedProviderExecutionV2(prepare(), vi.fn());
    expect(() =>
      Object.defineProperty(execution, "provider", {
        value: { complete: vi.fn() },
      }),
    ).toThrow();
    const facts = readPreparedProviderExecutionV2(execution, PROFILE);
    expect(() =>
      Object.defineProperty(facts.provider, "complete", {
        value: vi.fn(),
      }),
    ).toThrow();
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
