# AI legal bundle evidence — DeepSeek, MiMo and Google Gemini

> Current bundle code: `CV_APP_GEMINI_20261107`; `CURRENT_20261107` and `CV_APP_RESPONSES_20261107` remain sealed historical content. Runtime acceptance uses database-generated `lgb_`/`lds_` IDs and exact digests.
> Provider policy evidence: **2026-08-23, Asia/Shanghai**. DeepSeek Responses API, identifier and cache technical facts rechecked **2026-11-07**; the source templates distinguish that delta from retained policy evidence. Google Gemini Interactions API and applicable data terms checked **2026-11-07**. This is not a new review of all DeepSeek or MiMo policy sources.
> Scope: official DeepSeek, official MiMo and Google Gemini Developer API through AI Studio routes only. OpenRouter, GPT/Luna, and other gateways are not covered by this bundle.

This file records the official sources and conservative wording decisions behind the bilingual `aiTermsDocument`, Privacy Policy AI sections, and immutable provider manifests. It is an engineering evidence record, not qualified legal advice.

## 1. Immutable manifest mapping

| Source manifest ID | Source display key | Provider/profile covered | Baseline activation state |
|---|---|---|---|
| `deepseek-official-responses-2026-11-07-v1` | `deepseek-official-responses-v1` | Official DeepSeek `deepseek-flash` Responses profile; technical review 2026-11-07, policy evidence retained from 2026-08-23 | Disabled; a new matching execution profile and policy must be configured |
| `mimo-cn-2026-08-23-v1` | `mimo-cn-v1` | Official MiMo `mimo-v2.5-pro` Responses profile for the mainland-China configuration | Disabled; no execution profile or active policy is seeded |
| `google-ai-studio-interactions-2026-11-07-v1` | `google-ai-studio-interactions-v1` | Official Google AI Studio `gemini-3.8-flash`, native stable Interactions API | Disabled; actual project tier and data-sharing settings require separate owner verification |

These source IDs identify the stated review scope; they are not a runtime code allowlist or acceptance target. The database catalogue creates a sealed bundle containing common AI terms and one exact disclosure per provider/model. Each disclosure digest includes the common AI document and bundle manifest digests. A user accepts only the complete selected-provider disclosure; accepting DeepSeek does not accept MiMo. Listing a disclosure does not activate its profile.

The preceding Responses change created a new bundle and DeepSeek disclosure (`DEEPSEEK_RESPONSES_DEEPSEEK_FLASH_20261107`), reusing the generic AI document and copying the reviewed MiMo disclosure unchanged. The new manifest/bundle binding produces new disclosure identities and digests, including copied content; old acceptances do not authorize the new exact targets. Old sealed rows are never edited. Publishing current closes AI, clears the policy pointer and invalidates old reopen evidence before new profiles/policy are published.

Adding Google creates a new common AI document and `CV_APP_GEMINI_20261107` bundle. Copies of the DeepSeek/MiMo disclosures change only the shared provider enumeration and identifier list; their provider-specific facts and the old sealed bytes are preserved. Google has its own complete reviewed disclosure. The new bundle/content digests require exact acceptance again.

Owner-controlled publication creates and seals legal content; ordinary Admin configuration cannot rewrite it. Profiles reference the matching database disclosure, and policy publication checks the current bundle. A new recipient, gateway, upstream, or material policy change requires reviewed content, a new sealed bundle/disclosure identity and renewed acceptance where applicable. Code validates supported execution semantics and transport safety rather than a historical manifest-ID list.

## 2. DeepSeek official sources

| Source | URL | Checked fact used |
|---|---|---|
| Pricing and model list | https://api-docs.deepseek.com/quick_start/pricing/ | Official model/pricing identity; mutable commercial data is not reproduced as a legal guarantee. |
| Responses API | https://api-docs.deepseek.com/api/create-response/ | Technical review 2026-11-07: `https://api.deepseek.com/responses`, `deepseek-flash`, and the pseudonymous `user` field; the API describes response/conversation state as stateless. |
| Responses guide | https://api-docs.deepseek.com/guides/responses_api/ | `store` is unsupported and ignored; responses carry `store:false`. Context caching remains automatic; this is not a zero-retention, region or no-training commitment. |
| Rate Limit & Isolation | https://api-docs.deepseek.com/quick_start/rate_limit/ | Technical identifier/isolation reference linked by the Responses API; no raw account ID or personal contact information is sent as the identifier. |
| Context caching | https://api-docs.deepseek.com/guides/kv_cache/ | Disk context caching is enabled by default; an unused cache is usually cleared within hours to days. |
| Open Platform Terms | https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html | Released 2026-04-22, effective 2026-04-29; API agreement/operator identity, downstream disclosure/controller responsibilities, consent and AI-output risk, and the §5.5 downstream-product scope exclusion. Section 4.2 describes what the developer may do with inputs/outputs; it is not evidence that DeepSeek uses them for training or improvement. |
| Terms of Use | https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html | Last updated 2026-03-27; defines Services to include APIs and describes limited use of de-identified data to improve the Services. It does not establish an API-specific no-training commitment or opt-out. |
| Chinese Privacy Policy | https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html | Last updated 2026-02-10; the general PRC processing/storage statement and its express exclusion of products and services provided by downstream users. This source does not establish a location for this service's Open Platform API content. |
| English Privacy Policy | https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html | Last updated 2026-02-10; English-language cross-check of the same general statement and downstream-user exclusion. This source does not establish an API-content location. |

