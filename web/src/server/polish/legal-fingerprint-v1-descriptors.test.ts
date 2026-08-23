import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as descriptorModule from "./legal-fingerprint-v1-descriptors";
import * as en from "@/content/legal/en";
import * as zh from "@/content/legal/zh";
import {
  resolveDisplayDisclosure,
  resolveEndpoint,
  resolveLegalManifest,
} from "./adapter-registry";
import {
  DEEPSEEK_LEGAL_MANIFEST_ID,
  deriveRequiredServiceFactPairs,
  INITIAL_LEGAL_BUNDLE_VERSION,
  LEGAL_FINGERPRINT_V1_DESCRIPTORS,
  LEGAL_FINGERPRINT_V1_EXPECTED_SHA256,
  LEGAL_FINGERPRINT_V1_PROFILE_MAPPING,
  isLegalFingerprintV1RegistryFactId,
  LegalFingerprintDescriptorV1Error,
  MIMO_LEGAL_MANIFEST_ID,
  validateLegalFingerprintV1Closure,
} from "./legal-fingerprint-v1-descriptors";
import { fingerprintLegalDescriptorV1 } from "./legal-fingerprint-v1";
import { resolveProfile } from "./profile-registry";
import {
  PROVIDER_SUBJECT_V2_ALGORITHM,
  PROVIDER_SUBJECT_V2_DERIVATION_MESSAGE_SCHEMA,
  PROVIDER_SUBJECT_V2_SECRET_CLASS,
} from "./provider-subject-v2";

const graph = LEGAL_FINGERPRINT_V1_DESCRIPTORS;

const INDEPENDENT_FIELD_ORDER: Record<string, readonly string[]> = {
  ai_legal_route_identity_v1: ["schema_version","route_descriptor_id","profile_key","gateway_kind","operator_identity_status","operator_legal_name","model_vendor_id","model_vendor_name","model_id","wire_api_kind","endpoint_alias","canonical_endpoint_url","display_disclosure_key"],
  ai_legal_provider_subject_v1: ["schema_version","subject_descriptor_id","mode","wire_field","algorithm","secret_class","derivation_message_schema","output_encoding","source_identity_class","raw_email_sent","raw_username_sent","raw_account_id_sent","documented_purposes"],
  ai_legal_manifest_fingerprint_v1: ["schema_version","manifest_id","display_disclosure_key","reviewed_at","route_descriptor_ids","route_descriptor_sha256s","subject_descriptor_id","subject_descriptor_sha256","fact_ids","fact_sha256s","evidence_ids","evidence_sha256s"],
  ai_legal_bundle_semantic_contract_v1: ["schema_version","contract_id","contract_kind","fact_ids","fact_sha256s","evidence_ids","evidence_sha256s"],
  ai_legal_bundle_contract_fingerprint_v1: ["schema_version","legal_bundle_version","document_key","ai_terms_version","manifest_fingerprint_schema_version","semantic_contract_schema_version","neutral_body_contract_id","neutral_body_contract_sha256","privacy_ai_contract_id","privacy_ai_contract_sha256","acceptance_contract_id","acceptance_contract_sha256","route_disclosure_contract_id","route_disclosure_contract_sha256","material_change_contract_id","material_change_contract_sha256","manifest_ids","manifest_sha256s"],
};

function independentFingerprint(descriptor: Record<string, unknown>): string {
  const byteLength = (value: string) => new TextEncoder().encode(value).length;
  let stream = "ai_fingerprint_record_v1\n";
  const append = (key: string, value: string) => {
    stream += `${byteLength(key)}:${key}:${byteLength(value)}:${value}\n`;
  };
  const values = Object.fromEntries(Object.entries(descriptor).map(([key, value]) => [
    key,
    Array.isArray(value) ? [...value] : value,
  ])) as Record<string, unknown>;
  for (const key of ["documented_purposes", "qualifiers"]) {
    if (Array.isArray(values[key])) {
      values[key] = [...values[key] as string[]].sort((left, right) =>
        Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
      );
    }
  }
  for (const key of Object.keys(values).filter((item) => item.endsWith("_ids"))) {
    const hashesKey = `${key.slice(0, -4)}_sha256s`;
    if (!Array.isArray(values[hashesKey])) continue;
    const pairs = (values[key] as string[]).map((id, index) => [id, (values[hashesKey] as string[])[index]] as const)
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
    values[key] = pairs.map(([id]) => id);
    values[hashesKey] = pairs.map(([, hash]) => hash);
  }
  for (const key of INDEPENDENT_FIELD_ORDER[descriptor.schema_version as string]) {
    const value = values[key];
    if (Array.isArray(value)) {
      append(`${key}.count`, String(value.length));
      value.forEach((item, index) => append(`${key}.${index}`, item as string));
    } else {
      append(key, typeof value === "boolean" ? String(value) : value as string);
    }
  }
  return createHash("sha256").update(new TextEncoder().encode(stream)).digest("hex");
}

