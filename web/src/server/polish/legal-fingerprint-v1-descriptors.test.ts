import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
  resolveLegalFingerprintV1ReviewedExcerptSha256,
  validateLegalFingerprintV1RegistryEvidenceMapping,
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

const EXPECTED_ROOT_SHA256 = Object.freeze({
  "route.deepseek.official.v1": "ddd46ac3d94fa9a3d4293f5f59faa52ee93a418927d13a01798f0802ccc99d79",
  "route.mimo.cn.official.v1": "405655fe1a3bbc0aa2eff7217b3f78bc8cd0b991f69cf35c06ac361b041e52fa",
  "subject.deepseek.hmac-v2.v1": "03320dd189290376d0197aaf2907aaf2802a8f03fe3311580c81d2efddb6431c",
  "subject.mimo.none.v1": "d4e088e93e8217a5ef6e351e40ec5b1a0c1c3cfb89cb9ac5e471dcecbf96b805",
  [DEEPSEEK_LEGAL_MANIFEST_ID]: "0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b",
  [MIMO_LEGAL_MANIFEST_ID]: "f075f1e39e74a96ef2b536df8ba1e19c0840ce6d3be47d6deccd9c95da861c3f",
  "contract.neutral-body.2026-08-23.v1": "5cedbfc90aa9bd5899468470c339c21268873afbb6c84dc990dccfa08f976d83",
  "contract.privacy-ai.2026-08-23.v1": "dc98623bf89402f526dbf000a33c81c1d67b4aedec8702a7b517062fbe8e4ec7",
  "contract.acceptance.2026-08-23.v1": "d968e23c43b0bf97b89e3eda4d7f6de195158d7d79f9ce5b53926540eb8aefbe",
  "contract.route-disclosure.2026-08-23.v1": "2ba9e44141422787d89f8345112e70aa8c374ec2cc8a1735d33cf73cb75a0e8d",
  "contract.material-change.2026-08-23.v1": "4c5b1b4f8d93ae372c96d6471139daf8563b1ba2cc60b2341f86930a5bd88769",
  [INITIAL_LEGAL_BUNDLE_VERSION]: "fc26d1e1a016fda055fbe6a0b79b48d804fd7610e03bd5aa29389be37359ca18",
});

const EXPECTED_REGISTRY_EVIDENCE_FACT_IDS = Object.freeze({
  "evidence.deepseek.registry.adapter.v1": Object.freeze([
    "fact.deepseek.adapter.wire.v1",
    "fact.deepseek.endpoint.resolution.v1",
    "fact.deepseek.display.registration.v1",
  ]),
  "evidence.deepseek.registry.profile.v1": Object.freeze([
    "fact.deepseek.gateway.service.v1",
    "fact.deepseek.model.selection.v1",
    "fact.deepseek.wire.selection.v1",
    "fact.deepseek.endpoint.selection.v1",
    "fact.deepseek.display.selection.v1",
  ]),
  "evidence.mimo.registry.adapter.v1": Object.freeze([
    "fact.mimo.adapter.wire.v1",
    "fact.mimo.endpoint.resolution.v1",
    "fact.mimo.display.registration.v1",
  ]),
  "evidence.mimo.registry.profile.v1": Object.freeze([
    "fact.mimo.gateway.service.v1",
    "fact.mimo.model.selection.v1",
    "fact.mimo.wire.selection.v1",
    "fact.mimo.endpoint.selection.v1",
    "fact.mimo.display.selection.v1",
  ]),
});