### DeepSeek wording decisions

- Submitted data: selected CV text, selected context, style instructions, and an HMAC-SHA256 pseudonymous identifier in the Responses `user` field; no email, username, or raw account ID.
- Operator: Hangzhou DeepSeek Artificial Intelligence Co., Ltd.; official Responses endpoint `https://api.deepseek.com/responses`. The transport sends no `store` parameter, because that parameter is unsupported.
- Region and transfer: the general Privacy Policy's PRC statement expressly excludes products and services provided by downstream users. It does not establish where content submitted by this service through the Open Platform API is processed or stored. API-specific location, region, and transfer path remain unverified; the annex makes no PRC API-content claim.
- Retention: stateless response/conversation behavior is a narrow API fact. The documented disk cache remains enabled by default, with unused entries usually removed within hours to days. Neither a response carrying `store:false` nor omitting the unsupported request parameter establishes zero retention of caches or safety logs, a fixed overall API-content deletion period, a processing region, or a no-training promise.
- Training/service improvement: the separate Terms of Use applies to Services including APIs and describes limited de-identified improvement use. The Open Platform Terms' model-training clause is developer permission, not provider-use authority. There is no API-specific no-training promise or verified opt-out, and no provider-training claim is inferred from the Open Platform Terms or the excluded downstream scope of the general Privacy Policy.
- User warning: treat submitted content as potentially retained or used for service improvement; do not submit sensitive or confidential data; review all output.

## 3. MiMo official sources

| Source | URL | Source date / checked fact used |
|---|---|---|
| Responses API | https://mimo.mi.com/docs/en-US/api/chat/responses | Updated 2026-07-17; official Responses endpoint and request/response shape. |
| Pay-as-you-go pricing | https://mimo.mi.com/docs/en-US/price/pay-as-you-go | Updated 2026-08-06; official model/pricing identity. Mutable commercial data is not reproduced as a legal guarantee. |
| Rate limits | https://mimo.mi.com/docs/en-US/api/guidance/rate-limit | Official rate-limit behavior. |
| Error codes | https://mimo.mi.com/docs/en-US/api/guidance/error-codes | Official error taxonomy. |
| Service Agreement | https://mimo.mi.com/docs/quick-start/terms/user-agreement | Updated 2026-07-07; mainland-China access is governed by in-PRC terms; service outside mainland China identifies Xiaomi Technologies Singapore Pte. Ltd. |
| Privacy Policy | https://mimo.mi.com/docs/en-US/terms/privacy-policy | Policy version 20260421, page updated 2026-03-17; Controller/Processor roles, submitted-content use, retention, global data centers, and transfers. |

### MiMo wording decisions

- Submitted data: selected CV text, selected context, and style instructions. The initial adapter sends no HMAC provider subject ID, email, username, or raw account ID.
- Operator: the reviewed pages did not explicitly identify the exact company operating the mainland-China service, so the annex marks it unverified instead of inferring it. The outside-mainland terms name Xiaomi Technologies Singapore Pte. Ltd.
- Region: the Privacy Policy describes global data centers including the Netherlands and Singapore and possible other-party/region transfers. A request's actual region is request/arrangement-dependent and is not guaranteed.
- Retention: the policy states a general necessary-period rule followed by deletion or anonymization; no fixed numeric API-content TTL was found.
- Training/service improvement: MiMo describes the user as Controller and itself as Processor, and states that submitted API content is not used for model training or other purposes.
- Caching: no fixed API cache TTL, cache scope, or opt-out mechanism was verified. The annex must not convert automatic-cache pricing behavior into a retention promise.

## 4. Google Gemini API through AI Studio

