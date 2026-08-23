import {
  fingerprintLegalDescriptorV1,
} from "./legal-fingerprint-v1";

export const INITIAL_LEGAL_BUNDLE_VERSION = "2026-08-23-multi-provider-v1" as const;
export const DEEPSEEK_LEGAL_MANIFEST_ID = "deepseek-official-2026-08-23-v1" as const;
export const MIMO_LEGAL_MANIFEST_ID = "mimo-cn-2026-08-23-v1" as const;

const CHECKED_AT = "2026-08-23@Asia/Shanghai" as const;
const CONTRACT_PATH = "docs/ai-provider-contract.md" as const;
const ADAPTER_REGISTRY_PATH = "web/src/server/polish/adapter-registry.ts" as const;
const PROFILE_REGISTRY_PATH = "web/src/server/polish/profile-registry.ts" as const;
const SUBJECT_IMPLEMENTATION_PATH = "web/src/server/polish/provider-subject-v2.ts" as const;
const SUBJECT_TEST_PATH = "web/src/server/polish/provider-subject-v2.test.ts" as const;
const LEGAL_EN_PATH = "web/src/content/legal/en.ts" as const;
const LEGAL_ZH_PATH = "web/src/content/legal/zh.ts" as const;

const GIT_BLOB_SHA256 = Object.freeze({
  [CONTRACT_PATH]: "f2cf21f68a93451ea157a954ec57a8872cf1220d28bc013fa2dbc1b6b3ebcccd",
  [ADAPTER_REGISTRY_PATH]: "51dacd9e8a2d5721036294c4af609a36415cd47f50a1982f2b13e4deac969b15",
  [PROFILE_REGISTRY_PATH]: "b379ba9f9907360f76ac50c8f676e009d194dadd49707afd24732fc6c9e326b6",
  [SUBJECT_IMPLEMENTATION_PATH]: "785281d70c7f4cf42234d13597e9d0b1422dbdcc5ca64dc3addd3bb4f37ffad4",
  [SUBJECT_TEST_PATH]: "47eae5f28de31c2ee86b1ad5ed90a83360267f07ab2ded03a570fae5fa459a86",
  [LEGAL_EN_PATH]: "1fe9ec19ed137ce2df4009d010ff8feaa9f9fd3fd4a8f0bbd4659ab526357689",
  [LEGAL_ZH_PATH]: "31fb40ca623f09ee9ef106c958d30b9a78d3d9c5d78740d6d789ea8f9a72fbe7",
});

type AuthorityClass = "provider-external" | "service-operational" | "service-display";
type FactCategory =
  | "submitted-data" | "gateway" | "operator" | "model" | "wire" | "endpoint"
  | "display" | "provider-subject" | "region" | "cache" | "retention" | "training"
  | "transfer" | "unknown" | "service-processing" | "ledger" | "quota"
  | "output-review" | "privacy-linkage" | "acceptance" | "route-disclosure"
  | "material-change";

function fact(
  fact_id: string,
  category: FactCategory,
  authority_class: AuthorityClass,
  operational_scope: string,
  subject: string,
  predicate: string,
  object: string,
  scope: string,
  qualifiers: readonly string[] = [],
  status: "confirmed" | "unverified" | "not-found" | "not-applicable" = "confirmed",
) {
  return Object.freeze({
    schema_version: "ai_legal_fact_v1",
    fact_id,
    category,
    authority_class,
    operational_scope,
    status,
    subject,
    predicate,
    object,
    scope,
    qualifiers: Object.freeze([...qualifiers]),
  });
}

const deepseekScope = "profile:deepseek.official.deepseek-v4-flash.chat.v1";
const mimoScope = "profile:mimo.cn.mimo-v2.5-pro.responses.v1";

