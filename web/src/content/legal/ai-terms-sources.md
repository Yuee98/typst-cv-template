# AI terms — DeepSeek compliance findings and wording decisions (unit 4.2 draft)

> Verification date: **2026-08-03** (all URLs fetched on this date; page-internal
> "last update / effective" dates quoted per document).
> Purpose: evidence base for the final wording of `aiTermsDocument`
> (`zh.ts` / `en.ts` in this directory) and the privacy-policy pointer.
> Reviewed by the unit 4.2 **final** review before `AI_TERMS_VERSION` is bumped.
> Rule followed throughout: where a fact could not be verified from a primary
> source, the terms use the conservative formulation (roadmap: no
> "zero-retention" / "no-training" promises without basis).

## 1. Primary sources

| # | Document | URL | Document date | Key clauses used |
|---|----------|-----|---------------|-------------------|
| S1 | DeepSeek Open Platform Terms of Service | https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html | Released 2026-04-22, effective 2026-04-29 | §1.1 Input/Output definition; §3.3 developer must disclose PI-processing rules to end users and obtain consent for delegating PI processing to DeepSeek; §4.1–4.2 Inputs/Outputs rights; §5.5 end-user PI of downstream apps **not** covered by DeepSeek Privacy Policy — developer is the controller; §7.2 suspension rights, records retained for violations; §8.1 developer must tell end users output is AI-generated and may contain errors; §10 governing law PRC mainland, Hangzhou jurisdiction |
| S2 | DeepSeek Terms of Use | https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html | Last update 2026-03-27 | §1.1 "Services" include APIs; §4.3 "we may, to a minimal extent, use Inputs and Outputs to provide, maintain, operate, develop or improve the Services or the underlying technologies" under "secure encryption … strict de-identification … irreversibility", opt-out via "Improve the model for everyone" toggle; §2.5 data may be retained after account deletion as required by law; §3.3 risk-filtering/content review mechanisms |
| S3 | DeepSeek Privacy Policy | https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html | Last update 2026-02-10 | Collects "User Input" (prompts, files, chat history); uses Personal Data "to improve and develop the Services and to train and improve our technology, such as our machine learning models and algorithms"; retention "for as long as necessary to provide our Services and for the other purposes set out in this Privacy Policy", account-linked data (incl. input) kept "as long as you have an account"; storage "in People's Republic of China"; right "to opt-out of using your Personal Data for training our models or optimizing our technologies"; intro disclaimer: end-user data collected via developer-built downstream applications is **not** covered by this policy |
| S4 | Model Mechanism and Training Methods of DeepSeek | https://cdn.deepseek.com/policies/en-US/model-algorithm-disclosure.html | Undated (linked from S2/S3) | Optimization-training data "produced by our research team, with a small portion potentially based on user input"; if user input is used, "secure encryption, strict de-identification, and anonymization" are applied; users have an opt-out right (via privacy policy) |
| S5 | DeepSeek API docs — Context Caching on Disk | https://api-docs.deepseek.com/guides/kv_cache | Live docs, fetched 2026-08-03 | Cache "enabled by default for all users"; "Each user request will trigger the construction of a hard disk cache" (request prefixes persisted to disk); "Once the cache is no longer in use, it will be automatically cleared, usually within a few hours to a few days"; no documented opt-out |
| S6 | DeepSeek API docs — Create chat completion (`user_id` parameter) | https://api-docs.deepseek.com/api/create-chat-completion | Live docs, fetched 2026-08-03 | `user_id` nullable; charset `[a-zA-Z0-9\-_]`, max length 512; "Do not include user privacy information in the user_id"; purposes: "distinguish user identities on your side to help us with content safety review", "KVCache isolation for privacy management", "scheduling isolation of users on your business side" |
| S7 | DeepSeek API docs — Rate Limit & Isolation | https://api-docs.deepseek.com/quick_start/rate_limit | Live docs, fetched 2026-08-03 | `user_id` enables content-safety isolation, KVCache isolation, scheduling isolation; per-`user_id` concurrency caps for accounts with raised quotas |

