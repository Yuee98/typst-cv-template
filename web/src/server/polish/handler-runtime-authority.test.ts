import { afterEach, describe, expect, it, vi } from "vitest";

import { createRealPolishRuntimeAuthorityV2 } from "./handler-runtime-authority";
import { resolveProfile } from "./profile-registry";
import profileExecutionFixtures from "../../../test/fixtures/profile-execution-v2.json";
import {
  isPreparedProviderExecutionV2,
  readPreparedProviderExecutionV2,
} from "./prepared-provider-execution-v2";
import { validateProfileExecutionConfigV2 } from "./profile-execution-v2";
import { parseRuntimeDeploymentIdentityV1 } from "./runtime-deployment-v1";
import {
  DEEPSEEK_MIMO_DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1,
  DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1,
  DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1,
} from "./service-runtime-contract-v1";

const SUPERSEDED_COMBINED_CONTRACT_ID =
  "runtime.deepseek-v2-mimo-v2.5-pro.v1";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("real V2 handler runtime authority", () => {
  it("composes a v2 snapshot through the prepared transport boundary", () => {
    const profile = validateProfileExecutionConfigV2(
      profileExecutionFixtures.deepseek,
    );
    const profileVersionId = "706513a5-462b-4bba-93b0-53e50661416e";
    const priceVersionId = "d1a481e6-5baf-4b2f-8f2d-da28c2b92ed9";
    const fetchImpl = vi.fn<typeof fetch>();
    const manifest = {
      schemaVersion: "ai_provider_bindings_v1",
      revision: "binding-v2-test",
      bindings: [
        {
          credentialEnvName: profile.credentialEnvName,
          providerId: profile.providerId,
          recipientKey: "deepseek",
          origin: "https://api.deepseek.com",
        },
      ],
    };
    const env = {
      AI_RUNTIME_BUILD_ID: "build-v2-test",
      AI_PROVIDER_BINDING_MANIFEST: JSON.stringify(manifest),
      [profile.credentialEnvName]: "test-only-provider-key",
    };
    const deployment = parseRuntimeDeploymentIdentityV1(env);
    const authority = createRealPolishRuntimeAuthorityV2(
      env,
      { fetch: fetchImpl },
    );
    const target = {
      schemaVersion: "runtime_execution_target_v2" as const,
      runtimeContractId: "runtime.v2.test",
      legalBundleVersion: "legal.v2.test",
      profileVersionId,
      profile,
      evidence: {
        schemaVersion: "runtime_execution_evidence_v2" as const,
        runtimeContractId: "runtime.v2.test",
        runtimeTargetId: "target.v2.test",
        runtimeTargetSha256: "a".repeat(64),
        routeDescriptorId: "route.v2.test",
        routeDescriptorSha256: "b".repeat(64),
        profileVersionId,
        priceVersionId,
        providerId: profile.providerId,
        recipientKey: "deepseek",
        codeCapabilityId: profile.capabilityContractId,
        codeCapabilitySha256: "c".repeat(64),
        gatewayKind: profile.gatewayKind,
        adapterKind: profile.adapterKind,
        wireApiKind: profile.wireApiKind,
        endpointUrl: profile.endpointUrl,
        credentialEnvName: profile.credentialEnvName,
        modelId: profile.modelId,
        capabilityContractId: profile.capabilityContractId,
        cachePolicyId: profile.cachePolicyId,
        calculatorKind: profile.calculatorKind,
        legalBundleVersion: "legal.v2.test",
        legalManifestId: profile.legalManifestId,
        legalManifestSha256: "d".repeat(64),
        displayDisclosureKey: profile.displayDisclosureKey,
        externalEvidenceIds: ["evidence.v2.test"],
      },
      deploymentValidation: {
        schemaVersion: "runtime_deployment_admission_v2" as const,
        admissionId: "706513a5-462b-4bba-93b0-53e50661416e",
        reviewedDeploymentId: priceVersionId,
        validationReportId: "806513a5-462b-4bba-93b0-53e50661416e",
        environment: "local" as const,
        projectRef: "test-project",
        runtimeBuildId: "build-v2-test",
        bindingManifestRevision: "binding-v2-test",
        bindingManifestSha256: deployment.manifestSha256,
        admissionRevision: "1",
        targetSetSha256: "f".repeat(64),
        runtimeContractId: "runtime.v2.test",
        runtimeTargetId: "target.v2.test",
        runtimeTargetSha256: "a".repeat(64),
        profileVersionId,
        priceVersionId,
        providerId: profile.providerId,
        codeCapabilityId: profile.capabilityContractId,
        codeCapabilitySha256: "c".repeat(64),
        legalBundleVersion: "legal.v2.test",
        legalManifestId: profile.legalManifestId,
        displayDisclosureKey: profile.displayDisclosureKey,
      },
    };
    const execution = authority.resolveProvider(profile, target);
    expect(isPreparedProviderExecutionV2(execution)).toBe(true);
    expect(readPreparedProviderExecutionV2(execution, profile).runtimeProvenance).toEqual({
      runtimeBuildId: "build-v2-test", bindingManifestRevision: "binding-v2-test",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() =>
      authority.resolveProvider(profile, {
        ...target,
        evidence: { ...target.evidence, recipientKey: "xiaomi-mimo" },
      }),
    ).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["development", undefined],
    ["production", "true"],
  ] as const)(
    "rejects single-flag fake inference with the real backend in %s/CI=%s",
    (nodeEnv, ci) => {
      expect(() =>
        createRealPolishRuntimeAuthorityV2({
          NODE_ENV: nodeEnv,
          CI: ci,
          POLISH_FAKE_LLM: "true",
          POLISH_FAKE_BACKEND: undefined,
        }),
      ).toThrow(/requires POLISH_FAKE_BACKEND=true/);
    },
  );

  it("admits legacy DeepSeek and both exact combined-v2 targets", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const authority = createRealPolishRuntimeAuthorityV2({
      POLISH_FAKE_LLM: "false",
      DEEPSEEK_API_KEY: "test-only-deepseek-key",
      MIMO_API_KEY: "test-only-mimo-key",
    });

    expect(
      authority.runtimeTargetResolver(
        structuredClone(DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1),
      ),
    ).toBe(true);
    expect(
      authority.runtimeTargetResolver(
        structuredClone(DEEPSEEK_MIMO_DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1),
      ),
    ).toBe(true);
    expect(
      authority.runtimeTargetResolver(
        structuredClone(DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1),
      ),
    ).toBe(true);
    expect(
      authority.resolveProvider(
        resolveProfile("deepseek.official.deepseek-v4-flash.chat.v1"),
      ),
    ).toMatchObject({ kind: "deepseek_chat_v1" });
    expect(
      authority.resolveProvider(
        resolveProfile("mimo.cn.mimo-v2.5-pro.responses.v1"),
      ),
    ).toMatchObject({ kind: "mimo_responses_v1" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [
      "superseded DeepSeek target",
      DEEPSEEK_MIMO_DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1,
    ],
    ["superseded MiMo target", DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1],
  ])("rejects the old combined-v1 pair for %s", (_label, target) => {
    const authority = createRealPolishRuntimeAuthorityV2({
      POLISH_FAKE_LLM: "false",
    });
    const superseded = {
      ...structuredClone(target),
      runtimeContractId: SUPERSEDED_COMBINED_CONTRACT_ID,
    };

    expect(authority.runtimeTargetResolver(superseded)).toBe(false);
  });

  it("rejects crossed target/profile/route tuples and unknown targets", () => {
    const authority = createRealPolishRuntimeAuthorityV2({
      POLISH_FAKE_LLM: "false",
    });
    const crossedProfile = {
      ...structuredClone(DEEPSEEK_MIMO_DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1),
      profileKey: DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1.profileKey,
    };
    const crossedRoute = {
      ...structuredClone(DEEPSEEK_MIMO_DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1),
      routeDescriptor: structuredClone(
        DEEPSEEK_MIMO_MIMO_RUNTIME_EXECUTION_TARGET_V1.routeDescriptor,
      ),
    };
    const unknown = {
      ...structuredClone(DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1),
      runtimeContractId: "runtime.unknown.v1",
    };

    expect(authority.runtimeTargetResolver(crossedProfile)).toBe(false);
    expect(authority.runtimeTargetResolver(crossedRoute)).toBe(false);
    expect(authority.runtimeTargetResolver(unknown)).toBe(false);
  });

  it("fails a selected route with a missing credential without provider substitution", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const mimoOnly = createRealPolishRuntimeAuthorityV2({
      POLISH_FAKE_LLM: "false",
      MIMO_API_KEY: "test-only-mimo-key",
    });
    const deepSeekOnly = createRealPolishRuntimeAuthorityV2({
      POLISH_FAKE_LLM: "false",
      DEEPSEEK_API_KEY: "test-only-deepseek-key",
    });

    expect(() =>
      mimoOnly.resolveProvider(
        resolveProfile("deepseek.official.deepseek-v4-flash.chat.v1"),
      ),
    ).toThrow(/credential deepseek_api_key is unavailable/u);
    expect(() =>
      deepSeekOnly.resolveProvider(
        resolveProfile("mimo.cn.mimo-v2.5-pro.responses.v1"),
      ),
    ).toThrow(/credential mimo_api_key is unavailable/u);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