const manifestFacts = Object.freeze([
  fact("fact.deepseek.gateway.service.v1", "gateway", "service-operational", deepseekScope, "cv maker routing", "selects gateway", "direct_deepseek", "DeepSeek profile"),
  fact("fact.deepseek.operator.external.v1", "operator", "provider-external", "", "official DeepSeek Open Platform", "is operated by", "Hangzhou DeepSeek Artificial Intelligence Co., Ltd.", "reviewed official platform terms"),
  fact("fact.deepseek.model.external.v1", "model", "provider-external", "", "DeepSeek official API", "offers model", "deepseek-v4-flash by DeepSeek", "Chat Completions profile"),
  fact("fact.deepseek.model.selection.v1", "model", "service-operational", deepseekScope, "cv maker routing", "selects model", "deepseek-v4-flash", "DeepSeek profile"),
  fact("fact.deepseek.wire.external.v1", "wire", "provider-external", "", "DeepSeek official API", "supports wire API", "Chat Completions", "reviewed create-chat-completion API"),
  fact("fact.deepseek.wire.selection.v1", "wire", "service-operational", deepseekScope, "cv maker adapter", "uses wire API", "chat_completions_v1", "DeepSeek profile"),
  fact("fact.deepseek.endpoint.external.v1", "endpoint", "provider-external", "", "DeepSeek official API", "publishes endpoint", "https://api.deepseek.com/chat/completions", "reviewed exact HTTPS endpoint"),
  fact("fact.deepseek.endpoint.selection.v1", "endpoint", "service-operational", deepseekScope, "cv maker endpoint registry", "selects endpoint", "deepseek_official -> https://api.deepseek.com/chat/completions", "DeepSeek profile"),
  fact("fact.deepseek.display.v1", "display", "service-display", "", "cv maker provider annex", "maps display key", "deepseek-official-v1 means Official DeepSeek Open Platform / DeepSeek 官方开放平台", "English and Chinese legal content"),
  fact("fact.deepseek.subject.capability.v1", "provider-subject", "provider-external", "", "DeepSeek Chat API", "documents user_id", "pseudonymous identifier for content safety, cache isolation, and scheduling isolation", "official create-chat-completion documentation"),
  fact("fact.deepseek.subject.send.v1", "provider-subject", "service-operational", deepseekScope, "cv maker DeepSeek adapter", "sends provider subject", "user_id is lowercase-hex HMAC-SHA256 over the frozen V2 profile and authenticated user identity", "V2 DeepSeek profile", ["no raw email", "no raw username", "no raw account ID"]),
  fact("fact.deepseek.subject.derivation.v1", "provider-subject", "service-operational", deepseekScope, "cv maker provider-subject-v2", "derives pseudonym", "HMAC-SHA256 using utf8-trimmed-env:AI_USER_ID_HMAC_SECRET and the exact provider-subject-v2 message schema", "frozen V2 profile and authenticated-user UUID", ["lowercase-hex output"]),
  fact("fact.deepseek.submitted.v1", "submitted-data", "service-operational", deepseekScope, "cv maker AI polish", "submits", "user-selected resume text, chosen context, style instructions, and pseudonymous user_id", "DeepSeek profile"),
  fact("fact.deepseek.region.v1", "region", "provider-external", "", "DeepSeek policies", "describe processing and storage", "People's Republic of China; exact API facility or region not separately committed", "official policy snapshot"),
  fact("fact.deepseek.cache.v1", "cache", "provider-external", "", "DeepSeek API", "uses disk context caching", "enabled by default; unused cache usually clears within hours to days", "official context caching guide"),
  fact("fact.deepseek.retention.v1", "retention", "provider-external", "", "DeepSeek API materials", "provide fixed overall API-content retention", "not found", "reviewed official materials", [], "not-found"),
  fact("fact.deepseek.training.v1", "training", "provider-external", "", "DeepSeek policies", "permit service improvement or model training", "inputs and outputs may be used in applicable circumstances; API opt-out coverage unverified", "official policies"),
  fact("fact.deepseek.transfer.v1", "transfer", "provider-external", "", "DeepSeek API content", "may be processed in", "People's Republic of China", "route-specific provider processing"),
  fact("fact.mimo.gateway.service.v1", "gateway", "service-operational", mimoScope, "cv maker routing", "selects gateway", "direct_mimo", "MiMo mainland-China profile"),
  fact("fact.mimo.operator.external.v1", "operator", "provider-external", "", "MiMo mainland-China API", "identifies operating legal entity", "unverified; reviewed pages do not identify the specific mainland-China operator", "mainland-China profile", ["outside-mainland terms name Xiaomi Technologies Singapore Pte. Ltd. only outside this scope"], "unverified"),
  fact("fact.mimo.model.external.v1", "model", "provider-external", "", "official MiMo API", "offers model", "mimo-v2.5-pro by Xiaomi / MiMo", "Responses API profile"),
  fact("fact.mimo.model.selection.v1", "model", "service-operational", mimoScope, "cv maker routing", "selects model", "mimo-v2.5-pro", "MiMo profile"),
  fact("fact.mimo.wire.external.v1", "wire", "provider-external", "", "official MiMo API", "supports wire API", "Responses API", "reviewed responses documentation"),
  fact("fact.mimo.wire.selection.v1", "wire", "service-operational", mimoScope, "cv maker adapter", "uses wire API", "responses_v1", "MiMo profile"),
  fact("fact.mimo.endpoint.external.v1", "endpoint", "provider-external", "", "official MiMo API", "publishes endpoint", "https://api.xiaomimimo.com/v1/responses", "reviewed exact HTTPS endpoint"),
  fact("fact.mimo.endpoint.selection.v1", "endpoint", "service-operational", mimoScope, "cv maker endpoint registry", "selects endpoint", "mimo_cn_official -> https://api.xiaomimimo.com/v1/responses", "MiMo profile"),
  fact("fact.mimo.display.v1", "display", "service-display", "", "cv maker provider annex", "maps display key", "mimo-cn-v1 means Official MiMo API mainland-China profile / MiMo 官方 API 中国大陆 profile", "English and Chinese legal content"),
  fact("fact.mimo.subject.none.v1", "provider-subject", "service-operational", mimoScope, "cv maker MiMo adapter", "sends provider subject identifier", "none; no HMAC subject ID, email, username, or raw account ID", "initial MiMo profile"),
  fact("fact.mimo.submitted.v1", "submitted-data", "service-operational", mimoScope, "cv maker AI polish", "submits", "user-selected resume text, chosen context, and style instructions", "MiMo profile"),
  fact("fact.mimo.region.v1", "region", "provider-external", "", "MiMo Privacy Policy", "describes processing regions", "global data centers including the Netherlands and Singapore; request region not guaranteed", "reviewed policy"),
  fact("fact.mimo.cache.v1", "cache", "provider-external", "", "MiMo official materials", "provide fixed API cache TTL, scope, or opt-out", "not found", "reviewed official materials", [], "not-found"),
  fact("fact.mimo.retention.v1", "retention", "provider-external", "", "MiMo Privacy Policy", "describes retention", "necessary period followed by deletion or anonymization; no fixed API-content TTL", "reviewed policy"),
  fact("fact.mimo.training.v1", "training", "provider-external", "", "MiMo Privacy Policy", "describes submitted API content use", "MiMo acts as Processor and states submitted content is not used for model training or other purposes", "reviewed policy"),
  fact("fact.mimo.transfer.v1", "transfer", "provider-external", "", "MiMo API processing", "may involve", "cross-border or other-region processing depending on request and arrangements", "mainland-China route and reviewed policy"),
]);

