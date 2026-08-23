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
  [LEGAL_EN_PATH]: "6ae774d66dcd2a43c9d33c10cb09e55c9eec835e2e5e1952618b9834580caba7",
  [LEGAL_ZH_PATH]: "24988e445966bddec80fee84d0292bc11723a045ed92025fd85fe1e9fba10901",
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
  fact("fact.deepseek.gateway.service.v1", "gateway", "service-operational", deepseekScope, "deepseek.official.deepseek-v4-flash.chat.v1 profile registration", "binds gateway", "direct_deepseek", "code-owned profile registry"),
  fact("fact.deepseek.operator.external.v1", "operator", "provider-external", "", "official DeepSeek Open Platform", "is operated by", "Hangzhou DeepSeek Artificial Intelligence Co., Ltd.", "reviewed official platform terms"),
  fact("fact.deepseek.model.external.v1", "model", "provider-external", "", "DeepSeek official API", "offers model", "deepseek-v4-flash by DeepSeek", "Chat Completions profile"),
  fact("fact.deepseek.model.selection.v1", "model", "service-operational", deepseekScope, "deepseek.official.deepseek-v4-flash.chat.v1 profile registration", "binds model", "deepseek-v4-flash", "code-owned profile registry"),
  fact("fact.deepseek.wire.external.v1", "wire", "provider-external", "", "DeepSeek official API", "supports wire API", "Chat Completions", "reviewed create-chat-completion API"),
  fact("fact.deepseek.wire.selection.v1", "wire", "service-operational", deepseekScope, "deepseek.official.deepseek-v4-flash.chat.v1 profile registration", "binds wire API", "chat_completions_v1", "code-owned profile registry"),
  fact("fact.deepseek.adapter.wire.v1", "wire", "service-operational", deepseekScope, "deepseek_chat_v1 adapter registration", "binds wire API", "chat_completions_v1", "code-owned adapter registry"),
  fact("fact.deepseek.endpoint.external.v1", "endpoint", "provider-external", "", "DeepSeek official API", "publishes endpoint", "https://api.deepseek.com/chat/completions", "reviewed exact HTTPS endpoint"),
  fact("fact.deepseek.endpoint.selection.v1", "endpoint", "service-operational", deepseekScope, "deepseek.official.deepseek-v4-flash.chat.v1 profile registration", "binds endpoint alias", "deepseek_official", "code-owned profile registry"),
  fact("fact.deepseek.endpoint.resolution.v1", "endpoint", "service-operational", deepseekScope, "deepseek_official endpoint registration", "resolves canonical URL", "https://api.deepseek.com/chat/completions", "code-owned adapter registry"),
  fact("fact.deepseek.display.v1", "display", "service-display", "", "cv maker provider annex", "maps display key", "deepseek-official-v1 means Official DeepSeek Open Platform / DeepSeek 官方开放平台", "English and Chinese legal content"),
  fact("fact.deepseek.display.selection.v1", "display", "service-operational", deepseekScope, "deepseek.official.deepseek-v4-flash.chat.v1 profile registration", "binds display disclosure key", "deepseek-official-v1", "code-owned profile registry"),
  fact("fact.deepseek.display.registration.v1", "display", "service-operational", deepseekScope, "deepseek-official-v1 display registration", "binds canonical provider/model labels", "DeepSeek / DeepSeek V4 Flash", "code-owned adapter registry"),
  fact("fact.deepseek.subject.capability.v1", "provider-subject", "provider-external", "", "DeepSeek Chat API", "documents user_id", "pseudonymous identifier for content safety, cache isolation, and scheduling isolation", "official create-chat-completion documentation"),
  fact("fact.deepseek.subject.send.v1", "provider-subject", "service-operational", deepseekScope, "cv maker DeepSeek adapter", "sends provider subject", "user_id is lowercase-hex HMAC-SHA256 over the frozen V2 profile and authenticated user identity", "V2 DeepSeek profile", ["no raw email", "no raw username", "no raw account ID"]),
  fact("fact.deepseek.subject.derivation.v1", "provider-subject", "service-operational", deepseekScope, "cv maker provider-subject-v2", "derives pseudonym", "HMAC-SHA256 using utf8-trimmed-env:AI_USER_ID_HMAC_SECRET and the exact provider-subject-v2 message schema", "frozen V2 profile and authenticated-user UUID", ["lowercase-hex output"]),
  fact("fact.deepseek.submitted.v1", "submitted-data", "service-operational", deepseekScope, "cv maker AI polish", "submits", "user-selected resume text, chosen context, style instructions, and pseudonymous user_id", "DeepSeek profile"),
  fact("fact.deepseek.region.v1", "region", "provider-external", "", "DeepSeek general Privacy Policy", "establishes Open Platform API-content processing location", "unverified; its PRC statement expressly excludes products and services provided by downstream users", "content submitted by cv maker through the Open Platform API", [], "unverified"),
  fact("fact.deepseek.cache.v1", "cache", "provider-external", "", "DeepSeek API", "uses disk context caching", "enabled by default; unused cache usually clears within hours to days", "official context caching guide"),
  fact("fact.deepseek.retention.v1", "retention", "provider-external", "", "DeepSeek Terms of Use", "provides a fixed overall API-content retention period", "not found", "Services expressly including APIs", [], "not-found"),
  fact("fact.deepseek.training.v1", "training", "provider-external", "", "DeepSeek Terms of Use", "describes provider improvement use", "limited use of de-identified data to improve Services that include APIs; no API-specific no-training commitment or opt-out was verified", "Terms of Use scope; no provider-training authority is inferred from Open Platform Terms section 4.2"),
  fact("fact.deepseek.transfer.v1", "transfer", "provider-external", "", "DeepSeek general Privacy Policy", "establishes the Open Platform API-content transfer path", "unverified; downstream-user products and services are excluded from the general policy scope", "content submitted by cv maker through the Open Platform API", [], "unverified"),
  fact("fact.mimo.gateway.service.v1", "gateway", "service-operational", mimoScope, "mimo.cn.mimo-v2.5-pro.responses.v1 profile registration", "binds gateway", "direct_mimo", "code-owned profile registry"),
  fact("fact.mimo.operator.external.v1", "operator", "provider-external", "", "MiMo mainland-China API", "identifies operating legal entity", "unverified; reviewed pages do not identify the specific mainland-China operator", "mainland-China profile", ["outside-mainland terms name Xiaomi Technologies Singapore Pte. Ltd. only outside this scope"], "unverified"),
  fact("fact.mimo.model.external.v1", "model", "provider-external", "", "official MiMo API", "offers model", "mimo-v2.5-pro by Xiaomi / MiMo", "Responses API profile"),
  fact("fact.mimo.model.selection.v1", "model", "service-operational", mimoScope, "mimo.cn.mimo-v2.5-pro.responses.v1 profile registration", "binds model", "mimo-v2.5-pro", "code-owned profile registry"),
  fact("fact.mimo.wire.external.v1", "wire", "provider-external", "", "official MiMo API", "supports wire API", "Responses API", "reviewed responses documentation"),
  fact("fact.mimo.wire.selection.v1", "wire", "service-operational", mimoScope, "mimo.cn.mimo-v2.5-pro.responses.v1 profile registration", "binds wire API", "responses_v1", "code-owned profile registry"),
  fact("fact.mimo.adapter.wire.v1", "wire", "service-operational", mimoScope, "mimo_responses_v1 adapter registration", "binds wire API", "responses_v1", "code-owned adapter registry"),
  fact("fact.mimo.endpoint.external.v1", "endpoint", "provider-external", "", "official MiMo API", "publishes endpoint", "https://api.xiaomimimo.com/v1/responses", "reviewed exact HTTPS endpoint"),
  fact("fact.mimo.endpoint.selection.v1", "endpoint", "service-operational", mimoScope, "mimo.cn.mimo-v2.5-pro.responses.v1 profile registration", "binds endpoint alias", "mimo_cn_official", "code-owned profile registry"),
  fact("fact.mimo.endpoint.resolution.v1", "endpoint", "service-operational", mimoScope, "mimo_cn_official endpoint registration", "resolves canonical URL", "https://api.xiaomimimo.com/v1/responses", "code-owned adapter registry"),
  fact("fact.mimo.display.v1", "display", "service-display", "", "cv maker provider annex", "maps display key", "mimo-cn-v1 means Official MiMo API mainland-China profile / MiMo 官方 API 中国大陆 profile", "English and Chinese legal content"),
  fact("fact.mimo.display.selection.v1", "display", "service-operational", mimoScope, "mimo.cn.mimo-v2.5-pro.responses.v1 profile registration", "binds display disclosure key", "mimo-cn-v1", "code-owned profile registry"),
  fact("fact.mimo.display.registration.v1", "display", "service-operational", mimoScope, "mimo-cn-v1 display registration", "binds canonical provider/model labels", "MiMo / MiMo V2.5 Pro", "code-owned adapter registry"),
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
  deepseekApi: "The undated DeepSeek Chat page identifies deepseek-v4-flash, the Chat Completions endpoint and wire, and user_id purposes; it states no API location.",
  deepseekPlatformTerms: "The DeepSeek Open Platform Terms identify the platform operator and API agreement, and exclude downstream-user products in section 5.5; section 4.2 is developer permission, not provider training use.",
  deepseekTermsOfUse: "The DeepSeek Terms of Use applies to Services including APIs and describes limited de-identified improvement use; it states no fixed overall API-content retention period, API-specific no-training commitment, or opt-out.",
  deepseekPrivacy: "The DeepSeek general Privacy Policy states PRC processing but excludes downstream-user products and services, so it does not establish this service's Open Platform API-content location or transfer path.",
  deepseekCache: "The undated DeepSeek cache guide says disk context caching is enabled by default and unused cache usually clears within hours to days.",
  mimoApi: "The MiMo Responses page updated 2026-07-17 identifies mimo-v2.5-pro, the Responses wire API, and the exact official endpoint.",
  mimoTerms: "The MiMo Service Agreement updated 2026-07-07 does not identify the mainland-China operator; its Singapore entity statement is scoped outside mainland China.",
  mimoPrivacy: "MiMo Privacy version 20260421 updated 2026-03-17 supports the reviewed region, retention, submitted-content training, transfer, and cache-unknown facts.",
  deepseekContract: "The frozen provider contract defines only the DeepSeek service-owned route, subject, submission, display, and registry-component facts in this manifest root.",
  mimoContract: "The frozen provider contract defines only the MiMo service-owned route, subject, submission, display, and registry-component facts in this manifest root.",
  deepseekProfile: "The profile registry binds the DeepSeek profile to direct_deepseek, deepseek-v4-flash, chat_completions_v1, deepseek_official, and deepseek-official-v1; it does not resolve endpoint URL or display labels.",
  deepseekAdapter: "The adapter registry binds deepseek_chat_v1 to chat_completions_v1, deepseek_official to the exact HTTPS URL, and deepseek-official-v1 to canonical provider/model labels; it does not select a profile route.",
  mimoProfile: "The profile registry binds the MiMo profile to direct_mimo, mimo-v2.5-pro, responses_v1, mimo_cn_official, and mimo-cn-v1; it does not resolve endpoint URL or display labels.",
  mimoAdapter: "The adapter registry binds mimo_responses_v1 to responses_v1, mimo_cn_official to the exact HTTPS URL, and mimo-cn-v1 to canonical provider/model labels; it does not select a profile route.",
  deepseekLegalEn: "The English legal content maps deepseek-official-v1 to the reviewed DeepSeek provider annex and conservative downstream-scope wording.",
  deepseekLegalZh: "The Chinese legal content maps deepseek-official-v1 to the reviewed DeepSeek provider annex and conservative downstream-scope wording.",
  mimoLegalEn: "The English legal content maps mimo-cn-v1 to the reviewed mainland-China MiMo provider annex and unresolved operator wording.",
  mimoLegalZh: "The Chinese legal content maps mimo-cn-v1 to the reviewed mainland-China MiMo provider annex and unresolved operator wording.",
  implementation: "The reviewed RT-002B implementation defines the exact provider-subject-v2 message, trimmed secret class, HMAC-SHA256, and lowercase-hex output.",
  test: "The reviewed RT-002B tests independently exercise exact message and HMAC vectors, Unicode secret handling, UUID validation, and lowercase output.",
});