No secondary/aggregated source is cited as the sole basis for any claim
above; every row was fetched directly from `deepseek.com` /
`api-docs.deepseek.com` on the verification date.

## 2. Verified conclusions (conservative)

### 2.1 Data retention at DeepSeek

- **No zero-retention commitment exists for the API.** Nothing in S1/S2/S3
  states that API inputs/outputs are not retained.
- **Documented transient retention:** context caching is on by default and
  persists request prefixes to disk; cleared "usually within a few hours to a
  few days" (S5). There is no documented way to disable it.
- **Open-ended retention otherwise:** the privacy policy retains data "for as
  long as necessary to provide our Services and for the other purposes set out
  in this Privacy Policy", and account-linked input data "for as long as you
  have an account" (S3). Violation-related records may be retained (S1 §7.2,
  S2 §2.5).
- **Storage location:** People's Republic of China (S3).
- ⇒ Terms wording: DeepSeek "retains request content at least temporarily
  (context cache, cleared within hours to days per its documentation) and its
  policies do not commit to any fixed deletion timeline; data is stored in
  China." **No "zero retention" claim.**

### 2.2 Training / model-improvement use

- The Terms of Use (which cover the API, S2 §1.1) state DeepSeek "may, to a
  minimal extent, use Inputs and Outputs to … develop or improve the Services"
  under de-identification, with an opt-out toggle "Improve the model for
  everyone" (S2 §4.3). The toggle is a consumer-app setting; **its coverage of
  API traffic is not documented anywhere** (S1 is silent on training use).
- The model-training disclosure says optimization data is "potentially based
  on user input" in "a small portion", de-identified, with an opt-out right
  (S4); the privacy policy lists a training opt-out right (S3).
- **No "we do not train on API data" commitment exists** (unlike e.g.
  OpenAI/Anthropic API terms).
- ⇒ Terms wording: "DeepSeek's terms allow it to use inputs/outputs to improve
  its services under de-identification, and we could not verify that an
  opt-out applies to API requests; treat content sent as potentially retained
  and used for service improvement." **No "not used for training" claim.**

### 2.3 Formal DPA

- **No separate DPA / data processing addendum was found.** The applicable
  agreement for API use is the Open Platform Terms of Service (S1), a
  "Specific Agreement" to the Terms of Use. S1 §3.3/§5.5 put the end-user
  disclosure and consent burden on us as the downstream developer/controller.
- ⇒ Terms wording: we (cv maker) are responsible for disclosing the forwarding
  and obtaining consent — hence the separate AI terms and the explicit
  checkbox; the privacy policy points to the AI terms.

### 2.4 `user` / `user_id` parameter (pseudonymous ID)

- The V4 API parameter is **`user_id`** (S6/S7): custom string, charset
  `[a-zA-Z0-9\-_]`, max 512, "Do not include user privacy information in the
  user_id". Documented purposes: content-safety review, KVCache isolation for
  privacy management, scheduling/rate-limit isolation.
- Our design (roadmap): `user_id = HMAC_SHA256(AI_USER_ID_HMAC_SECRET,
  supabaseUserId)` hex (64 chars, within charset/length) — no email, username,
  or raw account ID is sent.
- **Deviation found (not fixed in this unit — server code untouched):**
  `web/src/server/polish/deepseek.ts` currently serializes the field as
  `user`, not `user_id` (the roadmap pinned `user_id`). DeepSeek may silently
  ignore the unknown field, so the documented KVCache/scheduling isolation may
  not actually apply until fixed. → Follow-up for unit 4.2 final review (or a
  server fix unit): rename the field to `user_id`. The terms wording describes
  only what leaves our server (a pseudonymous hash, never the raw ID), which is
  true regardless of the field name.

## 3. Wording decision map

