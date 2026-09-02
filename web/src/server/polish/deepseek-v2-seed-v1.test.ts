import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import routingFixture from "../../../test/fixtures/routing-rules-v1.json";
import {
  resolveDisplayDisclosure,
  resolveEndpoint,
  validateAdapterConfig,
} from "./adapter-registry";
import { DEEPSEEK_V2_SEED_V1 } from "./deepseek-v2-seed-v1";
import { LEGAL_FINGERPRINT_V1_PROFILE_MAPPING } from "./legal-fingerprint-v1-descriptors";
import { resolveProfile } from "./profile-registry";
import { validateRoutingRulesV1 } from "./routing-rules-v1";
import {
  DEEPSEEK_RUNTIME_CONTRACT_DB_FIXTURE_V1,
  DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1,
} from "./service-runtime-contract-v1";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("unsupported JSON scalar");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalize(
          (value as { readonly [key: string]: JsonValue })[key],
        )}`,
    )
    .join(",")}}`;
}

function jcsVector(value: JsonValue): { hex: string; sha256: string } {
  const bytes = Buffer.from(canonicalize(value), "utf8");
  return {
    hex: bytes.toString("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function expectDeeplyFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) {
    expectDeeplyFrozen(child);
  }
}

describe("CFG-001 DeepSeek V2 seed fixture", () => {
  it("is a deeply frozen literal graph", () => {
    expectDeeplyFrozen(DEEPSEEK_V2_SEED_V1);
  });

  it("matches the code-owned execution, route, legal, and disclosure authorities", () => {
    const { profile } = DEEPSEEK_V2_SEED_V1;
    const resolved = resolveProfile(profile.profileKey);
    const executionProjection = {
      schemaVersion: "profile_execution_config_v1",
      profileKey: profile.profileKey,
      gatewayKind: profile.gatewayKind,
      adapterKind: profile.adapterKind,
      wireApiKind: profile.wireApiKind,
      credentialAlias: profile.credentialAlias,
      endpointAlias: profile.endpointAlias,
      modelId: profile.modelId,
      capabilityContractId: profile.capabilityContractId,
      cachePolicyId: profile.cachePolicyId,
      legalManifestId: profile.legalManifestId,
      calculatorKind: profile.calculatorKind,
      displayDisclosureKey: profile.displayDisclosureKey,
      config: profile.config,
    };

    expect(executionProjection).toEqual(resolved);
    expect(validateAdapterConfig(profile.adapterKind, profile.config)).toEqual(
      profile.config,
    );
    expect(resolveEndpoint(profile.endpointAlias).url).toBe(
      profile.canonicalEndpointUrl,
    );

    const runtimeRoute = DEEPSEEK_RUNTIME_EXECUTION_TARGET_V1.routeDescriptor;
    expect(runtimeRoute).toEqual({
      gatewayKind: profile.gatewayKind,
      adapterKind: profile.adapterKind,
      wireApiKind: profile.wireApiKind,
      credentialAlias: profile.credentialAlias,
      endpointAlias: profile.endpointAlias,
      modelId: profile.modelId,
      capabilityContractId: profile.capabilityContractId,
      cachePolicyId: profile.cachePolicyId,
      calculatorKind: profile.calculatorKind,
      displayDisclosureKey: profile.displayDisclosureKey,
    });

    const legal = LEGAL_FINGERPRINT_V1_PROFILE_MAPPING.find(
      (candidate) => candidate.profileKey === profile.profileKey,
    );
    expect(legal).toMatchObject({
      manifestId: profile.legalManifestId,
      routeDescriptorId: profile.routeDescriptorId,
      displayDisclosureKey: profile.displayDisclosureKey,
      configJcsUtf8Hex: profile.configJcsUtf8Hex,
      configJcsSha256: profile.configSha256,
    });
    expect(legal?.descriptorVendorName.toLowerCase()).toBe(profile.modelVendor);
    expect(resolveDisplayDisclosure(profile.displayDisclosureKey)).toEqual({
      key: profile.displayDisclosureKey,
      providerName: legal?.descriptorVendorName,
      modelName: profile.displayName,
    });
  });

  it("copies the reviewed runtime DB fixture exactly without deriving a new root", () => {
    expect(DEEPSEEK_V2_SEED_V1.runtime).toEqual(
      DEEPSEEK_RUNTIME_CONTRACT_DB_FIXTURE_V1,
    );
  });

  it("copies the existing G2 DeepSeek-only routing rules exactly", () => {
    const rules = validateRoutingRulesV1(DEEPSEEK_V2_SEED_V1.policy.rules);
    expect(rules).toEqual(routingFixture.validRules.g2DeepseekOnly);
    expect(JSON.stringify(rules)).not.toContain("mimo");
    expect(new Set(rules.windows.map((window) => window.route.profileVersionId))).toEqual(
      new Set([DEEPSEEK_V2_SEED_V1.profile.profileVersionId]),
    );
  });

  it("independently reproduces the frozen profile and policy JCS vectors", () => {
    const profileVector = jcsVector(DEEPSEEK_V2_SEED_V1.profile.config);
    expect(profileVector).toEqual({
      hex: DEEPSEEK_V2_SEED_V1.profile.configJcsUtf8Hex,
      sha256: DEEPSEEK_V2_SEED_V1.profile.configSha256,
    });

    const policyVector = jcsVector(DEEPSEEK_V2_SEED_V1.policy.jcsInput);
    expect(policyVector).toEqual({
      hex: DEEPSEEK_V2_SEED_V1.policy.jcsUtf8Hex,
      sha256: DEEPSEEK_V2_SEED_V1.policy.configSha256,
    });
  });

  it("binds the versioned runtime contract ID into the policy hash", () => {
    const changed = {
      ...DEEPSEEK_V2_SEED_V1.policy.jcsInput,
      runtimeContractId: "runtime.deepseek-v2.v2",
    };

    expect(jcsVector(changed).sha256).not.toBe(
      DEEPSEEK_V2_SEED_V1.policy.configSha256,
    );
  });
});