const EXPECTED_EVIDENCE_FACT_IDS = Object.freeze({
  "evidence.deepseek.api.v1": Object.freeze([
    "fact.deepseek.model.external.v1",
    "fact.deepseek.wire.external.v1",
    "fact.deepseek.endpoint.external.v1",
    "fact.deepseek.subject.capability.v1",
  ]),
  "evidence.deepseek.platform-terms.v1": Object.freeze(["fact.deepseek.operator.external.v1"]),
  "evidence.deepseek.terms-of-use.v1": Object.freeze([
    "fact.deepseek.retention.v1",
    "fact.deepseek.training.v1",
  ]),
  "evidence.deepseek.policy.v1": Object.freeze([
    "fact.deepseek.region.v1",
    "fact.deepseek.transfer.v1",
  ]),
  "evidence.deepseek.cache.v1": Object.freeze(["fact.deepseek.cache.v1"]),
  "evidence.deepseek.contract.v1": Object.freeze([
    "fact.deepseek.gateway.service.v1",
    "fact.deepseek.model.selection.v1",
    "fact.deepseek.wire.selection.v1",
    "fact.deepseek.adapter.wire.v1",
    "fact.deepseek.endpoint.selection.v1",
    "fact.deepseek.endpoint.resolution.v1",
    "fact.deepseek.display.selection.v1",
    "fact.deepseek.display.registration.v1",
    "fact.deepseek.subject.send.v1",
    "fact.deepseek.subject.derivation.v1",
    "fact.deepseek.submitted.v1",
    "fact.deepseek.display.v1",
  ]),
  "evidence.deepseek.registry.adapter.v1": EXPECTED_REGISTRY_EVIDENCE_FACT_IDS["evidence.deepseek.registry.adapter.v1"],
  "evidence.deepseek.registry.profile.v1": EXPECTED_REGISTRY_EVIDENCE_FACT_IDS["evidence.deepseek.registry.profile.v1"],
  "evidence.deepseek.legal.en.v1": Object.freeze(["fact.deepseek.display.v1"]),
  "evidence.deepseek.legal.zh.v1": Object.freeze(["fact.deepseek.display.v1"]),
  "evidence.deepseek.subject.implementation.v1": Object.freeze(["fact.deepseek.subject.derivation.v1"]),
  "evidence.deepseek.subject.test.v1": Object.freeze(["fact.deepseek.subject.derivation.v1"]),
  "evidence.mimo.api.v1": Object.freeze([
    "fact.mimo.model.external.v1",
    "fact.mimo.wire.external.v1",
    "fact.mimo.endpoint.external.v1",
  ]),
  "evidence.mimo.terms.v1": Object.freeze(["fact.mimo.operator.external.v1"]),
  "evidence.mimo.policy.v1": Object.freeze([
    "fact.mimo.region.v1",
    "fact.mimo.cache.v1",
    "fact.mimo.retention.v1",
    "fact.mimo.training.v1",
    "fact.mimo.transfer.v1",
  ]),
  "evidence.mimo.contract.v1": Object.freeze([
    "fact.mimo.gateway.service.v1",
    "fact.mimo.model.selection.v1",
    "fact.mimo.wire.selection.v1",
    "fact.mimo.adapter.wire.v1",
    "fact.mimo.endpoint.selection.v1",
    "fact.mimo.endpoint.resolution.v1",
    "fact.mimo.display.selection.v1",
    "fact.mimo.display.registration.v1",
    "fact.mimo.subject.none.v1",
    "fact.mimo.submitted.v1",
    "fact.mimo.display.v1",
  ]),
  "evidence.mimo.registry.adapter.v1": EXPECTED_REGISTRY_EVIDENCE_FACT_IDS["evidence.mimo.registry.adapter.v1"],
  "evidence.mimo.registry.profile.v1": EXPECTED_REGISTRY_EVIDENCE_FACT_IDS["evidence.mimo.registry.profile.v1"],
  "evidence.mimo.legal.en.v1": Object.freeze(["fact.mimo.display.v1"]),
  "evidence.mimo.legal.zh.v1": Object.freeze(["fact.mimo.display.v1"]),
  "evidence.semantic.neutral-body.contract.v1": Object.freeze([
    "fact.neutral.plaintext.v1",
    "fact.neutral.scope.v1",
    "fact.neutral.ledger.v1",
    "fact.neutral.retention.v1",
    "fact.neutral.quota.v1",
    "fact.neutral.retry.v1",
    "fact.neutral.output-review.v1",
  ]),
  "evidence.semantic.neutral-body.legal.en.v1": Object.freeze(["fact.neutral.output-review.v1"]),
  "evidence.semantic.neutral-body.legal.zh.v1": Object.freeze(["fact.neutral.output-review.v1"]),
  "evidence.semantic.privacy-ai.contract.v1": Object.freeze([
    "fact.privacy.recipient.deepseek.v1",
    "fact.privacy.recipient.mimo.v1",
    "fact.privacy.transfer.v1",
    "fact.privacy.retention.v1",
  ]),
  "evidence.semantic.privacy-ai.legal.en.v1": Object.freeze([
    "fact.privacy.transfer.v1",
    "fact.privacy.retention.v1",
  ]),
  "evidence.semantic.privacy-ai.legal.zh.v1": Object.freeze([
    "fact.privacy.transfer.v1",
    "fact.privacy.retention.v1",
  ]),
  "evidence.semantic.acceptance.contract.v1": Object.freeze([
    "fact.acceptance.authorization.v1",
    "fact.acceptance.document.v1",
  ]),
  "evidence.semantic.acceptance.legal.en.v1": Object.freeze(["fact.acceptance.document.v1"]),
  "evidence.semantic.acceptance.legal.zh.v1": Object.freeze(["fact.acceptance.document.v1"]),
  "evidence.semantic.route-disclosure.contract.v1": Object.freeze([
    "fact.route.readonly.v1",
    "fact.route.no-selector.v1",
    "fact.route.no-fallback.deepseek.v1",
    "fact.route.no-fallback.mimo.v1",
    "fact.route.change-gate.v1",
  ]),
  "evidence.semantic.material-change.contract.v1": Object.freeze([
    "fact.material.reaccept.v1",
    "fact.material.definition.v1",
  ]),
  "evidence.semantic.material-change.legal.en.v1": Object.freeze(["fact.material.definition.v1"]),
  "evidence.semantic.material-change.legal.zh.v1": Object.freeze(["fact.material.definition.v1"]),
});