const semanticFacts = Object.freeze([
  fact("fact.neutral.plaintext.v1", "service-processing", "service-operational", "global", "cv maker AI polish", "transmits selected content", "plaintext through the service server to the disclosed AI recipient over HTTPS; end-to-end encryption does not apply", "all AI polish targets"),
  fact("fact.neutral.scope.v1", "submitted-data", "service-operational", "global", "cv maker AI polish", "limits submission", "user-selected text and user-chosen context/style instructions", "all AI polish targets"),
  fact("fact.neutral.ledger.v1", "ledger", "service-operational", "global", "cv maker", "stores content-free request and attempt metadata", "route, profile, price, legal bundle, usage, cost, timing, status, and quota metadata; not resume text, AI output, or style instructions", "AI polish ledger"),
  fact("fact.neutral.retention.v1", "retention", "service-operational", "global", "cv maker", "schedules metadata deletion", "request/attempt metadata 90 days, per-minute counters 2 days, daily aggregates 90 days, then next daily cleanup; acceptance until account deletion subject to legal/security needs", "service-owned records"),
  fact("fact.neutral.quota.v1", "quota", "service-operational", "global", "cv maker", "settles quota", "reserve at acceptance; post-transmission cancellation remains charged; pre-transmission and classified refundable failures release quota", "AI polish requests"),
  fact("fact.neutral.retry.v1", "quota", "service-operational", "global", "cv maker", "retries", "same frozen route only", "AI polish request"),
  fact("fact.neutral.output-review.v1", "output-review", "service-display", "", "AI polish user", "must review", "AI output for accuracy before use", "AI Service Terms"),
  fact("fact.privacy.recipient.deepseek.v1", "privacy-linkage", "service-operational", deepseekScope, "cv maker Privacy Policy", "links recipient", "DeepSeek annex for the frozen DeepSeek route", "route-specific disclosure"),
  fact("fact.privacy.recipient.mimo.v1", "privacy-linkage", "service-operational", mimoScope, "cv maker Privacy Policy", "links recipient", "MiMo annex for the frozen MiMo route", "route-specific disclosure"),
  fact("fact.privacy.transfer.v1", "transfer", "service-display", "", "cv maker Privacy Policy", "discloses transfer boundary", "route-specific regions and arrangements govern; explicit consent may be used where required and no other safeguard is available", "optional AI feature"),
  fact("fact.privacy.retention.v1", "retention", "service-display", "", "cv maker Privacy Policy", "links retention", "service ledger retention and route-specific provider annex retention statements", "AI polish"),
  fact("fact.acceptance.document.v1", "acceptance", "service-display", "", "AI Service Terms acceptance", "identifies document", "document_key=ai_terms and version=2026-08-23-multi-provider-v1", "current legal bundle"),
  fact("fact.acceptance.authorization.v1", "acceptance", "service-operational", "global", "cv maker reservation", "authorizes transmission only when", "DB-authoritative ai_terms acceptance exactly equals the frozen legal bundle version", "AI polish route reservation"),
  fact("fact.route.readonly.v1", "route-disclosure", "service-operational", "global", "cv maker UI", "discloses actual server-selected route", "read-only before transmission", "AI polish request"),
  fact("fact.route.no-selector.v1", "route-disclosure", "service-operational", "global", "cv maker UI", "does not provide", "provider selector", "AI polish request"),
  fact("fact.route.no-fallback.deepseek.v1", "route-disclosure", "service-operational", deepseekScope, "cv maker orchestrator", "forbids undisclosed cross-provider fallback", "retry remains on frozen DeepSeek route", "single request"),
  fact("fact.route.no-fallback.mimo.v1", "route-disclosure", "service-operational", mimoScope, "cv maker orchestrator", "forbids undisclosed cross-provider fallback", "retry remains on frozen MiMo route", "single request"),
  fact("fact.route.change-gate.v1", "route-disclosure", "service-operational", "global", "cv maker reservation", "stops before transmission when", "route, recipient, upstream, or legal bundle differs from the user's refreshed disclosure", "AI polish request"),
  fact("fact.material.definition.v1", "material-change", "service-display", "", "AI Service Terms", "defines material change", "recipient, gateway/upstream/model coverage, submitted data class, subject behavior, region/transfer, caching/retention, or training changes", "AI legal bundle"),
  fact("fact.material.reaccept.v1", "material-change", "service-operational", "global", "cv maker", "requires renewed acceptance", "new legal bundle before AI transmission after a material semantic change", "AI polish authorization"),
]);

const allFacts = Object.freeze([...manifestFacts, ...semanticFacts]);
const factById = new Map(allFacts.map((item) => [item.fact_id, item]));
const factHash = (id: string): string => fingerprintLegalDescriptorV1(factById.get(id)).sha256;

const EXCERPTS = Object.freeze({
  deepseekApi: "DeepSeek official API documents the reviewed model, Chat Completions endpoint, and user_id purposes.",
  deepseekPolicy: "DeepSeek official policies support the reviewed operator, region, retention uncertainty, training, and transfer statements.",
  deepseekCache: "DeepSeek official cache guidance says disk context caching is enabled by default and unused cache usually clears within hours to days.",
  mimoApi: "MiMo official API documentation supports the reviewed model, Responses wire API, and endpoint.",
  mimoTerms: "MiMo reviewed terms do not identify the specific mainland-China operating company; outside-mainland terms name a Singapore entity.",
  mimoPolicy: "MiMo official privacy materials support the reviewed region, retention, training, transfer, and cache-unknown statements.",
  contract: "The frozen provider contract defines the service-owned semantic fact, authority, scope, and bundle closure.",
  registry: "The code-owned adapter and profile registries bind the reviewed gateway, profile, model, wire API, endpoint alias, manifest, and display keys.",
  legal: "The bilingual legal content maps the reviewed display meaning and user-facing legal statement across English and Chinese.",
  implementation: "The reviewed RT-002B implementation defines the exact provider-subject-v2 message, trimmed secret class, HMAC-SHA256, and lowercase-hex output.",
  test: "The reviewed RT-002B tests independently exercise exact message and HMAC vectors, Unicode secret handling, UUID validation, and lowercase output.",
});