| # | Terms passage (zh.ts / en.ts section) | Basis |
|---|----------------------------------------|-------|
| D1 | Intro: AI terms are supplementary to Terms of Use + Privacy Policy; separate checkbox consent recorded (user ID, version, timestamp) before first use | S1 §3.3 (developer must obtain end-user consent for delegating PI processing); migration `20260802120000_add_ai_terms_acceptance.sql` |
| D2 | "AI 润色功能": request content is forwarded **in plaintext** through our server to DeepSeek | `web/src/server/polish/deepseek.ts` (HTTPS POST of `messages` to `api.deepseek.com/chat/completions`); E2EE section unchanged |
| D3 | "发送的内容": level 0 = selected texts only (+ style options); level 1 = + scope metadata (company/org, project title/detail, education org/title/detail, research title/date, skill category) + sibling items in the same entry/section; level 2 = + profile summary bodies + skill labels; header name/email/phone never read; per-request disclosure shows the exact payload | `web/src/components/cv-builder/polish/scope-builder.ts` (`assembleReferences`, level roles), `web/src/server/polish/prompt.ts` (`trimReferencesForLevel`), UI labels `PolishDialog.level.*` in messages |
| D4 | Pseudonymous identifier: we send an HMAC-SHA256 hash of the account ID, never email/username/raw UUID; DeepSeek documents `user_id` as used for content-safety review, cache isolation and scheduling isolation | S6, S7; `web/src/server/polish/deepseek.ts` (providerUserId HMAC); deviation in §2.4 flagged |
| D5 | "第三方 AI 服务": DeepSeek retains content at least temporarily (disk cache, hours–days); no fixed deletion timeline committed; storage in China; its terms allow de-identified use of inputs/outputs for service improvement; API opt-out unverified → do not send anything sensitive | S2 §4.3, S3 (retention/storage), S4, S5; conservative fallback per roadmap |
| D6 | "我们存储的内容": no CV text/AI output/style instructions stored server-side; metadata ledger fields listed; finalized ledger 90 days, per-minute counters 2 days, daily aggregates 90 days; daily scheduled cleanup; terms acceptance kept until account deletion | migration `20260802130000_add_ai_quota_ledger.sql` (tables, `cleanup_ai_polish_metadata`, cron `ai-polish-retention-cleanup` 03:15 UTC); `web/src/server/polish/lifecycle.ts` (`PolishLogEvent` — no content fields by construction) |
| D7 | "配额与取消": 20 requests/day per user, 3 requests/minute, global daily capacity limit; reset at UTC midnight; a request canceled after it reached the AI provider still consumes quota; failed requests are refunded | `reserve_ai_polish_request` constants (20/day, 3/min), `ai_feature_config.global_daily_limit`, settlement table in `lifecycle.ts` (8b: canceled after provider start → `quotaCharged: true`; 8c: failure → refunded) |
| D8 | "AI 输出需要你审阅": output is AI-generated, may contain errors, for reference only; human review required before use | S1 §8.1 (developer must disclose exactly this); existing UI flow (accept/reject per item) |
| D9 | Privacy policy pointer: new short section "AI 功能" stating that using AI polish sends selected content to a third-party AI provider under the AI Service Terms | S1 §3.3/§5.5 (developer is the controller and must disclose); minimal-change linkage |

## 4. Open items for the 4.2 final review (not in this draft unit)

1. Bump `AI_TERMS_VERSION` (`constants.ts`) + matching migration version
   function after wording is finalized.
2. Confirm the pg_cron retention job (`ai-polish-retention-cleanup`) actually
   runs on hosted Supabase (migration schedules it only when pg_cron is
   enabled; otherwise manual scheduling per migration comments).
3. Fix or bless the `user` → `user_id` field-name deviation (§2.4).
4. Re-verify DeepSeek policy pages after any upstream update (dates quoted
   above are as of 2026-08-03).
5. Re-check wording against unit 4.1 smoke/monitoring outcomes once available.