const EXPECTED_PROVIDER_SOURCE_REVISIONS = Object.freeze({
  "evidence.deepseek.api.v1": Object.freeze(["unavailable", ""]),
  "evidence.deepseek.platform-terms.v1": Object.freeze(["known", "released=2026-04-22;effective=2026-04-29"]),
  "evidence.deepseek.terms-of-use.v1": Object.freeze(["known", "last-updated=2026-03-27"]),
  "evidence.deepseek.policy.v1": Object.freeze(["known", "last-updated=2026-02-10"]),
  "evidence.deepseek.cache.v1": Object.freeze(["unavailable", ""]),
  "evidence.mimo.api.v1": Object.freeze(["known", "updated=2026-07-17"]),
  "evidence.mimo.terms.v1": Object.freeze(["known", "updated=2026-07-07"]),
  "evidence.mimo.policy.v1": Object.freeze(["known", "version=20260421;updated=2026-03-17"]),
});

const EXPECTED_GIT_BLOB_SHA256 = Object.freeze({
  "docs/ai-provider-contract.md": "f2cf21f68a93451ea157a954ec57a8872cf1220d28bc013fa2dbc1b6b3ebcccd",
  "web/src/server/polish/adapter-registry.ts": "51dacd9e8a2d5721036294c4af609a36415cd47f50a1982f2b13e4deac969b15",
  "web/src/server/polish/profile-registry.ts": "b379ba9f9907360f76ac50c8f676e009d194dadd49707afd24732fc6c9e326b6",
  "web/src/server/polish/provider-subject-v2.ts": "785281d70c7f4cf42234d13597e9d0b1422dbdcc5ca64dc3addd3bb4f37ffad4",
  "web/src/server/polish/provider-subject-v2.test.ts": "47eae5f28de31c2ee86b1ad5ed90a83360267f07ab2ded03a570fae5fa459a86",
  "web/src/content/legal/en.ts": "6ae774d66dcd2a43c9d33c10cb09e55c9eec835e2e5e1952618b9834580caba7",
  "web/src/content/legal/zh.ts": "24988e445966bddec80fee84d0292bc11723a045ed92025fd85fe1e9fba10901",
});