The official model page and stable [Interactions create reference](https://aistudio.google.com/api-reference/interactions-api/create-interaction?api-version=v1) cover `gemini-3.8-flash` at `https://generativelanguage.googleapis.com/v1/interactions`. The implementation is native Interactions, with low thinking, structured JSON and explicit `store:false`; it sends no provider subject ID and enables no tools, grounding, files, background execution or continued conversation. The product disclosure describes data-handling effects rather than wire parameters.

| Source | Checked boundary |
|---|---|
| [Gemini API terms](https://ai.google.dev/gemini-api/terms) | Unpaid content may support improvement/training and human review; personal/sensitive/confidential information should not be submitted. Paid API treatment depends on an active Cloud Billing project, with a developer-location exception for the EEA/Switzerland/UK. Paid prompts/responses are not used for product improvement, but limited abuse monitoring and legal disclosures remain. No fixed processing region is promised. |
| [Zero data retention guide](https://ai.google.dev/gemini-api/docs/zdr) | Interaction storage opt-out is separate from abuse monitoring, caches and other feature-specific storage. Implicit RAM caching is described as project-isolated with a 24-hour TTL; this does not establish an overall deletion deadline. |
| [Logging and sharing](https://ai.google.dev/gemini-api/docs/logs-policy) | Project-owned logs differ from abuse-monitoring records. Voluntary datasets/feedback can be used for improvement and human review; retained datasets have separate rules. This app does not enable donations or feedback sharing. |
| [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) | Model identity and supported thinking/structured-output capabilities; not proof of project billing tier, data-use settings or residency. |

The key/model name and a successful synthetic request cannot attest to Paid-tier treatment or ZDR. Before real CV use, the owner separately verifies active Cloud Billing and data-sharing/dataset settings. The disclosure keeps the free/paid distinction visible and makes no no-training or zero-retention claim without its conditions. Google-specific policy facts were reviewed on 2026-11-07; DeepSeek/MiMo retain their earlier review scope.

## 5. Neutral service-operator rules

- The database defines the current time period's candidate set and default. The user explicitly chooses the request option and sees its matching provider/model disclosure. Selection and exact acceptance are separate actions; changing an option updates the disclosure and accepted state. No unselected provider needs to be accepted.
- The service operator chose a separate acceptance flow for this optional feature. The terms do not claim that every provider generically requires separate consent.
- Selected CV content is plaintext to this service's server and the disclosed AI recipient even when cloud-save content is end-to-end encrypted at rest.
- The service does not intentionally persist CV text, style instructions, or AI output in its request/attempt ledger or logs. It does store content-free routing, profile, price, legal-bundle, usage, cost, timing, status, and quota metadata.
- Current retention schedule: finalized request/attempt metadata and daily aggregates 90 days, per-minute rate counters 2 days, followed by bounded cleanup runs. Unsettled/HELD requests and their related daily facts are retained for reconciliation rather than automatically erased. Acceptance records are removed with account deletion; immutable configuration and administrative audit history have no automatic expiry.
- Quota is reserved at acceptance. Cancellation after provider transmission remains chargeable; pre-transmission and settlement-classified refundable failures release quota. Retries remain under the same frozen route and never trigger undisclosed cross-provider fallback.
- AI suggestions may be inaccurate, biased, incomplete, or unsuitable. They are never auto-applied and the user remains responsible for final CV content.
- Before a new reserve, a changed policy/generation, invalid option or current legal target rejects the submission and refreshes the choice/disclosure; there is no silent provider substitution or automatic resend. A successful reserve freezes its selected option, legal evidence and price, including permitted retries across a time boundary. Later current-pointer changes do not rewrite that request; emergency disable still prevents a new attempt.

## 6. Privacy and transfer boundary

The Privacy Policy links the actual recipient to the route-specific provider annex. It does not make one provider's transfer mechanism or region statement apply to the other. Where applicable law requires it and no other suitable safeguard is available, the service may rely on explicit consent for the optional transfer. This describes the operator's chosen flow and is not a universal legal conclusion for every user or jurisdiction.

## 7. Release gates and unresolved facts

1. All supported providers begin disabled with no active policy. Configure and validate supported profile/price/policy versions, bind the exact current disclosure, and obtain current readback before an administrator opens the allowlist. Upstream smoke is a separately authorized operation, with its execution evidence recorded independently; a successful request does not change these legal-source conclusions.
2. Re-check every official source when a provider changes policy, endpoint, operator, region, caching, retention, or training/service-improvement terms.
3. Do not activate a profile whose provider/model/recipient facts differ from its exact disclosure, whose bundle is unsealed or not current, or whose execution semantics are unsupported by the deployed code. Validation covers future periods and nondefault options; credential presence alone is not proof of upstream success.
4. The following remain deliberately unknown: DeepSeek's API-specific processing/storage location and transfer path, complete API-content retention/deletion period, and API training opt-out coverage; MiMo's mainland-China operating company, guaranteed per-request region, fixed API-content TTL, and cache TTL/scope/opt-out; Google's deployed project tier/sharing settings, actual request region and complete abuse-monitoring retention period.
5. Obtain qualified legal review before relying on a consent derogation for a broad or high-risk cross-border rollout.