// Independently generated with a separate TextEncoder + node:crypto fixture.
const EXCERPT_SHA256 = Object.freeze({
  [EXCERPTS.deepseekApi]: "1b4c5f796e4dad4f5229359e218cfa9dd8b0941a5697170c83da08aaa962d9a0",
  [EXCERPTS.deepseekPolicy]: "dac916b9cc86598a66a33221d341b1f6882dcea1a2c02473fc7a10cb1bff7834",
  [EXCERPTS.deepseekCache]: "68f9f636b754fe79b9d6d9e6971549a670212c7c8c8e1474a60496ff00f14b93",
  [EXCERPTS.mimoApi]: "e165a430d1205ce43717171afe9e80ae6f742b4feeafd293777717395aa27dd1",
  [EXCERPTS.mimoTerms]: "cbe6aa1d06abda5f8ad64ed3abe5c6e7461ac8a88cecd820be70fd65f1af71e8",
  [EXCERPTS.mimoPolicy]: "2e3703a271b8f80c025f28833ed98d93e455e30e1fa7effec1f171994e04e3b3",
  [EXCERPTS.contract]: "859d7e803c5a2907f6ab5cc080294128782efe6faa5f465ad0a7d13a294c98b2",
  [EXCERPTS.registry]: "0367e01671902c525b5e7520f904a8806a87d127a84a8098f88ff23684ed8652",
  [EXCERPTS.legal]: "660fd0eda4f34b8b9fbf90e561bfb3ea833c5fa5900225d6a37471539482203f",
  [EXCERPTS.implementation]: "c1cce7142949761b08b45948df576c00dde5808cac8198875e96401b2e5973f5",
  [EXCERPTS.test]: "69a67727b9b512ae37c56f0455d75800c5bbcee4e2a8f155f770cc3a01ad68f5",
});

function evidence(
  evidence_id: string,
  authority_kind: "provider-official" | "service-contract" | "service-registry" | "service-implementation" | "service-test" | "service-legal",
  source_locator: string,
  reviewed_excerpt: string,
  supportedFactIds: readonly string[],
) {
  const official = authority_kind === "provider-official";
  const snapshot = official ? "unavailable" : "sha256";
  return Object.freeze({
    schema_version: "ai_legal_source_evidence_v1",
    evidence_id,
    authority_kind,
    source_locator_kind: official ? "https-url" : "repo-path",
    source_locator,
    checked_at: CHECKED_AT,
    source_revision_status: "unavailable",
    source_revision: "",
    upstream_snapshot_status: snapshot,
    upstream_snapshot_artifact_path: official ? "" : source_locator,
    upstream_snapshot_sha256: official ? "" : GIT_BLOB_SHA256[source_locator as keyof typeof GIT_BLOB_SHA256],
    reviewed_excerpt,
    reviewed_excerpt_sha256: EXCERPT_SHA256[reviewed_excerpt as keyof typeof EXCERPT_SHA256],
    supported_fact_ids: Object.freeze([...supportedFactIds]),
    supported_fact_sha256s: Object.freeze(supportedFactIds.map(factHash)),
  });
}

const dsExternalApi = ["fact.deepseek.model.external.v1", "fact.deepseek.wire.external.v1", "fact.deepseek.endpoint.external.v1", "fact.deepseek.subject.capability.v1"];
const dsExternalPolicy = ["fact.deepseek.operator.external.v1", "fact.deepseek.region.v1", "fact.deepseek.retention.v1", "fact.deepseek.training.v1", "fact.deepseek.transfer.v1"];
const dsExternalCache = ["fact.deepseek.cache.v1"];
const dsOperational = manifestFacts.filter((item) => item.fact_id.startsWith("fact.deepseek.") && item.authority_class === "service-operational").map((item) => item.fact_id);
const dsRegistry = ["fact.deepseek.gateway.service.v1", "fact.deepseek.model.selection.v1", "fact.deepseek.wire.selection.v1", "fact.deepseek.endpoint.selection.v1", "fact.deepseek.display.v1"];
const dsDisplay = ["fact.deepseek.display.v1"];
const dsDerivation = ["fact.deepseek.subject.derivation.v1"];

const mimoExternalApi = ["fact.mimo.model.external.v1", "fact.mimo.wire.external.v1", "fact.mimo.endpoint.external.v1"];
const mimoExternalTerms = ["fact.mimo.operator.external.v1"];
const mimoExternalPolicy = ["fact.mimo.region.v1", "fact.mimo.cache.v1", "fact.mimo.retention.v1", "fact.mimo.training.v1", "fact.mimo.transfer.v1"];
const mimoOperational = manifestFacts.filter((item) => item.fact_id.startsWith("fact.mimo.") && item.authority_class === "service-operational").map((item) => item.fact_id);
const mimoRegistry = ["fact.mimo.gateway.service.v1", "fact.mimo.model.selection.v1", "fact.mimo.wire.selection.v1", "fact.mimo.endpoint.selection.v1", "fact.mimo.display.v1"];
const mimoDisplay = ["fact.mimo.display.v1"];