const SEMANTIC_EVIDENCE_EXCERPTS = Object.freeze({
  "neutral-body": Object.freeze({
    contract: "The frozen provider contract defines the neutral-body plaintext, submission scope, ledger, retention, quota, retry, and output-review facts only.",
    en: "The English AI terms state the neutral-body output-review obligation.",
    zh: "The Chinese AI terms state the neutral-body output-review obligation.",
  }),
  "privacy-ai": Object.freeze({
    contract: "The frozen provider contract defines the privacy recipient-linkage, transfer-boundary, and retention-linkage facts only.",
    en: "The English Privacy Policy and AI terms state the reviewed route-specific transfer and retention disclosures.",
    zh: "The Chinese Privacy Policy and AI terms state the reviewed route-specific transfer and retention disclosures.",
  }),
  acceptance: Object.freeze({
    contract: "The frozen provider contract defines the ai_terms exact-version display and DB-authoritative acceptance facts only.",
    en: "The English AI terms identify the reviewed ai_terms acceptance document and exact bundle version.",
    zh: "The Chinese AI terms identify the reviewed ai_terms acceptance document and exact bundle version.",
  }),
  "route-disclosure": Object.freeze({
    contract: "The frozen provider contract defines the read-only route, no-selector, no-cross-provider-fallback, and pre-transmission change-gate facts only.",
    en: "",
    zh: "",
  }),
  "material-change": Object.freeze({
    contract: "The frozen provider contract defines the material-change categories and renewed-acceptance enforcement facts only.",
    en: "The English AI terms define the reviewed categories of material AI-provider change.",
    zh: "The Chinese AI terms define the reviewed categories of material AI-provider change.",
  }),
});