const EXPECTED_EVIDENCE_EXCERPTS = Object.freeze({
  "evidence.deepseek.api.v1": "The undated DeepSeek Chat page identifies deepseek-v4-flash, the Chat Completions endpoint and wire, and user_id purposes; it states no API location.",
  "evidence.deepseek.platform-terms.v1": "The DeepSeek Open Platform Terms identify the platform operator and API agreement, and exclude downstream-user products in section 5.5; section 4.2 is developer permission, not provider training use.",
  "evidence.deepseek.terms-of-use.v1": "The DeepSeek Terms of Use applies to Services including APIs and describes limited de-identified improvement use; it states no fixed overall API-content retention period, API-specific no-training commitment, or opt-out.",
  "evidence.deepseek.policy.v1": "The DeepSeek general Privacy Policy states PRC processing but excludes downstream-user products and services, so it does not establish this service's Open Platform API-content location or transfer path.",
  "evidence.deepseek.cache.v1": "The undated DeepSeek cache guide says disk context caching is enabled by default and unused cache usually clears within hours to days.",
  "evidence.deepseek.contract.v1": "The frozen provider contract defines only the DeepSeek service-owned route, subject, submission, display, and registry-component facts in this manifest root.",
  "evidence.deepseek.registry.adapter.v1": "The adapter registry binds deepseek_chat_v1 to chat_completions_v1, deepseek_official to the exact HTTPS URL, and deepseek-official-v1 to canonical provider/model labels; it does not select a profile route.",
  "evidence.deepseek.registry.profile.v1": "The profile registry binds the DeepSeek profile to direct_deepseek, deepseek-v4-flash, chat_completions_v1, deepseek_official, and deepseek-official-v1; it does not resolve endpoint URL or display labels.",
  "evidence.deepseek.legal.en.v1": "The English legal content maps deepseek-official-v1 to the reviewed DeepSeek provider annex and conservative downstream-scope wording.",
  "evidence.deepseek.legal.zh.v1": "The Chinese legal content maps deepseek-official-v1 to the reviewed DeepSeek provider annex and conservative downstream-scope wording.",
  "evidence.deepseek.subject.implementation.v1": "The reviewed RT-002B implementation defines the exact provider-subject-v2 message, trimmed secret class, HMAC-SHA256, and lowercase-hex output.",
  "evidence.deepseek.subject.test.v1": "The reviewed RT-002B tests independently exercise exact message and HMAC vectors, Unicode secret handling, UUID validation, and lowercase output.",
  "evidence.mimo.api.v1": "The MiMo Responses page updated 2026-07-17 identifies mimo-v2.5-pro, the Responses wire API, and the exact official endpoint.",
  "evidence.mimo.terms.v1": "The MiMo Service Agreement updated 2026-07-07 does not identify the mainland-China operator; its Singapore entity statement is scoped outside mainland China.",
  "evidence.mimo.policy.v1": "MiMo Privacy version 20260421 updated 2026-03-17 supports the reviewed region, retention, submitted-content training, transfer, and cache-unknown facts.",
  "evidence.mimo.contract.v1": "The frozen provider contract defines only the MiMo service-owned route, subject, submission, display, and registry-component facts in this manifest root.",
  "evidence.mimo.registry.adapter.v1": "The adapter registry binds mimo_responses_v1 to responses_v1, mimo_cn_official to the exact HTTPS URL, and mimo-cn-v1 to canonical provider/model labels; it does not select a profile route.",
  "evidence.mimo.registry.profile.v1": "The profile registry binds the MiMo profile to direct_mimo, mimo-v2.5-pro, responses_v1, mimo_cn_official, and mimo-cn-v1; it does not resolve endpoint URL or display labels.",
  "evidence.mimo.legal.en.v1": "The English legal content maps mimo-cn-v1 to the reviewed mainland-China MiMo provider annex and unresolved operator wording.",
  "evidence.mimo.legal.zh.v1": "The Chinese legal content maps mimo-cn-v1 to the reviewed mainland-China MiMo provider annex and unresolved operator wording.",
  "evidence.semantic.neutral-body.contract.v1": "The frozen provider contract defines the neutral-body plaintext, submission scope, ledger, retention, quota, retry, and output-review facts only.",
  "evidence.semantic.neutral-body.legal.en.v1": "The English AI terms state the neutral-body output-review obligation.",
  "evidence.semantic.neutral-body.legal.zh.v1": "The Chinese AI terms state the neutral-body output-review obligation.",
  "evidence.semantic.privacy-ai.contract.v1": "The frozen provider contract defines the privacy recipient-linkage, transfer-boundary, and retention-linkage facts only.",
  "evidence.semantic.privacy-ai.legal.en.v1": "The English Privacy Policy and AI terms state the reviewed route-specific transfer and retention disclosures.",
  "evidence.semantic.privacy-ai.legal.zh.v1": "The Chinese Privacy Policy and AI terms state the reviewed route-specific transfer and retention disclosures.",
  "evidence.semantic.acceptance.contract.v1": "The frozen provider contract defines the ai_terms exact-version display and DB-authoritative acceptance facts only.",
  "evidence.semantic.acceptance.legal.en.v1": "The English AI terms identify the reviewed ai_terms acceptance document and exact bundle version.",
  "evidence.semantic.acceptance.legal.zh.v1": "The Chinese AI terms identify the reviewed ai_terms acceptance document and exact bundle version.",
  "evidence.semantic.route-disclosure.contract.v1": "The frozen provider contract defines the read-only route, no-selector, no-cross-provider-fallback, and pre-transmission change-gate facts only.",
  "evidence.semantic.material-change.contract.v1": "The frozen provider contract defines the material-change categories and renewed-acceptance enforcement facts only.",
  "evidence.semantic.material-change.legal.en.v1": "The English AI terms define the reviewed categories of material AI-provider change.",
  "evidence.semantic.material-change.legal.zh.v1": "The Chinese AI terms define the reviewed categories of material AI-provider change.",
});