const manifestEvidence = Object.freeze([
  evidence("evidence.deepseek.api.v1", "provider-official", "https://api-docs.deepseek.com/api/create-chat-completion/", EXCERPTS.deepseekApi, dsExternalApi),
  evidence("evidence.deepseek.policy.v1", "provider-official", "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html", EXCERPTS.deepseekPolicy, dsExternalPolicy),
  evidence("evidence.deepseek.cache.v1", "provider-official", "https://api-docs.deepseek.com/guides/kv_cache/", EXCERPTS.deepseekCache, dsExternalCache),
  evidence("evidence.deepseek.contract.v1", "service-contract", CONTRACT_PATH, EXCERPTS.contract, [...dsOperational, ...dsDisplay]),
  evidence("evidence.deepseek.registry.adapter.v1", "service-registry", ADAPTER_REGISTRY_PATH, EXCERPTS.registry, dsRegistry),
  evidence("evidence.deepseek.registry.profile.v1", "service-registry", PROFILE_REGISTRY_PATH, EXCERPTS.registry, dsRegistry),
  evidence("evidence.deepseek.legal.en.v1", "service-legal", LEGAL_EN_PATH, EXCERPTS.legal, dsDisplay),
  evidence("evidence.deepseek.legal.zh.v1", "service-legal", LEGAL_ZH_PATH, EXCERPTS.legal, dsDisplay),
  evidence("evidence.deepseek.subject.implementation.v1", "service-implementation", SUBJECT_IMPLEMENTATION_PATH, EXCERPTS.implementation, dsDerivation),
  evidence("evidence.deepseek.subject.test.v1", "service-test", SUBJECT_TEST_PATH, EXCERPTS.test, dsDerivation),
  evidence("evidence.mimo.api.v1", "provider-official", "https://mimo.mi.com/docs/en-US/api/chat/responses", EXCERPTS.mimoApi, mimoExternalApi),
  evidence("evidence.mimo.terms.v1", "provider-official", "https://mimo.mi.com/docs/quick-start/terms/user-agreement", EXCERPTS.mimoTerms, mimoExternalTerms),
  evidence("evidence.mimo.policy.v1", "provider-official", "https://mimo.mi.com/docs/en-US/terms/privacy-policy", EXCERPTS.mimoPolicy, mimoExternalPolicy),
  evidence("evidence.mimo.contract.v1", "service-contract", CONTRACT_PATH, EXCERPTS.contract, [...mimoOperational, ...mimoDisplay]),
  evidence("evidence.mimo.registry.adapter.v1", "service-registry", ADAPTER_REGISTRY_PATH, EXCERPTS.registry, mimoRegistry),
  evidence("evidence.mimo.registry.profile.v1", "service-registry", PROFILE_REGISTRY_PATH, EXCERPTS.registry, mimoRegistry),
  evidence("evidence.mimo.legal.en.v1", "service-legal", LEGAL_EN_PATH, EXCERPTS.legal, mimoDisplay),
  evidence("evidence.mimo.legal.zh.v1", "service-legal", LEGAL_ZH_PATH, EXCERPTS.legal, mimoDisplay),
]);

const routeDescriptors = Object.freeze([
  Object.freeze({
    schema_version: "ai_legal_route_identity_v1", route_descriptor_id: "route.deepseek.official.v1",
    profile_key: "deepseek.official.deepseek-v4-flash.chat.v1", gateway_kind: "direct_deepseek",
    operator_identity_status: "known", operator_legal_name: "Hangzhou DeepSeek Artificial Intelligence Co., Ltd.",
    model_vendor_id: "deepseek", model_vendor_name: "DeepSeek", model_id: "deepseek-v4-flash",
    wire_api_kind: "chat_completions_v1", endpoint_alias: "deepseek_official",
    canonical_endpoint_url: "https://api.deepseek.com/chat/completions", display_disclosure_key: "deepseek-official-v1",
  }),
  Object.freeze({
    schema_version: "ai_legal_route_identity_v1", route_descriptor_id: "route.mimo.cn.official.v1",
    profile_key: "mimo.cn.mimo-v2.5-pro.responses.v1", gateway_kind: "direct_mimo",
    operator_identity_status: "unverified", operator_legal_name: "",
    model_vendor_id: "xiaomi-mimo", model_vendor_name: "Xiaomi / MiMo", model_id: "mimo-v2.5-pro",
    wire_api_kind: "responses_v1", endpoint_alias: "mimo_cn_official",
    canonical_endpoint_url: "https://api.xiaomimimo.com/v1/responses", display_disclosure_key: "mimo-cn-v1",
  }),
]);

const subjectDescriptors = Object.freeze([
  Object.freeze({
    schema_version: "ai_legal_provider_subject_v1", subject_descriptor_id: "subject.deepseek.hmac-v2.v1",
    mode: "pseudonymous_hmac", wire_field: "user_id", algorithm: "hmac-sha256",
    secret_class: "utf8-trimmed-env:AI_USER_ID_HMAC_SECRET",
    derivation_message_schema: "ASCII(provider-subject-v2\\nprofile_version_id:)+UUID36LOWER(profile_version_id)+ASCII(\\nuser_id:)+UUID36LOWER(user_id)",
    output_encoding: "lowercase-hex", source_identity_class: "authenticated-user-id",
    raw_email_sent: false, raw_username_sent: false, raw_account_id_sent: false,
    documented_purposes: Object.freeze(["cache-isolation", "content-safety", "scheduling-isolation"]),
  }),
  Object.freeze({
    schema_version: "ai_legal_provider_subject_v1", subject_descriptor_id: "subject.mimo.none.v1",
    mode: "none", wire_field: "", algorithm: "", secret_class: "", derivation_message_schema: "",
    output_encoding: "", source_identity_class: "", raw_email_sent: false, raw_username_sent: false,
    raw_account_id_sent: false, documented_purposes: Object.freeze([]),
  }),
]);

const descriptorHash = (descriptor: unknown): string => fingerprintLegalDescriptorV1(descriptor).sha256;

function manifest(
  manifest_id: string,
  display_disclosure_key: string,
  routeId: string,
  subjectId: string,
  factPrefix: "fact.deepseek." | "fact.mimo.",
  evidencePrefix: "evidence.deepseek." | "evidence.mimo.",
) {
  const route = routeDescriptors.find((item) => item.route_descriptor_id === routeId)!;
  const subject = subjectDescriptors.find((item) => item.subject_descriptor_id === subjectId)!;
  const facts = manifestFacts.filter((item) => item.fact_id.startsWith(factPrefix));
  const evidenceItems = manifestEvidence.filter((item) => item.evidence_id.startsWith(evidencePrefix));
  return Object.freeze({
    schema_version: "ai_legal_manifest_fingerprint_v1", manifest_id, display_disclosure_key,
    reviewed_at: CHECKED_AT,
    route_descriptor_ids: Object.freeze([routeId]), route_descriptor_sha256s: Object.freeze([descriptorHash(route)]),
    subject_descriptor_id: subjectId, subject_descriptor_sha256: descriptorHash(subject),
    fact_ids: Object.freeze(facts.map((item) => item.fact_id)), fact_sha256s: Object.freeze(facts.map(descriptorHash)),
    evidence_ids: Object.freeze(evidenceItems.map((item) => item.evidence_id)), evidence_sha256s: Object.freeze(evidenceItems.map(descriptorHash)),
  });
}

