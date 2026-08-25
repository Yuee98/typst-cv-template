import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  resolveDisplayDisclosure,
  resolveEndpoint,
  validateAdapterConfig,
} from "./adapter-registry";
import {
  LEGAL_FINGERPRINT_V1_DESCRIPTORS,
  LEGAL_FINGERPRINT_V1_PROFILE_MAPPING,
} from "./legal-fingerprint-v1-descriptors";
import { MIMO_V2_SEED_IDENTITY_V1 } from "./mimo-v2-seed-identity-v1";
import { resolveProfile } from "./profile-registry";

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

function expectDeeplyFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) {
    expectDeeplyFrozen(child);
  }
}

describe("CFG-002 MiMo V2 seed identity", () => {
  it("freezes the accepted stable identity graph", () => {
    expectDeeplyFrozen(MIMO_V2_SEED_IDENTITY_V1);
    expect(MIMO_V2_SEED_IDENTITY_V1).toMatchObject({
      profile: {
        id: "22222222-2222-4222-8222-222222222220",
        profileVersionId: "22222222-2222-4222-8222-222222222221",
        profileKey: "mimo.cn.mimo-v2.5-pro.responses.v1",
        modelVendor: "xiaomi-mimo",
        modelSnapshot: null,
      },
      runtime: {
        runtimeTargetId: "runtime-target.mimo.cn.mimo-v2.5-pro.responses.v1",
        runtimeContractId: "runtime.deepseek-v2-mimo-v2.5-pro.v1",
      },
      pricing: {
        reservedDefaultPriceVersionId:
          "22222222-2222-4222-8222-222222222222",
      },
    });
  });

  it("matches the code-owned profile, adapter, endpoint, and disclosure registries", () => {
    const { profile } = MIMO_V2_SEED_IDENTITY_V1;
    expect({
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
    }).toEqual(resolveProfile(profile.profileKey));
    expect(validateAdapterConfig(profile.adapterKind, profile.config)).toEqual(
      profile.config,
    );
    expect(resolveEndpoint(profile.endpointAlias).url).toBe(
      profile.canonicalEndpointUrl,
    );
    expect(resolveDisplayDisclosure(profile.displayDisclosureKey)).toEqual({
      key: profile.displayDisclosureKey,
      providerName: "MiMo",
      modelName: profile.displayName,
    });
  });

  it("matches the reviewed legal route, manifest, vendor, and config identity", () => {
    const { profile } = MIMO_V2_SEED_IDENTITY_V1;
    const mapping = LEGAL_FINGERPRINT_V1_PROFILE_MAPPING.find(
      (candidate) => candidate.profileKey === profile.profileKey,
    );
    const route = LEGAL_FINGERPRINT_V1_DESCRIPTORS.routes.find(
      (candidate) => candidate.route_descriptor_id === profile.routeDescriptorId,
    );

    expect(mapping).toMatchObject({
      manifestId: profile.legalManifestId,
      routeDescriptorId: profile.routeDescriptorId,
      displayDisclosureKey: profile.displayDisclosureKey,
      configJcsUtf8Hex: profile.configJcsUtf8Hex,
      configJcsSha256: profile.configSha256,
    });
    expect(route).toMatchObject({
      profile_key: profile.profileKey,
      gateway_kind: profile.gatewayKind,
      model_vendor_id: profile.modelVendor,
      model_id: profile.modelId,
      wire_api_kind: profile.wireApiKind,
      endpoint_alias: profile.endpointAlias,
      canonical_endpoint_url: profile.canonicalEndpointUrl,
      display_disclosure_key: profile.displayDisclosureKey,
    });
  });

  it("independently reproduces the accepted config JCS vector", () => {
    const { profile } = MIMO_V2_SEED_IDENTITY_V1;
    const bytes = Buffer.from(canonicalize(profile.config), "utf8");
    expect(bytes.toString("hex")).toBe(profile.configJcsUtf8Hex);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      profile.configSha256,
    );
  });

  it("reserves no price fact beyond the stable UUID", () => {
    expect(Object.keys(MIMO_V2_SEED_IDENTITY_V1.pricing)).toEqual([
      "reservedDefaultPriceVersionId",
    ]);
    const serialized = JSON.stringify(MIMO_V2_SEED_IDENTITY_V1.pricing);
    for (const forbidden of [
      "source",
      "valid",
      "component",
      "currency",
      "calculator",
      "nanos",
      "seedAuthorized",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