// Frozen values were generated with an independent UTF-8 hashing fixture.
// evidence() rejects any excerpt that was not reviewed here.
const EXCERPT_SHA256 = Object.freeze({
  [EXCERPTS.deepseekApi]: "927f475f6cbe458ed39201cc6f12fbf86bfb28fb6ab40d9fefb9cf1f5e433df8",
  [EXCERPTS.deepseekPlatformTerms]: "3d673f0af8136e3377082dabfacb2f02df05b27c29930433318a4412932dadec",
  [EXCERPTS.deepseekTermsOfUse]: "8f4280f0361ce7c6d413c7621f144a8ed61ec1a49bc3375a7f3a9cb01d810800",
  [EXCERPTS.deepseekPrivacy]: "cbb4e816917c2f9efb481913c226b1e531f83ef9ba982823742a6c7038735837",
  [EXCERPTS.deepseekCache]: "abca08f390edae0d2d24ee2c184586c59211b9fd5e15b2183477b320f195bbd1",
  [EXCERPTS.deepseekContract]: "b4ed2c25a03b7e46c0596fdd06cbd7e86a1225cc98c0810282c9c30a0c36707e",
  [EXCERPTS.deepseekAdapter]: "12442f96ab5766f0026b3039f90e67f6a92bd373cd347b792e1d610951cd80ad",
  [EXCERPTS.deepseekProfile]: "f35d17bc5119cad51c8a1981efba58db3db7363e13d2908ea9a0a54e44664cf0",
  [EXCERPTS.deepseekLegalEn]: "853a173b038f08ad31233b17833dbba031219a59134841105f53bcb59b268786",
  [EXCERPTS.deepseekLegalZh]: "29be2ecce203bd743751e7c3050238d20851a356ccfa35008495332d59224c65",
  [EXCERPTS.implementation]: "c1cce7142949761b08b45948df576c00dde5808cac8198875e96401b2e5973f5",
  [EXCERPTS.test]: "69a67727b9b512ae37c56f0455d75800c5bbcee4e2a8f155f770cc3a01ad68f5",
  [EXCERPTS.mimoApi]: "ed4805159064fd084428bf7f226ccca54f0bfd84677f07fe018838d85a86e020",
  [EXCERPTS.mimoTerms]: "cffc469910b4fe9f535145490d6658f273158430af524a157c23fdefe5527e3c",
  [EXCERPTS.mimoPrivacy]: "b8fa69a556c21b50652b2b4fea2dd05e076ba01976eb1988989d4005632ab11d",
  [EXCERPTS.mimoContract]: "866fc9bffcc55eb8c7c18a5813eaf0c9123eb46d0d67d013d754e74812c8aaac",
  [EXCERPTS.mimoAdapter]: "7d7b814ec1f9a39bcfa4e9863a12713c5199aead57f78e95e40ce6027fccfa94",
  [EXCERPTS.mimoProfile]: "0e33eb43a0383b62b5d6e4edd288681956b36f0b861ce5365cd0628d6c783c46",
  [EXCERPTS.mimoLegalEn]: "1b825bad1c73d8c2f23aa7ebc3044d1dc7cb78acd2cf044f1f4195c5cf14af4a",
  [EXCERPTS.mimoLegalZh]: "68da85880293fba58382e77caa5cb6ad5e36ccc17f171e87fe717f75b62accaf",
  [SEMANTIC_EVIDENCE_EXCERPTS["neutral-body"].contract]: "918e642a42226bdf3b016c2deaebfb57878cc5e7a90a28931f9be52e8f009e6e",
  [SEMANTIC_EVIDENCE_EXCERPTS["neutral-body"].en]: "1fc63295b64a3b2b2c8799f9bf6bafe1840bf9654ac2bb6d921da60e1a1a2b43",
  [SEMANTIC_EVIDENCE_EXCERPTS["neutral-body"].zh]: "c8318ddd0c4e79eea20eccb8ccb365902c039c5221ec6f5927bf72faf2deef24",
  [SEMANTIC_EVIDENCE_EXCERPTS["privacy-ai"].contract]: "e8f99f0a1aee2e4f438a2bd9e619efcaad0b5c498dd8fe558ac181e6d0bed304",
  [SEMANTIC_EVIDENCE_EXCERPTS["privacy-ai"].en]: "8166d57ca404d71a9fb6a3322e0e4513076a6a750c18b6803f8bd3ac89992edb",
  [SEMANTIC_EVIDENCE_EXCERPTS["privacy-ai"].zh]: "42becf86e57d4919d14e79a9a25fe12d45c27e065e54170782a94160e8290490",
  [SEMANTIC_EVIDENCE_EXCERPTS.acceptance.contract]: "b3a1660f5459796ff8cee053bd9a6499f8b4542f7bc3787b099c01aa4bcb03d5",
  [SEMANTIC_EVIDENCE_EXCERPTS.acceptance.en]: "315921747dd5e24432a2e5ed76df1e487d8cbb43c3205336afdf0e69a840078d",
  [SEMANTIC_EVIDENCE_EXCERPTS.acceptance.zh]: "969533ed99634df91bd178902eb80e69822f59fc81471b532afe195e126ee2c3",
  [SEMANTIC_EVIDENCE_EXCERPTS["route-disclosure"].contract]: "3312f0d7029521763c44e9123969b04e56a1870ddf20636f2610a4500f744a8b",
  [SEMANTIC_EVIDENCE_EXCERPTS["material-change"].contract]: "af0f291ddcbb8612becc6a07326844a80ff450e74331ff8d904d917cdb71630a",
  [SEMANTIC_EVIDENCE_EXCERPTS["material-change"].en]: "1e901164cea2ac640097831bebace3d44f47a4bfb7b17304e73c5bbad98036eb",
  [SEMANTIC_EVIDENCE_EXCERPTS["material-change"].zh]: "a27da4880efa9d4f8437773c523e91b0f97146770bc9ad8e1daa35e7071132d0",
});

