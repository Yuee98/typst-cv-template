import { describe, expect, it } from "vitest";

import fixture from "../../../test/fixtures/profile-execution-v2.json";
import { validateProfileExecutionConfigV2 } from "./profile-execution-v2";
import {
  COMPILED_RUNTIME_CODE_CAPABILITIES_V2,
  resolveProfileRuntimeCodeCapabilityV2,
  resolveRuntimeCodeCapabilityV2,
  runtimeCodeCapabilitySha256V2,
} from "./runtime-code-capability-v2";

describe("runtime code capability v2", () => {
  it("freezes distinct capability evidence for each compiled adapter", () => {
    expect(COMPILED_RUNTIME_CODE_CAPABILITIES_V2).toHaveLength(2);
    expect(
      COMPILED_RUNTIME_CODE_CAPABILITIES_V2.map((value) => ({
        id: value.codeCapabilityId,
        hash: value.descriptorSha256,
      })),
    ).toEqual([
      {
        id: "runtime-capability.deepseek-chat-v1.2026-09-04",
        hash: "4e5a92750f77f148e6422dcf05b03d99333b357879dba5fdb7248d16dd08bdf2",
      },
      {
        id: "runtime-capability.mimo-responses-v1.2026-09-04",
        hash: "3d26f7177a60396d63c0c09e7fad914b7a090bad6222c3836482ba512a009b5e",
      },
    ]);
    for (const capability of COMPILED_RUNTIME_CODE_CAPABILITIES_V2) {
      const { descriptorSha256, ...descriptor } = capability;
      expect(runtimeCodeCapabilitySha256V2(descriptor)).toBe(
        descriptorSha256,
      );
      expect(Object.isFrozen(capability)).toBe(true);
      expect(Object.isFrozen(capability.implementationEvidenceIds)).toBe(true);
    }
  });

  it("intersects a profile with exact compiled semantics", () => {
    const profile = validateProfileExecutionConfigV2(fixture.deepseek);
    expect(resolveProfileRuntimeCodeCapabilityV2(profile)).toBe(
      resolveRuntimeCodeCapabilityV2(
        "runtime-capability.deepseek-chat-v1.2026-09-04",
      ),
    );
  });

  it("does not infer support from an unknown capability id", () => {
    expect(() =>
      resolveRuntimeCodeCapabilityV2("runtime-capability.future"),
    ).toThrow("not compiled");
  });
});