const manifests = Object.freeze([
  manifest(DEEPSEEK_LEGAL_MANIFEST_ID, "deepseek-official-v1", "route.deepseek.official.v1", "subject.deepseek.hmac-v2.v1", "fact.deepseek.", "evidence.deepseek."),
  manifest(MIMO_LEGAL_MANIFEST_ID, "mimo-cn-v1", "route.mimo.cn.official.v1", "subject.mimo.none.v1", "fact.mimo.", "evidence.mimo."),
]);

const semanticGroups = Object.freeze({
  "neutral-body": semanticFacts.filter((item) => item.fact_id.startsWith("fact.neutral.")),
  "privacy-ai": semanticFacts.filter((item) => item.fact_id.startsWith("fact.privacy.")),
  acceptance: semanticFacts.filter((item) => item.fact_id.startsWith("fact.acceptance.")),
  "route-disclosure": semanticFacts.filter((item) => item.fact_id.startsWith("fact.route.")),
  "material-change": semanticFacts.filter((item) => item.fact_id.startsWith("fact.material.")),
});

const semanticEvidence: ReturnType<typeof evidence>[] = [];
for (const [kind, facts] of Object.entries(semanticGroups)) {
  const operational = facts.filter((item) => item.authority_class === "service-operational").map((item) => item.fact_id);
  const display = facts.filter((item) => item.authority_class === "service-display").map((item) => item.fact_id);
  semanticEvidence.push(evidence(`evidence.semantic.${kind}.contract.v1`, "service-contract", CONTRACT_PATH, EXCERPTS.contract, [...operational, ...display]));
  if (display.length > 0) {
    semanticEvidence.push(evidence(`evidence.semantic.${kind}.legal.en.v1`, "service-legal", LEGAL_EN_PATH, EXCERPTS.legal, display));
    semanticEvidence.push(evidence(`evidence.semantic.${kind}.legal.zh.v1`, "service-legal", LEGAL_ZH_PATH, EXCERPTS.legal, display));
  }
}
Object.freeze(semanticEvidence);

const semanticContracts = Object.freeze(Object.entries(semanticGroups).map(([contract_kind, facts]) => {
  const evidenceItems = semanticEvidence.filter((item) => item.evidence_id.startsWith(`evidence.semantic.${contract_kind}.`));
  return Object.freeze({
    schema_version: "ai_legal_bundle_semantic_contract_v1",
    contract_id: `contract.${contract_kind}.2026-08-23.v1`, contract_kind,
    fact_ids: Object.freeze(facts.map((item) => item.fact_id)), fact_sha256s: Object.freeze(facts.map(descriptorHash)),
    evidence_ids: Object.freeze(evidenceItems.map((item) => item.evidence_id)), evidence_sha256s: Object.freeze(evidenceItems.map(descriptorHash)),
  });
}));

const semanticByKind = new Map(semanticContracts.map((item) => [item.contract_kind, item]));
const contractRef = (kind: string) => semanticByKind.get(kind)!;

const bundleContract = Object.freeze({
  schema_version: "ai_legal_bundle_contract_fingerprint_v1",
  legal_bundle_version: INITIAL_LEGAL_BUNDLE_VERSION,
  document_key: "ai_terms",
  ai_terms_version: INITIAL_LEGAL_BUNDLE_VERSION,
  manifest_fingerprint_schema_version: "ai_legal_manifest_fingerprint_v1",
  semantic_contract_schema_version: "ai_legal_bundle_semantic_contract_v1",
  neutral_body_contract_id: contractRef("neutral-body").contract_id,
  neutral_body_contract_sha256: descriptorHash(contractRef("neutral-body")),
  privacy_ai_contract_id: contractRef("privacy-ai").contract_id,
  privacy_ai_contract_sha256: descriptorHash(contractRef("privacy-ai")),
  acceptance_contract_id: contractRef("acceptance").contract_id,
  acceptance_contract_sha256: descriptorHash(contractRef("acceptance")),
  route_disclosure_contract_id: contractRef("route-disclosure").contract_id,
  route_disclosure_contract_sha256: descriptorHash(contractRef("route-disclosure")),
  material_change_contract_id: contractRef("material-change").contract_id,
  material_change_contract_sha256: descriptorHash(contractRef("material-change")),
  manifest_ids: Object.freeze(manifests.map((item) => item.manifest_id)),
  manifest_sha256s: Object.freeze(manifests.map(descriptorHash)),
});

export const LEGAL_FINGERPRINT_V1_DESCRIPTORS = Object.freeze({
  routes: routeDescriptors,
  subjects: subjectDescriptors,
  facts: allFacts,
  evidence: Object.freeze([...manifestEvidence, ...semanticEvidence]),
  manifests,
  semanticContracts,
  bundleContract,
});

function descriptorIdentity(descriptor: Record<string, unknown>): string {
  switch (descriptor.schema_version) {
    case "ai_legal_route_identity_v1": return descriptor.route_descriptor_id as string;
    case "ai_legal_provider_subject_v1": return descriptor.subject_descriptor_id as string;
    case "ai_legal_fact_v1": return descriptor.fact_id as string;
    case "ai_legal_source_evidence_v1": return descriptor.evidence_id as string;
    case "ai_legal_manifest_fingerprint_v1": return descriptor.manifest_id as string;
    case "ai_legal_bundle_semantic_contract_v1": return descriptor.contract_id as string;
    case "ai_legal_bundle_contract_fingerprint_v1": return descriptor.legal_bundle_version as string;
    default: throw new Error(`unsupported descriptor schema ${String(descriptor.schema_version)}`);
  }
}