export function resolveLegalFingerprintV1ReviewedExcerptSha256(reviewedExcerpt: unknown): string {
  if (typeof reviewedExcerpt !== "string") {
    throw new Error("legal evidence excerpt must be an exact reviewed string");
  }
  const sha256 = EXCERPT_SHA256[reviewedExcerpt as keyof typeof EXCERPT_SHA256];
  if (sha256 === undefined) {
    throw new Error("unreviewed legal evidence excerpt");
  }
  return sha256;
}

function evidence(
  evidence_id: string,
  authority_kind: "provider-official" | "service-contract" | "service-registry" | "service-implementation" | "service-test" | "service-legal",
  source_locator: string,
  reviewed_excerpt: string,
  supportedFactIds: readonly string[],
  source_revision?: string,
) {
  const official = authority_kind === "provider-official";
  const snapshot = official ? "unavailable" : "sha256";
  const reviewedExcerptSha256 = resolveLegalFingerprintV1ReviewedExcerptSha256(reviewed_excerpt);
  return Object.freeze({
    schema_version: "ai_legal_source_evidence_v1",
    evidence_id,
    authority_kind,
    source_locator_kind: official ? "https-url" : "repo-path",
    source_locator,
    checked_at: CHECKED_AT,
    source_revision_status: source_revision === undefined ? "unavailable" : "known",
    source_revision: source_revision ?? "",
    upstream_snapshot_status: snapshot,
    upstream_snapshot_artifact_path: official ? "" : source_locator,
    upstream_snapshot_sha256: official ? "" : GIT_BLOB_SHA256[source_locator as keyof typeof GIT_BLOB_SHA256],
    reviewed_excerpt,
    reviewed_excerpt_sha256: reviewedExcerptSha256,
    supported_fact_ids: Object.freeze([...supportedFactIds]),
    supported_fact_sha256s: Object.freeze(supportedFactIds.map(factHash)),
  });
}

