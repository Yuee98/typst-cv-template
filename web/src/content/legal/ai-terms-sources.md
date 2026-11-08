# AI disclosure evidence — DeepSeek, MiMo and Google Gemini

> Provider policy evidence: **2026-08-23, Asia/Shanghai**. DeepSeek Responses API, identifier and cache technical facts rechecked **2026-11-07**. Google Gemini Interactions API and applicable data terms checked **2026-11-07**. The 2026-11-08 database restructuring and current MiMo model selection do not claim a new review of those policies.
> Scope: the three official services below only. Compatible adapters and model names do not extend these disclosures to another recipient or endpoint.

This records the official sources and conservative wording behind the bilingual legal seed and Privacy Policy. It is an engineering evidence record.

## 1. Exact service scope and current documents

| Actual service | Adapter | Endpoint | Model |
|---|---|---|---|
| Official DeepSeek Open Platform | 1 — DeepSeek Responses | `https://api.deepseek.com/responses` | `deepseek-flash` |
| Official MiMo API, mainland-China access | 2 — MiMo Responses | `https://api.xiaomimimo.com/v1/responses` | `mimo-v2.6-flash` |
| Google Gemini API through AI Studio | 3 — Gemini Interactions | `https://generativelanguage.googleapis.com/v1/interactions` | `gemini-3.8-flash` |

The canonical seed is `seed.ts`: one TERMS document, one AI_COMMON document and one AI_PROVIDER document for each explicit scope. Each current row contains both languages in restricted Markdown. The database computes a digest over the document scope, effective date, titles and both bodies, and records the complete typed row in its audit table. Enabled state and ordinary row revision do not alter the content digest.

Configurations explicitly reference the matching document. Names or credentials may differ while deliberately sharing the same reviewed scope, but another recipient, endpoint or model never inherits consent solely because its wire format is compatible. Runtime uses `ldoc_` external IDs and exact document-audit references. AI acceptance atomically records the common and selected-provider targets, separately from ordinary Terms of Use. Each request freezes two acceptance-audit references; their document-audit references reconstruct exactly what was accepted. There is no bundle, sealing or publishing lifecycle.

Admin offers matched read-only legal previews. Any authorized document update must preserve a full bilingual audit snapshot and requires renewed acceptance when the applicable content/scope digest changes. Reading a historical document does not authorize a new request under changed current terms.

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
- Region and transfer: the general Privacy Policy's PRC statement expressly excludes products and services provided by downstream users. It does not establish where content submitted by this service through the Open Platform API is processed or stored. API-specific location, region, and transfer path remain unverified; the disclosure makes no PRC API-content claim.
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
- Operator: the reviewed pages did not explicitly identify the exact company operating the mainland-China service, so the disclosure marks it unverified instead of inferring it. The outside-mainland terms name Xiaomi Technologies Singapore Pte. Ltd.
- Region: the Privacy Policy describes global data centers including the Netherlands and Singapore and possible other-party/region transfers. A request's actual region is request/arrangement-dependent and is not guaranteed.
- Retention: the policy states a general necessary-period rule followed by deletion or anonymization; no fixed numeric API-content TTL was found.
- Training/service improvement: MiMo describes the user as Controller and itself as Processor, and states that submitted API content is not used for model training or other purposes.
- Caching: no fixed API cache TTL, cache scope, or opt-out mechanism was verified. The disclosure must not convert automatic-cache pricing behavior into a retention promise.

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
- The service does not intentionally persist CV text, style instructions, or AI output in its request/attempt ledger or logs. It does store content-free configuration, routing-rule, price, exact legal-acceptance, usage, cost, timing, status, and quota metadata.
- Current retention schedule: finalized request/attempt metadata and daily aggregates 90 days, per-minute rate counters 2 days, followed by bounded cleanup runs. Unsettled/HELD requests and their related daily facts are retained for reconciliation rather than automatically erased. Acceptance records are removed with account deletion; immutable configuration and administrative audit history have no automatic expiry.
- Quota is reserved at acceptance. Cancellation after provider transmission remains chargeable; pre-transmission and settlement-classified refundable failures release quota. Retries remain under the same frozen route and never trigger undisclosed cross-provider fallback.
- AI suggestions may be inaccurate, biased, incomplete, or unsuitable. They are never auto-applied and the user remains responsible for final CV content.
- Before a new reserve, a changed configuration/control revision, invalid option or current legal target rejects the submission and refreshes the choice/disclosure; there is no silent provider substitution or automatic resend. A successful reserve freezes its selected option, legal evidence and price, including permitted retries across a time boundary. Later current-row changes do not rewrite that request; emergency disable still prevents a new attempt.

## 6. Privacy and transfer boundary

The Privacy Policy links the actual recipient to the selected-service data-processing disclosure. It does not make one provider's transfer mechanism or region statement apply to the other. Where applicable law requires it and no other suitable safeguard is available, the service may rely on explicit consent for the optional transfer. This describes the operator's chosen flow and is not a universal legal conclusion for every user or jurisdiction.

## 7. Release gates and unresolved facts

1. AI begins disabled. Save matching configurations with prices and time rules, verify credential availability and reviewed legal scope, then explicitly enable access. Provider smoke requires separate authorization and does not verify billing tier or change these legal conclusions.
2. Re-check the relevant official sources when the recipient, endpoint, operator, region, caching, retention or training/service-improvement terms change.
3. Do not enable a configuration whose adapter, endpoint, model or actual recipient differs from its explicit disclosure. Every active rule option must satisfy these constraints; credential presence is not proof of upstream success.
4. The following remain deliberately unknown: DeepSeek's API-specific processing/storage location and transfer path, complete API-content retention/deletion period, and API training opt-out coverage; MiMo's mainland-China operating company, guaranteed per-request region, fixed API-content TTL, and cache TTL/scope/opt-out; Google's deployed project tier/sharing settings, actual request region and complete abuse-monitoring retention period.
5. Obtain qualified legal review before relying on a consent derogation for a broad or high-risk cross-border rollout.