const INDEPENDENT_FIELD_ORDER: Record<string, readonly string[]> = {
  ai_legal_route_identity_v1: ["schema_version","route_descriptor_id","profile_key","gateway_kind","operator_identity_status","operator_legal_name","model_vendor_id","model_vendor_name","model_id","wire_api_kind","endpoint_alias","canonical_endpoint_url","display_disclosure_key"],
  ai_legal_provider_subject_v1: ["schema_version","subject_descriptor_id","mode","wire_field","algorithm","secret_class","derivation_message_schema","output_encoding","source_identity_class","raw_email_sent","raw_username_sent","raw_account_id_sent","documented_purposes"],
  ai_legal_fact_v1: ["schema_version","fact_id","category","authority_class","operational_scope","status","subject","predicate","object","scope","qualifiers"],
  ai_legal_source_evidence_v1: ["schema_version","evidence_id","authority_kind","source_locator_kind","source_locator","checked_at","source_revision_status","source_revision","upstream_snapshot_status","upstream_snapshot_artifact_path","upstream_snapshot_sha256","reviewed_excerpt","reviewed_excerpt_sha256","supported_fact_ids","supported_fact_sha256s"],
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
    expect(LEGAL_FINGERPRINT_V1_EXPECTED_SHA256).toEqual(EXPECTED_ROOT_SHA256);
    const reviewed = EXPECTED_ROOT_SHA256 as Readonly<Record<string, string>>;
    for (const descriptor of all.filter((item) =>
      Object.hasOwn(EXPECTED_ROOT_SHA256, descriptorId(item)),
    )) {
      const id = descriptorId(descriptor);
      expect(fingerprintLegalDescriptorV1(descriptor).sha256).toBe(
        reviewed[id],
      );
      expect(independentFingerprint(descriptor)).toBe(reviewed[id]);
    }
  });

  it("independently recomputes every fact/evidence pair before all manifest, semantic, and bundle roots", () => {
    const all = [
      ...graph.routes, ...graph.subjects, ...graph.facts, ...graph.evidence,
      ...graph.manifests, ...graph.semanticContracts, graph.bundleContract,
    ];
    const independentById = new Map(all.map((descriptor) => [
      descriptorId(descriptor),
      independentFingerprint(descriptor),
    ]));
    const expectPairs = (ids: readonly string[], hashes: readonly string[]) => {
      expect(hashes).toEqual(ids.map((id) => independentById.get(id)));
    };

    for (const item of graph.evidence) {
      expectPairs(item.supported_fact_ids, item.supported_fact_sha256s);
    }
    for (const item of graph.manifests) {
      expectPairs(item.route_descriptor_ids, item.route_descriptor_sha256s);
      expect(independentById.get(item.subject_descriptor_id)).toBe(item.subject_descriptor_sha256);
      expectPairs(item.fact_ids, item.fact_sha256s);
      expectPairs(item.evidence_ids, item.evidence_sha256s);
    }
    for (const item of graph.semanticContracts) {
      expectPairs(item.fact_ids, item.fact_sha256s);
      expectPairs(item.evidence_ids, item.evidence_sha256s);
    }
    expectPairs(graph.bundleContract.manifest_ids, graph.bundleContract.manifest_sha256s);
    for (const [id, sha256] of [
      [graph.bundleContract.neutral_body_contract_id, graph.bundleContract.neutral_body_contract_sha256],
      [graph.bundleContract.privacy_ai_contract_id, graph.bundleContract.privacy_ai_contract_sha256],
      [graph.bundleContract.acceptance_contract_id, graph.bundleContract.acceptance_contract_sha256],
      [graph.bundleContract.route_disclosure_contract_id, graph.bundleContract.route_disclosure_contract_sha256],
      [graph.bundleContract.material_change_contract_id, graph.bundleContract.material_change_contract_sha256],
    ] as const) {
      expect(independentById.get(id)).toBe(sha256);
    }
    for (const [id, expected] of Object.entries(EXPECTED_ROOT_SHA256)) {
      expect(independentById.get(id)).toBe(expected);
    }
  });

  it("freezes every source-local evidence excerpt and independently verifies its exact UTF-8 digest", () => {
    expect(graph.evidence).toHaveLength(Object.keys(EXPECTED_EVIDENCE_EXCERPTS).length);
    for (const item of graph.evidence) {
      const expected = EXPECTED_EVIDENCE_EXCERPTS[
        item.evidence_id as keyof typeof EXPECTED_EVIDENCE_EXCERPTS
      ];
      expect(expected).toBeDefined();
      expect(item.reviewed_excerpt).toBe(expected);
      expect(item.reviewed_excerpt).not.toMatch(/[\r\n]/u);
      const independentDigest = createHash("sha256")
        .update(new TextEncoder().encode(expected))
        .digest("hex");
      expect(item.reviewed_excerpt_sha256).toBe(independentDigest);
      expect(resolveLegalFingerprintV1ReviewedExcerptSha256(expected)).toBe(independentDigest);
    }
    expect(() => resolveLegalFingerprintV1ReviewedExcerptSha256("unreviewed excerpt"))
      .toThrow(/unreviewed legal evidence excerpt/u);
    expect(() => resolveLegalFingerprintV1ReviewedExcerptSha256(null))
      .toThrow(/exact reviewed string/u);
  });

  it.each(["toString", "constructor", "__proto__"])(
    "rejects inherited excerpt key %s",
    (inheritedKey) => {
      expect(() => resolveLegalFingerprintV1ReviewedExcerptSha256(inheritedKey))
        .toThrow(/unreviewed legal evidence excerpt/u);
    },
  );

  it("maps every evidence ID to its exact source-local supported fact set", () => {
    expect(graph.evidence.map((item) => item.evidence_id).sort()).toEqual(
      Object.keys(EXPECTED_EVIDENCE_FACT_IDS).sort(),
    );
    for (const item of graph.evidence) {
      expect(item.supported_fact_ids).toEqual(
        EXPECTED_EVIDENCE_FACT_IDS[item.evidence_id as keyof typeof EXPECTED_EVIDENCE_FACT_IDS],
      );
    }
  });

  it("binds each registry evidence ID to its exact source-local fact set", () => {
    const registryEvidence = graph.evidence.filter((item) => item.authority_kind === "service-registry");
    expect(registryEvidence.map((item) => item.evidence_id).sort()).toEqual(
      Object.keys(EXPECTED_REGISTRY_EVIDENCE_FACT_IDS).sort(),
    );
    for (const item of registryEvidence) {
      const expected = EXPECTED_REGISTRY_EVIDENCE_FACT_IDS[
        item.evidence_id as keyof typeof EXPECTED_REGISTRY_EVIDENCE_FACT_IDS
      ];
      expect(item.supported_fact_ids).toEqual(expected);
      expect(() => validateLegalFingerprintV1RegistryEvidenceMapping(item)).not.toThrow();
      if (item.evidence_id.includes(".adapter.")) {
        expect(item.source_locator).toBe("web/src/server/polish/adapter-registry.ts");
      } else {
        expect(item.source_locator).toBe("web/src/server/polish/profile-registry.ts");
      }
    }
  });

  it.each([
    ["evidence.deepseek.registry.adapter.v1", "fact.deepseek.gateway.service.v1"],
    ["evidence.deepseek.registry.adapter.v1", "fact.deepseek.model.selection.v1"],
    ["evidence.deepseek.registry.adapter.v1", "fact.deepseek.display.selection.v1"],
    ["evidence.mimo.registry.adapter.v1", "fact.mimo.gateway.service.v1"],
    ["evidence.mimo.registry.adapter.v1", "fact.mimo.model.selection.v1"],
    ["evidence.mimo.registry.adapter.v1", "fact.mimo.display.selection.v1"],
  ])("rejects %s overclaiming profile fact %s", (evidenceId, overclaim) => {
    const item = graph.evidence.find((candidate) => candidate.evidence_id === evidenceId)!;
    expect(() => validateLegalFingerprintV1RegistryEvidenceMapping({
      ...item,
      supported_fact_ids: [...item.supported_fact_ids, overclaim],
    })).toThrow(/fact authority mismatch/u);
  });

  it.each(["toString", "constructor", "__proto__"])(
    "rejects inherited registry evidence ID %s claiming provider-external facts",
    (inheritedId) => {
      expect(() => validateLegalFingerprintV1RegistryEvidenceMapping({
        evidence_id: inheritedId,
        authority_kind: "service-registry",
        source_locator_kind: "repo-path",
        source_locator: "web/src/server/polish/adapter-registry.ts",
        supported_fact_ids: ["fact.deepseek.operator.external.v1"],
      })).toThrow(/not source-authorized/u);
    },
  );

  it("rejects isolated prototype pollution for excerpt and registry authority lookups", () => {
    const excerptKey = "polluted legal excerpt";
    const prototype = Object.prototype as Record<string, unknown>;
    const previousExcerpt = Object.getOwnPropertyDescriptor(prototype, excerptKey);
    const previousSourceLocator = Object.getOwnPropertyDescriptor(prototype, "sourceLocator");
    const previousFactIds = Object.getOwnPropertyDescriptor(prototype, "factIds");
    try {
      Object.defineProperty(prototype, excerptKey, {
        configurable: true,
        enumerable: false,
        value: "a".repeat(64),
        writable: true,
      });
      Object.defineProperty(prototype, "sourceLocator", {
        configurable: true,
        enumerable: false,
        value: "web/src/server/polish/adapter-registry.ts",
        writable: true,
      });
      Object.defineProperty(prototype, "factIds", {
        configurable: true,
        enumerable: false,
        value: Object.freeze(["fact.deepseek.operator.external.v1"]),
        writable: true,
      });

      expect(() => resolveLegalFingerprintV1ReviewedExcerptSha256(excerptKey))
        .toThrow(/unreviewed legal evidence excerpt/u);
      expect(() => validateLegalFingerprintV1RegistryEvidenceMapping({
        evidence_id: "__proto__",
        authority_kind: "service-registry",
        source_locator_kind: "repo-path",
        source_locator: "web/src/server/polish/adapter-registry.ts",
        supported_fact_ids: ["fact.deepseek.operator.external.v1"],
      })).toThrow(/not source-authorized/u);
    } finally {
      if (previousExcerpt === undefined) delete prototype[excerptKey];
      else Object.defineProperty(prototype, excerptKey, previousExcerpt);
      if (previousSourceLocator === undefined) delete prototype.sourceLocator;
      else Object.defineProperty(prototype, "sourceLocator", previousSourceLocator);
      if (previousFactIds === undefined) delete prototype.factIds;
      else Object.defineProperty(prototype, "factIds", previousFactIds);
    }
  });

  it("freezes the exact provider known/unavailable source-revision matrix", () => {
    const providerEvidence = graph.evidence.filter((item) => item.authority_kind === "provider-official");
    expect(providerEvidence.map((item) => item.evidence_id).sort()).toEqual(
      Object.keys(EXPECTED_PROVIDER_SOURCE_REVISIONS).sort(),
    );
    for (const item of providerEvidence) {
      const expected = EXPECTED_PROVIDER_SOURCE_REVISIONS[
        item.evidence_id as keyof typeof EXPECTED_PROVIDER_SOURCE_REVISIONS
      ];
      expect([item.source_revision_status, item.source_revision]).toEqual(expected);
      expect(item.upstream_snapshot_status).toBe("unavailable");
    }
    for (const item of graph.evidence.filter((evidence) => evidence.authority_kind !== "provider-official")) {
      expect([item.source_revision_status, item.source_revision]).toEqual(["unavailable", ""]);
      expect(item.upstream_snapshot_status).toBe("sha256");
    }
  });

  it("keeps DeepSeek downstream scope and training authority separated without a PRC API-route claim", () => {
    const fact = (id: string) => graph.facts.find((item) => item.fact_id === id)!;
    for (const id of ["fact.deepseek.region.v1", "fact.deepseek.transfer.v1"]) {
      const item = fact(id);
      expect(item).toMatchObject({
        status: "unverified",
        subject: "DeepSeek general Privacy Policy",
      });
      expect(`${item.object} ${item.scope}`).toMatch(/downstream|Open Platform API/u);
      expect(`${item.object} ${item.scope}`).not.toMatch(/API content (?:may|will|is) (?:be )?(?:processed|stored|transferred) in (?:the )?(?:PRC|People's Republic of China)/iu);
    }
    const platform = graph.evidence.find((item) => item.evidence_id === "evidence.deepseek.platform-terms.v1")!;
    const termsOfUse = graph.evidence.find((item) => item.evidence_id === "evidence.deepseek.terms-of-use.v1")!;
    const privacy = graph.evidence.find((item) => item.evidence_id === "evidence.deepseek.policy.v1")!;
    expect(platform.supported_fact_ids).toEqual(["fact.deepseek.operator.external.v1"]);
    expect(platform.supported_fact_ids).not.toContain("fact.deepseek.training.v1");
    expect(platform.reviewed_excerpt).toMatch(/developer permission, not provider training use/u);
    expect(termsOfUse.supported_fact_ids).toEqual([
      "fact.deepseek.retention.v1",
      "fact.deepseek.training.v1",
    ]);
    expect(privacy.supported_fact_ids).toEqual([
      "fact.deepseek.region.v1",
      "fact.deepseek.transfer.v1",
    ]);
  });

  it("removes every superseded legal blob, excerpt, manifest, semantic, and bundle hash mapping", () => {
    const descriptorSource = readFileSync(
      new URL("./legal-fingerprint-v1-descriptors.ts", import.meta.url),
      "utf8",
    );
    const superseded = [
      "1fe9ec19ed137ce2df4009d010ff8feaa9f9fd3fd4a8f0bbd4659ab526357689",
      "31fb40ca623f09ee9ef106c958d30b9a78d3d9c5d78740d6d789ea8f9a72fbe7",
      "a18ee785fbc81cbea0ecc66237798afc15a4da188aeadf80ee8004f65e7b6aaa",
      "6335231d97ae77ee15ab3d832db86e8c2db9d26bbf41a2487d2ec83847eb37e5",
      "1b4c5f796e4dad4f5229359e218cfa9dd8b0941a5697170c83da08aaa962d9a0",
      "dac916b9cc86598a66a33221d341b1f6882dcea1a2c02473fc7a10cb1bff7834",
      "68f9f636b754fe79b9d6d9e6971549a670212c7c8c8e1474a60496ff00f14b93",
      "e165a430d1205ce43717171afe9e80ae6f742b4feeafd293777717395aa27dd1",
      "cbe6aa1d06abda5f8ad64ed3abe5c6e7461ac8a88cecd820be70fd65f1af71e8",
      "2e3703a271b8f80c025f28833ed98d93e455e30e1fa7effec1f171994e04e3b3",
      "859d7e803c5a2907f6ab5cc080294128782efe6faa5f465ad0a7d13a294c98b2",
      "0367e01671902c525b5e7520f904a8806a87d127a84a8098f88ff23684ed8652",
      "660fd0eda4f34b8b9fbf90e561bfb3ea833c5fa5900225d6a37471539482203f",
      "549ef30262184c6a006e1019a8da1026181311ed92ade05930eedcb9623c364c",
      "9af4cf05727c7bb34659b1eb2b0062284acca8676696a7b1fb7fa928543c575f",
      "0649e86e0a69703cf8c0cba74baa0d8feecbe1816868c594673afff7b7847f0e",
      "b8fbc9a8414c8d4d55c1f779e666bf59d2ea898353aa820b646c0a406f439ffc",
      "314c67a72ed3813a57a338665724cb552b81239bf98f84c611581fafd30687a2",
      "1d7c370c26b217be904d6fb6bb44ef3eef28ae65b8ac04eb6c032c18be0bc2fb",
      "de36da44d47e6d6f1818d66e85405ee534a721fae3b6f7d011773d3d09b547dd",
      "f063223a6ee39a98758c6a54626d7727d57b0ca420f7beee43d00c5fea1c94a6",
      "d1859cf9e1103a6394917b671ead068ea816d5ff97d0776426389877805d358d",
      "882f03b882f958d31882bdb336c89acd89754bae9b6dd93a73b0c4b4e5b1c113",
      "d4f389021fb47b24800ba028df2a22597f398a83d266705cf1be3615bc66fdc8",
    ];
    for (const oldHash of superseded) expect(descriptorSource).not.toContain(oldHash);
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
    const serviceEvidence = graph.evidence.filter((item) => item.source_locator_kind === "repo-path");
    const sourcePaths = [...new Set(serviceEvidence.map((item) => item.source_locator))];
    const independentlyObserved = new Map(sourcePaths.map((sourcePath) => {
      const type = execFileSync("git", ["cat-file", "-t", `HEAD:${sourcePath}`], { encoding: "utf8" }).trim();
      const blob = execFileSync("git", ["cat-file", "blob", `HEAD:${sourcePath}`]);
      expect(type).toBe("blob");
      return [sourcePath, createHash("sha256").update(blob).digest("hex")] as const;
    }));
    for (const evidence of serviceEvidence) {
      expect(evidence.upstream_snapshot_sha256).toBe(
        EXPECTED_GIT_BLOB_SHA256[evidence.source_locator as keyof typeof EXPECTED_GIT_BLOB_SHA256],
      );
      expect(independentlyObserved.get(evidence.source_locator)).toBe(evidence.upstream_snapshot_sha256);
    }
    expect(new Set(sourcePaths))
      .toEqual(new Set(Object.keys(EXPECTED_GIT_BLOB_SHA256)));
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