const dsExternalApi = Object.freeze(["fact.deepseek.model.external.v1", "fact.deepseek.wire.external.v1", "fact.deepseek.endpoint.external.v1", "fact.deepseek.subject.capability.v1"]);
const dsExternalPlatformTerms = Object.freeze(["fact.deepseek.operator.external.v1"]);
const dsExternalTermsOfUse = Object.freeze(["fact.deepseek.retention.v1", "fact.deepseek.training.v1"]);
const dsExternalPrivacy = Object.freeze(["fact.deepseek.region.v1", "fact.deepseek.transfer.v1"]);
const dsExternalCache = Object.freeze(["fact.deepseek.cache.v1"]);
const dsOperational = manifestFacts.filter((item) => item.fact_id.startsWith("fact.deepseek.") && item.authority_class === "service-operational").map((item) => item.fact_id);
const dsProfileRegistry = Object.freeze(["fact.deepseek.gateway.service.v1", "fact.deepseek.model.selection.v1", "fact.deepseek.wire.selection.v1", "fact.deepseek.endpoint.selection.v1", "fact.deepseek.display.selection.v1"]);
const dsAdapterRegistry = Object.freeze(["fact.deepseek.adapter.wire.v1", "fact.deepseek.endpoint.resolution.v1", "fact.deepseek.display.registration.v1"]);
const dsRegistry = Object.freeze([...dsProfileRegistry, ...dsAdapterRegistry]);
const dsDisplay = Object.freeze(["fact.deepseek.display.v1"]);
const dsDerivation = Object.freeze(["fact.deepseek.subject.derivation.v1"]);