function independentJcs(value: Record<string, string | boolean>): string {
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`).join(",")}}`;
}

function descriptorId(descriptor: Record<string, unknown>): string {
  switch (descriptor.schema_version) {
    case "ai_legal_route_identity_v1": return descriptor.route_descriptor_id as string;
    case "ai_legal_provider_subject_v1": return descriptor.subject_descriptor_id as string;
    case "ai_legal_fact_v1": return descriptor.fact_id as string;
    case "ai_legal_source_evidence_v1": return descriptor.evidence_id as string;
    case "ai_legal_manifest_fingerprint_v1": return descriptor.manifest_id as string;
    case "ai_legal_bundle_semantic_contract_v1": return descriptor.contract_id as string;
    case "ai_legal_bundle_contract_fingerprint_v1": return descriptor.legal_bundle_version as string;
    default: throw new Error("unexpected descriptor schema");
  }
}

describe("initial legal fingerprint v1 descriptors", () => {
  it("has a complete root-local authority closure with immutable one-to-one referents", () => {
    expect(validateLegalFingerprintV1Closure).not.toThrow();
    const all = [
      ...graph.routes, ...graph.subjects, ...graph.facts, ...graph.evidence,
      ...graph.manifests, ...graph.semanticContracts, graph.bundleContract,
    ];
    const ids = all.map((item) => descriptorId(item));
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(LEGAL_FINGERPRINT_V1_EXPECTED_SHA256)).toHaveLength(12);
    const reviewed = LEGAL_FINGERPRINT_V1_EXPECTED_SHA256 as Readonly<Record<string, string>>;
    for (const descriptor of all.filter((item) =>
      Object.hasOwn(LEGAL_FINGERPRINT_V1_EXPECTED_SHA256, descriptorId(item)),
    )) {
      const id = descriptorId(descriptor);
      expect(fingerprintLegalDescriptorV1(descriptor).sha256).toBe(
        reviewed[id],
      );
      expect(independentFingerprint(descriptor)).toBe(reviewed[id]);
    }
  });

  it("binds the exact initial bundle, manifest IDs, schema referents, and five semantic roots", () => {
    expect(graph.bundleContract).toMatchObject({
      legal_bundle_version: INITIAL_LEGAL_BUNDLE_VERSION,
      ai_terms_version: INITIAL_LEGAL_BUNDLE_VERSION,
      document_key: "ai_terms",
      manifest_fingerprint_schema_version: "ai_legal_manifest_fingerprint_v1",
      semantic_contract_schema_version: "ai_legal_bundle_semantic_contract_v1",
    });
    expect(graph.bundleContract.manifest_ids).toEqual([
      DEEPSEEK_LEGAL_MANIFEST_ID,
      MIMO_LEGAL_MANIFEST_ID,
    ]);
    expect(graph.semanticContracts.map((item) => item.contract_kind).sort()).toEqual([
      "acceptance", "material-change", "neutral-body", "privacy-ai", "route-disclosure",
    ]);
  });

  it("maps route descriptors exactly to the code registries and bilingual provider manifests", () => {
    for (const route of graph.routes) {
      const profile = resolveProfile(route.profile_key);
      const legalEn = en.aiProviderLegalManifests.find((item) => item.manifestId === profile.legalManifestId)!;
      const legalZh = zh.aiProviderLegalManifests.find((item) => item.manifestId === profile.legalManifestId)!;
      expect(resolveEndpoint(profile.endpointAlias).url).toBe(route.canonical_endpoint_url);
      expect(profile.gatewayKind).toBe(route.gateway_kind);
      expect(profile.wireApiKind).toBe(route.wire_api_kind);
      expect(profile.modelId).toBe(route.model_id);
      expect(profile.displayDisclosureKey).toBe(route.display_disclosure_key);
      expect(resolveLegalManifest(profile.legalManifestId).id).toBe(profile.legalManifestId);
      expect(resolveDisplayDisclosure(route.display_disclosure_key).providerName).toBeTruthy();
      expect(legalEn.displayKey).toBe(route.display_disclosure_key);
      expect(legalZh.displayKey).toBe(route.display_disclosure_key);
      expect(legalEn.models.join(" ")).toContain(route.model_id);
      expect(legalZh.models.join(" ")).toContain(route.model_id);
      expect(legalEn.modelVendor).toBe(route.model_vendor_name);
      expect(legalZh.modelVendor).toBe(route.model_vendor_name);
      expect(legalEn.upstream).toContain(new URL(route.canonical_endpoint_url).hostname);
      expect(legalZh.upstream).toContain(new URL(route.canonical_endpoint_url).hostname);
      const providerEvidence = graph.evidence.filter((item) =>
        item.authority_kind === "provider-official" &&
        item.evidence_id.startsWith(route.profile_key.startsWith("deepseek.") ? "evidence.deepseek." : "evidence.mimo."),
      );
      expect(providerEvidence.every((item) => legalEn.sources.includes(item.source_locator as `https://${string}`))).toBe(true);
      expect(providerEvidence.every((item) => legalZh.sources.includes(item.source_locator as `https://${string}`))).toBe(true);
    }
    for (const mapping of LEGAL_FINGERPRINT_V1_PROFILE_MAPPING) {
      expect(en.aiProviderLegalManifests.find((item) => item.manifestId === mapping.manifestId)?.gatewayOperator).toBe(mapping.enOperatorDisplay);
      expect(zh.aiProviderLegalManifests.find((item) => item.manifestId === mapping.manifestId)?.gatewayOperator).toBe(mapping.zhOperatorDisplay);
    }
    expect(en.deepseekLegalManifest.gatewayOperator).toBe(graph.routes[0].operator_legal_name);
    expect(en.mimoLegalManifest.gatewayOperator).toMatch(/do not identify the specific company/u);
    expect(zh.mimoLegalManifest.gatewayOperator).toMatch(/未明确.*具体公司/u);
    expect(graph.routes.find((route) => route.profile_key.startsWith("mimo."))).toMatchObject({
      operator_identity_status: "unverified",
      operator_legal_name: "",
    });
  });

  it("freezes the independently generated RFC 8785 vectors for both strict adapter configs", () => {
    for (const mapping of LEGAL_FINGERPRINT_V1_PROFILE_MAPPING) {
      const profile = resolveProfile(mapping.profileKey);
      const jcs = independentJcs(profile.config as unknown as Record<string, string | boolean>);
      const bytes = new TextEncoder().encode(jcs);
      expect(Buffer.from(bytes).toString("hex")).toBe(mapping.configJcsUtf8Hex);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(mapping.configJcsSha256);
      const route = graph.routes.find((item) => item.route_descriptor_id === mapping.routeDescriptorId)!;
      expect(route.display_disclosure_key).toBe(mapping.displayDisclosureKey);
      expect(route.model_vendor_name).toBe(mapping.descriptorVendorName);
      expect(profile.legalManifestId).toBe(mapping.manifestId);
      expect(en.aiProviderLegalManifests.find((item) => item.manifestId === mapping.manifestId)?.provider).toBe(mapping.enProviderDisplay);
      expect(zh.aiProviderLegalManifests.find((item) => item.manifestId === mapping.manifestId)?.provider).toBe(mapping.zhProviderDisplay);
    }
  });

  it("binds DeepSeek's exact reviewed V2 subject contract and MiMo's explicit none mode", () => {
    const deepseek = graph.subjects.find((item) => item.subject_descriptor_id.startsWith("subject.deepseek"))!;
    const mimo = graph.subjects.find((item) => item.subject_descriptor_id.startsWith("subject.mimo"))!;
    expect(deepseek).toMatchObject({
      mode: "pseudonymous_hmac",
      wire_field: "user_id",
      algorithm: PROVIDER_SUBJECT_V2_ALGORITHM,
      secret_class: PROVIDER_SUBJECT_V2_SECRET_CLASS,
      derivation_message_schema: PROVIDER_SUBJECT_V2_DERIVATION_MESSAGE_SCHEMA,
      output_encoding: "lowercase-hex",
      source_identity_class: "authenticated-user-id",
      raw_email_sent: false,
      raw_username_sent: false,
      raw_account_id_sent: false,
    });
    expect(deepseek.documented_purposes).toEqual([
      "cache-isolation", "content-safety", "scheduling-isolation",
    ]);
    expect(mimo).toMatchObject({
      mode: "none", wire_field: "", algorithm: "", secret_class: "",
      derivation_message_schema: "", output_encoding: "", source_identity_class: "",
      documented_purposes: [],
    });
  });

  it("references real regular Git blobs and exact blob-content SHA-256 for every service evidence", () => {
    for (const evidence of graph.evidence.filter((item) => item.source_locator_kind === "repo-path")) {
      const type = execFileSync("git", ["cat-file", "-t", `HEAD:${evidence.source_locator}`], { encoding: "utf8" }).trim();
      const blob = execFileSync("git", ["cat-file", "blob", `HEAD:${evidence.source_locator}`]);
      expect(type).toBe("blob");
      expect(createHash("sha256").update(blob).digest("hex")).toBe(evidence.upstream_snapshot_sha256);
    }
    expect(new Set(graph.evidence.filter((item) => item.source_locator_kind === "repo-path").map((item) => item.source_locator))).toEqual(new Set([
      "docs/ai-provider-contract.md",
      "web/src/server/polish/adapter-registry.ts",
      "web/src/server/polish/profile-registry.ts",
      "web/src/server/polish/provider-subject-v2.ts",
      "web/src/server/polish/provider-subject-v2.test.ts",
      "web/src/content/legal/en.ts",
      "web/src/content/legal/zh.ts",
    ]));
    const derivationEvidence = graph.evidence.filter((item) =>
      item.supported_fact_ids.includes("fact.deepseek.subject.derivation.v1"),
    );
    expect(derivationEvidence.map((item) => item.authority_kind).sort()).toEqual([
      "service-contract", "service-implementation", "service-test",
    ]);
    expect(derivationEvidence.map((item) => item.source_locator)).toContain(
      "web/src/server/polish/provider-subject-v2.ts",
    );
    expect(derivationEvidence.map((item) => item.source_locator)).toContain(
      "web/src/server/polish/provider-subject-v2.test.ts",
    );
  });

  it("derives the exact global/profile service-operational closure without provider or display facts", () => {
    const deepseek = deriveRequiredServiceFactPairs(new Set([
      "deepseek.official.deepseek-v4-flash.chat.v1",
    ]));
    const ids = deepseek.map((item) => item.id);
    expect(ids).toContain("fact.deepseek.subject.derivation.v1");
    expect(ids).toContain("fact.route.change-gate.v1");
    expect(ids).not.toContain("fact.mimo.subject.none.v1");
    expect(ids).not.toContain("fact.deepseek.training.v1");
    expect(ids).not.toContain("fact.output-review.v1");
    expect(new Set(ids).size).toBe(ids.length);
    expect(deepseek).toEqual([...deepseek].sort((left, right) =>
      Buffer.compare(Buffer.from(left.id, "utf8"), Buffer.from(right.id, "utf8")),
    ));
  });

  it("derives exact immutable DeepSeek, MiMo, and combined bound service-fact sets", () => {
    const deepseekKey = "deepseek.official.deepseek-v4-flash.chat.v1";
    const mimoKey = "mimo.cn.mimo-v2.5-pro.responses.v1";
    const deepseek = deriveRequiredServiceFactPairs(new Set([deepseekKey]));
    const mimo = deriveRequiredServiceFactPairs(new Set([mimoKey]));
    const combined = deriveRequiredServiceFactPairs(new Set([mimoKey, deepseekKey]));

    expect(deepseek.map((item) => item.id)).toContain("fact.privacy.recipient.deepseek.v1");
    expect(deepseek.map((item) => item.id)).not.toContain("fact.privacy.recipient.mimo.v1");
    expect(mimo.map((item) => item.id)).toContain("fact.privacy.recipient.mimo.v1");
    expect(mimo.map((item) => item.id)).not.toContain("fact.privacy.recipient.deepseek.v1");
    expect(new Set(combined.map((item) => item.id))).toEqual(new Set([
      ...deepseek.map((item) => item.id),
      ...mimo.map((item) => item.id),
    ]));
    expect(Object.isFrozen(deepseek)).toBe(true);
    expect(deepseek.every(Object.isFrozen)).toBe(true);
    expect(() => (deepseek as { id: string; sha256: string }[]).push({ id: "x", sha256: "a".repeat(64) })).toThrow();
    expect(() => ((deepseek[0] as { id: string }).id = "mutated")).toThrow();
    expect(deriveRequiredServiceFactPairs(new Set([deepseekKey]))).toEqual(deepseek);
  });

  it.each([
    ["empty", new Set<string>()],
    ["unknown only", new Set(["unknown.profile.v1"])],
    ["known plus unknown", new Set(["deepseek.official.deepseek-v4-flash.chat.v1", "unknown.profile.v1"])],
    ["case drift", new Set(["DeepSeek.official.deepseek-v4-flash.chat.v1"])],
  ])("rejects %s profile-key derivation input", (_label, profileKeys) => {
    expect(() => deriveRequiredServiceFactPairs(profileKeys)).toThrow(LegalFingerprintDescriptorV1Error);
  });

  it("keeps registry-fact authority private and exposes only a stable predicate", () => {
    expect(Object.hasOwn(descriptorModule, "LEGAL_FINGERPRINT_V1_REGISTRY_FACT_IDS")).toBe(false);
    expect(isLegalFingerprintV1RegistryFactId("fact.deepseek.gateway.service.v1")).toBe(true);
    expect(isLegalFingerprintV1RegistryFactId("fact.deepseek.operator.external.v1")).toBe(false);
    expect(isLegalFingerprintV1RegistryFactId("fact.deepseek.gateway.service.v1")).toBe(true);
  });

  it("rejects an iterable that is not a readonly set", () => {
    expect(() => deriveRequiredServiceFactPairs([
      "deepseek.official.deepseek-v4-flash.chat.v1",
    ] as unknown as ReadonlySet<string>)).toThrow(/readonly set/);
  });
});