// Root constants were generated by the independent exact-record implementation
// documented in the tests. Every child hash is transitively frozen by these roots.
export const LEGAL_FINGERPRINT_V1_EXPECTED_SHA256 = Object.freeze({
  "route.deepseek.official.v1": "ddd46ac3d94fa9a3d4293f5f59faa52ee93a418927d13a01798f0802ccc99d79",
  "route.mimo.cn.official.v1": "405655fe1a3bbc0aa2eff7217b3f78bc8cd0b991f69cf35c06ac361b041e52fa",
  "subject.deepseek.hmac-v2.v1": "03320dd189290376d0197aaf2907aaf2802a8f03fe3311580c81d2efddb6431c",
  "subject.mimo.none.v1": "d4e088e93e8217a5ef6e351e40ec5b1a0c1c3cfb89cb9ac5e471dcecbf96b805",
  [DEEPSEEK_LEGAL_MANIFEST_ID]: "9af4cf05727c7bb34659b1eb2b0062284acca8676696a7b1fb7fa928543c575f",
  [MIMO_LEGAL_MANIFEST_ID]: "0649e86e0a69703cf8c0cba74baa0d8feecbe1816868c594673afff7b7847f0e",
  "contract.neutral-body.2026-08-23.v1": "b8fbc9a8414c8d4d55c1f779e666bf59d2ea898353aa820b646c0a406f439ffc",
  "contract.privacy-ai.2026-08-23.v1": "314c67a72ed3813a57a338665724cb552b81239bf98f84c611581fafd30687a2",
  "contract.acceptance.2026-08-23.v1": "1d7c370c26b217be904d6fb6bb44ef3eef28ae65b8ac04eb6c032c18be0bc2fb",
  "contract.route-disclosure.2026-08-23.v1": "de36da44d47e6d6f1818d66e85405ee534a721fae3b6f7d011773d3d09b547dd",
  "contract.material-change.2026-08-23.v1": "f063223a6ee39a98758c6a54626d7727d57b0ca420f7beee43d00c5fea1c94a6",
  [INITIAL_LEGAL_BUNDLE_VERSION]: "d1859cf9e1103a6394917b671ead068ea816d5ff97d0776426389877805d358d",
});

const LEGAL_FINGERPRINT_V1_REGISTRY_FACT_IDS = new Set([
  ...dsRegistry,
  ...mimoRegistry,
]);

export function isLegalFingerprintV1RegistryFactId(factId: string): boolean {
  return LEGAL_FINGERPRINT_V1_REGISTRY_FACT_IDS.has(factId);
}

export const LEGAL_FINGERPRINT_V1_PROFILE_MAPPING = Object.freeze([
  Object.freeze({
    profileKey: "deepseek.official.deepseek-v4-flash.chat.v1",
    manifestId: DEEPSEEK_LEGAL_MANIFEST_ID,
    routeDescriptorId: "route.deepseek.official.v1",
    displayDisclosureKey: "deepseek-official-v1",
    descriptorVendorName: "DeepSeek",
    descriptorOperatorName: "Hangzhou DeepSeek Artificial Intelligence Co., Ltd.",
    enOperatorDisplay: "Hangzhou DeepSeek Artificial Intelligence Co., Ltd.",
    zhOperatorDisplay: "杭州深度求索人工智能有限公司（DeepSeek）",
    enProviderDisplay: "Official DeepSeek Open Platform",
    zhProviderDisplay: "DeepSeek 官方开放平台",
    configJcsUtf8Hex: "7b2270726f76696465725375626a6563744669656c64223a22757365725f6964222c22737472756374757265644f7574707574223a226a736f6e5f6f626a656374222c227468696e6b696e67223a2264697361626c6564227d",
    configJcsSha256: "a79bbbaa5934d7f4890b2e97e13e7768f031e99625fe11446ba437feeffc8fa9",
  }),
  Object.freeze({
    profileKey: "mimo.cn.mimo-v2.5-pro.responses.v1",
    manifestId: MIMO_LEGAL_MANIFEST_ID,
    routeDescriptorId: "route.mimo.cn.official.v1",
    displayDisclosureKey: "mimo-cn-v1",
    descriptorVendorName: "Xiaomi / MiMo",
    descriptorOperatorName: "unverified",
    enOperatorDisplay: "Official MiMo API. The reviewed pages do not identify the specific company operating the service in mainland China. The terms for service outside mainland China name Xiaomi Technologies Singapore Pte. Ltd.",
    zhOperatorDisplay: "MiMo 官方 API；已核验页面未明确给出中国大陆适用运营主体的具体公司名称。中国大陆以外服务的条款列明 Xiaomi Technologies Singapore Pte. Ltd.。",
    enProviderDisplay: "Official MiMo API (mainland-China profile)",
    zhProviderDisplay: "MiMo 官方 API（中国大陆 profile）",
    configJcsUtf8Hex: "7b22726561736f6e696e674566666f7274223a226e6f6e65222c2273656e6450726f76696465725375626a6563744964223a66616c73652c22737472756374757265644f7574707574223a2270726f6d70745f6f6e6c79227d",
    configJcsSha256: "319316de510f767885fdb94d75d067a7383c11f513b908026a2ab4ec68c8a121",
  }),
]);

const BOUND_PROFILE_KEYS = new Set<string>(LEGAL_FINGERPRINT_V1_PROFILE_MAPPING.map((item) => item.profileKey));

export class LegalFingerprintDescriptorV1Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegalFingerprintDescriptorV1Error";
  }
}