const mimoExternalApi = Object.freeze(["fact.mimo.model.external.v1", "fact.mimo.wire.external.v1", "fact.mimo.endpoint.external.v1"]);
const mimoExternalTerms = Object.freeze(["fact.mimo.operator.external.v1"]);
const mimoExternalPolicy = Object.freeze(["fact.mimo.region.v1", "fact.mimo.cache.v1", "fact.mimo.retention.v1", "fact.mimo.training.v1", "fact.mimo.transfer.v1"]);
const mimoOperational = manifestFacts.filter((item) => item.fact_id.startsWith("fact.mimo.") && item.authority_class === "service-operational").map((item) => item.fact_id);
const mimoProfileRegistry = Object.freeze(["fact.mimo.gateway.service.v1", "fact.mimo.model.selection.v1", "fact.mimo.wire.selection.v1", "fact.mimo.endpoint.selection.v1", "fact.mimo.display.selection.v1"]);
const mimoAdapterRegistry = Object.freeze(["fact.mimo.adapter.wire.v1", "fact.mimo.endpoint.resolution.v1", "fact.mimo.display.registration.v1"]);
const mimoRegistry = Object.freeze([...mimoProfileRegistry, ...mimoAdapterRegistry]);
const mimoDisplay = Object.freeze(["fact.mimo.display.v1"]);

