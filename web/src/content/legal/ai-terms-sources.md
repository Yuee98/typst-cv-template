# AI legal bundle evidence — DeepSeek and MiMo

> Bundle: `2026-08-23-multi-provider-v1`
> Evidence checked: **2026-08-23, Asia/Shanghai**
> Scope: official DeepSeek and official MiMo API routes only. OpenRouter, GPT/Luna, and other gateways are not covered by this bundle.

This file records the official sources and conservative wording decisions behind the bilingual `aiTermsDocument`, Privacy Policy AI sections, and immutable provider manifests. It is an engineering evidence record, not qualified legal advice.

## 1. Immutable manifest mapping

| Manifest ID | Display key | Provider/profile covered | Initial activation state |
|---|---|---|---|
| `deepseek-official-2026-08-23-v1` | `deepseek-official-v1` | Official DeepSeek `deepseek-v4-flash` Chat Completions profile | Existing route / eligible subject to deployment gates |
| `mimo-cn-2026-08-23-v1` | `mimo-cn-v1` | Official MiMo `mimo-v2.5-pro` Responses profile for the mainland-China configuration | Disclosed but may remain inactive until technical and authority gates pass |

The neutral body and both annexes form one legal bundle. Listing a manifest does not activate its profile. Database routing may reference only an exact deployed bundle and manifest; it cannot create or rewrite legal copy. A new recipient, gateway, upstream, or material policy change requires a new reviewed manifest and normally a new legal-bundle version with renewed acceptance.

## 2. DeepSeek official sources

| Source | URL | Checked fact used |
|---|---|---|
| Pricing and model list | https://api-docs.deepseek.com/quick_start/pricing/ | Official model/pricing identity; mutable commercial data is not reproduced as a legal guarantee. |
| Create Chat Completion | https://api-docs.deepseek.com/api/create-chat-completion/ | Chat API and pseudonymous `user_id`; the identifier is documented for content-safety, cache-isolation, and scheduling-isolation purposes. |
| Context caching | https://api-docs.deepseek.com/guides/kv_cache/ | Disk context caching is enabled by default; an unused cache is usually cleared within hours to days. |
| Open Platform Terms | https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html | Released 2026-04-22, effective 2026-04-29; downstream disclosure/controller responsibilities and AI-output risk. |
| Chinese Privacy Policy | https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html | Current policy effective 2026-02-10; PRC processing/storage and possible improvement/training use. |
| English Privacy Policy | https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html | English-language cross-check of the current policy and scope. |

### DeepSeek wording decisions

- Submitted data: selected CV text, selected context, style instructions, and an HMAC-SHA256 pseudonymous `user_id`; no email, username, or raw account ID.
- Operator: Hangzhou DeepSeek Artificial Intelligence Co., Ltd.; official endpoint `api.deepseek.com`.
- Region: policies support PRC processing/storage, but no separate promise identifies the exact facility or region for API content.
- Retention: the documented disk-cache behavior is disclosed. There is no fixed overall API-content retention period or zero-retention commitment.
- Training/service improvement: policies permit improvement/training use in applicable circumstances. There is no API no-training promise, and coverage of a consumer opt-out for API requests was not verified.
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

## 4. Neutral service-operator rules

- Before transmission, the user sees the actual server-selected route as read-only disclosure. Consent is not a provider selector.
- The service operator chose a separate acceptance flow for this optional feature. The terms do not claim that every provider generically requires separate consent.
- Selected CV content is plaintext to this service's server and the disclosed AI recipient even when cloud-save content is end-to-end encrypted at rest.
- The service does not intentionally persist CV text, style instructions, or AI output in its request/attempt ledger or logs. It does store content-free routing, profile, price, legal-bundle, usage, cost, timing, status, and quota metadata.
- Current retention schedule: request/attempt metadata 90 days, per-minute rate counters 2 days, daily usage aggregates 90 days, followed by the next daily cleanup run; acceptance records remain until account deletion unless a longer legal/security obligation applies.
- Quota is reserved at acceptance. Cancellation after provider transmission remains chargeable; pre-transmission and settlement-classified refundable failures release quota. Retries remain under the same frozen route and never trigger undisclosed cross-provider fallback.
- AI suggestions may be inaccurate, biased, incomplete, or unsuitable. They are never auto-applied and the user remains responsible for final CV content.
- If route, recipient, upstream, or legal bundle changes before transmission, the request must stop and require refreshed disclosure/confirmation.

## 5. Privacy and transfer boundary

The Privacy Policy links the actual recipient to the route-specific provider annex. It does not make one provider's transfer mechanism or region statement apply to the other. Where applicable law requires it and no other suitable safeguard is available, the service may rely on explicit consent for the optional transfer. This describes the operator's chosen flow and is not a universal legal conclusion for every user or jurisdiction.

## 6. Release gates and unresolved facts

1. MiMo remains inactive until its adapter, pricing/usage interpretation, exact legal-bundle gate, live smoke, and activation authority all pass.
2. Re-check every official source when a provider changes policy, endpoint, operator, region, caching, retention, or training/service-improvement terms.
3. Do not activate a profile whose manifest ID or exact legal-bundle version is absent from deployed code and the authoritative database snapshot.
4. The following remain deliberately unknown: DeepSeek's complete API-content retention/deletion period and API training opt-out coverage; MiMo's mainland-China operating company, guaranteed per-request region, fixed API-content TTL, and cache TTL/scope/opt-out.
5. Obtain qualified legal review before relying on a consent derogation for a broad or high-risk cross-border rollout.