export function deriveRequiredServiceFactPairs(profileKeys: ReadonlySet<string>): readonly Readonly<{ id: string; sha256: string }>[] {
  if (
    profileKeys === null || profileKeys === undefined ||
    typeof profileKeys[Symbol.iterator] !== "function" ||
    typeof profileKeys.has !== "function" ||
    !Number.isSafeInteger(profileKeys.size) || profileKeys.size < 0
  ) {
    throw new LegalFingerprintDescriptorV1Error("profileKeys must be an iterable readonly set");
  }
  const requested = [...profileKeys];
  if (requested.length === 0) {
    throw new LegalFingerprintDescriptorV1Error("profileKeys must contain at least one bound profile");
  }
  if (requested.some((profile) => typeof profile !== "string" || !BOUND_PROFILE_KEYS.has(profile))) {
    throw new LegalFingerprintDescriptorV1Error("profileKeys contains an unknown or unbound profile");
  }
  if (
    profileKeys.size !== requested.length ||
    new Set(requested).size !== requested.length ||
    requested.some((profile) => !profileKeys.has(profile))
  ) {
    throw new LegalFingerprintDescriptorV1Error("profileKeys must have readonly-set uniqueness");
  }
  const scopes = new Set(["global", ...requested.map((profile) => `profile:${profile}`)]);
  const reachable = [...manifestFacts, ...semanticFacts].filter((item) =>
    item.authority_class === "service-operational" && scopes.has(item.operational_scope),
  );
  const unique = new Map(reachable.map((item) => [
    item.fact_id,
    Object.freeze({ id: item.fact_id, sha256: descriptorHash(item) }),
  ]));
  return Object.freeze([...unique.values()].sort((left, right) =>
    Buffer.compare(Buffer.from(left.id, "utf8"), Buffer.from(right.id, "utf8")),
  ));
}

export function validateLegalFingerprintV1Closure(): void {
  const descriptors = [...routeDescriptors, ...subjectDescriptors, ...allFacts, ...manifestEvidence, ...semanticEvidence, ...manifests, ...semanticContracts, bundleContract];
  const idToHash = new Map<string, string>();
  for (const descriptor of descriptors) {
    const record = descriptor as Record<string, unknown>;
    const id = descriptorIdentity(record);
    const hash = descriptorHash(descriptor);
    const previous = idToHash.get(id);
    if (previous !== undefined && previous !== hash) throw new Error(`immutable descriptor ID collision: ${id}`);
    idToHash.set(id, hash);
  }

  for (const [id, expected] of Object.entries(LEGAL_FINGERPRINT_V1_EXPECTED_SHA256)) {
    if (idToHash.get(id) !== expected) throw new Error(`reviewed root hash mismatch: ${id}`);
  }

  const assertPairs = (ids: readonly string[], hashes: readonly string[], label: string): void => {
    if (ids.length !== hashes.length) throw new Error(`${label} pair length mismatch`);
    ids.forEach((id, index) => {
      if (idToHash.get(id) !== hashes[index]) throw new Error(`${label} unresolved ID/hash pair: ${id}`);
    });
  };
  for (const item of [...manifestEvidence, ...semanticEvidence]) {
    assertPairs(item.supported_fact_ids, item.supported_fact_sha256s, item.evidence_id);
  }
  for (const root of manifests) {
    assertPairs(root.route_descriptor_ids, root.route_descriptor_sha256s, `${root.manifest_id}.routes`);
    if (idToHash.get(root.subject_descriptor_id) !== root.subject_descriptor_sha256) {
      throw new Error(`${root.manifest_id} has an unresolved subject pair`);
    }
    assertPairs(root.fact_ids, root.fact_sha256s, `${root.manifest_id}.facts`);
    assertPairs(root.evidence_ids, root.evidence_sha256s, `${root.manifest_id}.evidence`);
  }
  for (const root of semanticContracts) {
    assertPairs(root.fact_ids, root.fact_sha256s, `${root.contract_id}.facts`);
    assertPairs(root.evidence_ids, root.evidence_sha256s, `${root.contract_id}.evidence`);
  }
  const slots = [
    ["neutral-body", bundleContract.neutral_body_contract_id, bundleContract.neutral_body_contract_sha256],
    ["privacy-ai", bundleContract.privacy_ai_contract_id, bundleContract.privacy_ai_contract_sha256],
    ["acceptance", bundleContract.acceptance_contract_id, bundleContract.acceptance_contract_sha256],
    ["route-disclosure", bundleContract.route_disclosure_contract_id, bundleContract.route_disclosure_contract_sha256],
    ["material-change", bundleContract.material_change_contract_id, bundleContract.material_change_contract_sha256],
  ] as const;
  for (const [kind, id, hash] of slots) {
    if (idToHash.get(id) !== hash || semanticByKind.get(kind)?.contract_id !== id) {
      throw new Error(`bundle has an unresolved ${kind} contract pair`);
    }
  }
  assertPairs(bundleContract.manifest_ids, bundleContract.manifest_sha256s, "bundle.manifests");

  const validateRoot = (factIds: readonly string[], evidenceIds: readonly string[]): void => {
    const local = new Set(factIds);
    const authorities = new Map(factIds.map((id) => [id, new Set<string>()]));
    for (const evidenceId of evidenceIds) {
      const item = [...manifestEvidence, ...semanticEvidence].find((candidate) => candidate.evidence_id === evidenceId);
      if (item === undefined || item.supported_fact_ids.length === 0) throw new Error(`unresolved or empty evidence ${evidenceId}`);
      for (const factId of item.supported_fact_ids) {
        if (!local.has(factId)) throw new Error(`evidence ${evidenceId} escapes its root via ${factId}`);
        authorities.get(factId)!.add(item.authority_kind);
      }
    }
    for (const factId of factIds) {
      const item = factById.get(factId)!;
      const actual = authorities.get(factId)!;
      const required = item.authority_class === "provider-external"
        ? ["provider-official"]
        : item.authority_class === "service-display"
          ? ["service-contract", "service-legal"]
          : ["service-contract"];
      if (LEGAL_FINGERPRINT_V1_REGISTRY_FACT_IDS.has(factId)) required.push("service-registry");
      if (factId === "fact.deepseek.subject.derivation.v1") required.push("service-implementation", "service-test");
      for (const authority of required) if (!actual.has(authority)) throw new Error(`${factId} lacks ${authority} in its own root`);
    }
  };
  for (const root of manifests) validateRoot(root.fact_ids, root.evidence_ids);
  for (const root of semanticContracts) validateRoot(root.fact_ids, root.evidence_ids);
}