const REGISTRY_EVIDENCE_SOURCE_MAPPING = Object.freeze({
  "evidence.deepseek.registry.adapter.v1": Object.freeze({ sourceLocator: ADAPTER_REGISTRY_PATH, factIds: dsAdapterRegistry }),
  "evidence.deepseek.registry.profile.v1": Object.freeze({ sourceLocator: PROFILE_REGISTRY_PATH, factIds: dsProfileRegistry }),
  "evidence.mimo.registry.adapter.v1": Object.freeze({ sourceLocator: ADAPTER_REGISTRY_PATH, factIds: mimoAdapterRegistry }),
  "evidence.mimo.registry.profile.v1": Object.freeze({ sourceLocator: PROFILE_REGISTRY_PATH, factIds: mimoProfileRegistry }),
});

const manifestEvidence = Object.freeze([
  evidence("evidence.deepseek.api.v1", "provider-official", "https://api-docs.deepseek.com/api/create-chat-completion/", EXCERPTS.deepseekApi, dsExternalApi),
  evidence("evidence.deepseek.platform-terms.v1", "provider-official", "https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html", EXCERPTS.deepseekPlatformTerms, dsExternalPlatformTerms, "released=2026-04-22;effective=2026-04-29"),
  evidence("evidence.deepseek.terms-of-use.v1", "provider-official", "https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html", EXCERPTS.deepseekTermsOfUse, dsExternalTermsOfUse, "last-updated=2026-03-27"),
  evidence("evidence.deepseek.policy.v1", "provider-official", "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html", EXCERPTS.deepseekPrivacy, dsExternalPrivacy, "last-updated=2026-02-10"),
  evidence("evidence.deepseek.cache.v1", "provider-official", "https://api-docs.deepseek.com/guides/kv_cache/", EXCERPTS.deepseekCache, dsExternalCache),
  evidence("evidence.deepseek.contract.v1", "service-contract", CONTRACT_PATH, EXCERPTS.deepseekContract, [...dsOperational, ...dsDisplay]),
  evidence("evidence.deepseek.registry.adapter.v1", "service-registry", ADAPTER_REGISTRY_PATH, EXCERPTS.deepseekAdapter, dsAdapterRegistry),
  evidence("evidence.deepseek.registry.profile.v1", "service-registry", PROFILE_REGISTRY_PATH, EXCERPTS.deepseekProfile, dsProfileRegistry),
  evidence("evidence.deepseek.legal.en.v1", "service-legal", LEGAL_EN_PATH, EXCERPTS.deepseekLegalEn, dsDisplay),
  evidence("evidence.deepseek.legal.zh.v1", "service-legal", LEGAL_ZH_PATH, EXCERPTS.deepseekLegalZh, dsDisplay),
  evidence("evidence.deepseek.subject.implementation.v1", "service-implementation", SUBJECT_IMPLEMENTATION_PATH, EXCERPTS.implementation, dsDerivation),
  evidence("evidence.deepseek.subject.test.v1", "service-test", SUBJECT_TEST_PATH, EXCERPTS.test, dsDerivation),
  evidence("evidence.mimo.api.v1", "provider-official", "https://mimo.mi.com/docs/en-US/api/chat/responses", EXCERPTS.mimoApi, mimoExternalApi, "updated=2026-07-17"),
  evidence("evidence.mimo.terms.v1", "provider-official", "https://mimo.mi.com/docs/quick-start/terms/user-agreement", EXCERPTS.mimoTerms, mimoExternalTerms, "updated=2026-07-07"),
  evidence("evidence.mimo.policy.v1", "provider-official", "https://mimo.mi.com/docs/en-US/terms/privacy-policy", EXCERPTS.mimoPrivacy, mimoExternalPolicy, "version=20260421;updated=2026-03-17"),
  evidence("evidence.mimo.contract.v1", "service-contract", CONTRACT_PATH, EXCERPTS.mimoContract, [...mimoOperational, ...mimoDisplay]),
  evidence("evidence.mimo.registry.adapter.v1", "service-registry", ADAPTER_REGISTRY_PATH, EXCERPTS.mimoAdapter, mimoAdapterRegistry),
  evidence("evidence.mimo.registry.profile.v1", "service-registry", PROFILE_REGISTRY_PATH, EXCERPTS.mimoProfile, mimoProfileRegistry),
  evidence("evidence.mimo.legal.en.v1", "service-legal", LEGAL_EN_PATH, EXCERPTS.mimoLegalEn, mimoDisplay),
  evidence("evidence.mimo.legal.zh.v1", "service-legal", LEGAL_ZH_PATH, EXCERPTS.mimoLegalZh, mimoDisplay),
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
  const excerpts = SEMANTIC_EVIDENCE_EXCERPTS[kind as keyof typeof SEMANTIC_EVIDENCE_EXCERPTS];
  const operational = facts.filter((item) => item.authority_class === "service-operational").map((item) => item.fact_id);
  const display = facts.filter((item) => item.authority_class === "service-display").map((item) => item.fact_id);
  semanticEvidence.push(evidence(`evidence.semantic.${kind}.contract.v1`, "service-contract", CONTRACT_PATH, excerpts.contract, [...operational, ...display]));
  if (display.length > 0) {
    semanticEvidence.push(evidence(`evidence.semantic.${kind}.legal.en.v1`, "service-legal", LEGAL_EN_PATH, excerpts.en, display));
    semanticEvidence.push(evidence(`evidence.semantic.${kind}.legal.zh.v1`, "service-legal", LEGAL_ZH_PATH, excerpts.zh, display));
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
  [DEEPSEEK_LEGAL_MANIFEST_ID]: "0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b",
  [MIMO_LEGAL_MANIFEST_ID]: "f075f1e39e74a96ef2b536df8ba1e19c0840ce6d3be47d6deccd9c95da861c3f",
  "contract.neutral-body.2026-08-23.v1": "5cedbfc90aa9bd5899468470c339c21268873afbb6c84dc990dccfa08f976d83",
  "contract.privacy-ai.2026-08-23.v1": "dc98623bf89402f526dbf000a33c81c1d67b4aedec8702a7b517062fbe8e4ec7",
  "contract.acceptance.2026-08-23.v1": "d968e23c43b0bf97b89e3eda4d7f6de195158d7d79f9ce5b53926540eb8aefbe",
  "contract.route-disclosure.2026-08-23.v1": "2ba9e44141422787d89f8345112e70aa8c374ec2cc8a1735d33cf73cb75a0e8d",
  "contract.material-change.2026-08-23.v1": "4c5b1b4f8d93ae372c96d6471139daf8563b1ba2cc60b2341f86930a5bd88769",
  [INITIAL_LEGAL_BUNDLE_VERSION]: "fc26d1e1a016fda055fbe6a0b79b48d804fd7610e03bd5aa29389be37359ca18",
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

export function validateLegalFingerprintV1RegistryEvidenceMapping(evidence: unknown): void {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new LegalFingerprintDescriptorV1Error("registry evidence must be an object");
  }
  const record = evidence as Record<string, unknown>;
  if (typeof record.evidence_id !== "string") {
    throw new LegalFingerprintDescriptorV1Error("registry evidence must have an evidence_id");
  }
  const mapping = REGISTRY_EVIDENCE_SOURCE_MAPPING[
    record.evidence_id as keyof typeof REGISTRY_EVIDENCE_SOURCE_MAPPING
  ];
  if (mapping === undefined) {
    throw new LegalFingerprintDescriptorV1Error("registry evidence_id is not source-authorized");
  }
  if (
    record.authority_kind !== "service-registry" ||
    record.source_locator_kind !== "repo-path" ||
    record.source_locator !== mapping.sourceLocator
  ) {
    throw new LegalFingerprintDescriptorV1Error("registry evidence source authority mismatch");
  }
  if (
    !Array.isArray(record.supported_fact_ids) ||
    record.supported_fact_ids.some((factId) => typeof factId !== "string")
  ) {
    throw new LegalFingerprintDescriptorV1Error("registry evidence fact IDs must be an array of strings");
  }
  const actual = record.supported_fact_ids as string[];
  const actualSet = new Set(actual);
  if (
    actual.length !== mapping.factIds.length ||
    actualSet.size !== actual.length ||
    mapping.factIds.some((factId) => !actualSet.has(factId))
  ) {
    throw new LegalFingerprintDescriptorV1Error("registry evidence fact authority mismatch");
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
    if (item.authority_kind === "service-registry") {
      validateLegalFingerprintV1RegistryEvidenceMapping(item);
    }
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
