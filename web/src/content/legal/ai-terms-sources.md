# AI terms — DeepSeek compliance findings and wording decisions (final)

> Final verification date: **2026-08-04** (all 7 URLs re-fetched on this date by
> the unit 4.2 final review; page-internal "last update / effective" dates
> quoted per document). This is the final evidence record for the shipped
> wording of `aiTermsDocument` (`zh.ts` / `en.ts` in this directory) and the
> privacy-policy linkage, superseding the 2026-08-03 draft.
> Rule followed throughout: where a fact could not be verified from a primary
> source, the terms use the conservative formulation — no "zero-retention" /
> "no-training" promises, and no storage-location or retention claims beyond
> what the cited sources establish for downstream end-user data.

## 1. Primary sources

| # | Document | URL | Document date (as of 2026-08-04) | Key clauses used |
|---|----------|-----|----------------------------------|-------------------|
| S1 | DeepSeek Open Platform Terms of Service | https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html | Released 2026-04-22, effective 2026-04-29 | §1.1 Input/Output definition; §3.3 developer must disclose its personal-information processing rules to end users and obtain consent **or have another legal basis** for delegating PI processing to DeepSeek; §4.1–4.2 Inputs/Outputs rights; §5.5 end-user PI of downstream apps **not** covered by DeepSeek Privacy Policy — developer is the controller; §7.2 suspension rights, records retained for violations; §8.1 developer must tell end users output is AI-generated and may contain errors; §10 governing law PRC mainland, jurisdiction at DeepSeek's registered office (Hangzhou) |
| S2 | DeepSeek Terms of Use | https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html | Last update 2026-03-27 | §1.1 "Services" include APIs; §4.3 "we may, to a minimal extent, use Inputs and Outputs to provide, maintain, operate, develop or improve the Services or the underlying technologies" under "secure encryption … strict de-identification … irreversibility", opt-out via "Improve the model for everyone" toggle; §2.5 data may be retained after account deletion as required by law; §3.3 risk-filtering/content review mechanisms |
| S3 | DeepSeek Privacy Policy | https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html | Last update 2026-02-10 | Collects "User Input" (prompts, files, chat history); uses Personal Data "to improve and develop the Services and to train and improve our technology, such as our machine learning models and algorithms"; retention "for as long as necessary …", account-linked data (incl. input) kept "as long as you have an account"; storage "in People's Republic of China"; right "to opt-out of using your Personal Data for training our models or optimizing our technologies". **Scope limit (intro):** "the processing rules for Personal Data collected from end users when accessing downstream systems or applications developed by developers using our open platform services are **not covered** by this privacy policy" — so its storage-location and retention statements do not establish anything about our users' content sent via the API |
| S4 | Model Mechanism and Training Methods of DeepSeek | https://cdn.deepseek.com/policies/en-US/model-algorithm-disclosure.html | Undated (linked from S2/S3) | Optimization-training data "produced by our research team, with a small portion potentially based on user input"; if user input is used, "secure encryption, strict de-identification, and anonymization" are applied; users have an opt-out right (via privacy policy) |
| S5 | DeepSeek API docs — Context Caching on Disk | https://api-docs.deepseek.com/guides/kv_cache | Live docs, fetched 2026-08-04 | Cache "enabled by default for all users"; "Each user request will trigger the construction of a hard disk cache" (request prefixes persisted to disk); "Once the cache is no longer in use, it will be automatically cleared, usually within a few hours to a few days"; no documented opt-out. (Page additionally documents "cache prefix unit" persistence/hit rules under sliding-window attention — mechanics detail; the default-on, disk-persistence and hours-to-days clearing statements are unchanged since 2026-08-03.) |
| S6 | DeepSeek API docs — Create chat completion (`user_id` parameter) | https://api-docs.deepseek.com/api/create-chat-completion | Live docs, fetched 2026-08-04 | `user_id` nullable; charset `[a-zA-Z0-9\-_]`, max length 512; "Do not include user privacy information in the user_id"; purposes: "distinguish user identities on your side to help us with content safety review", "KVCache isolation for privacy management", "scheduling isolation of users on your business side" |
| S7 | DeepSeek API docs — Rate Limit & Isolation | https://api-docs.deepseek.com/quick_start/rate_limit | Live docs, fetched 2026-08-04 | `user_id` enables content-safety isolation, KVCache isolation, scheduling isolation; per-`user_id` concurrency caps for accounts with raised quotas |

No secondary/aggregated source is cited as the sole basis for any claim
above; every row was fetched directly from `deepseek.com` /
`api-docs.deepseek.com` on 2026-08-04 and found **consistent** with the
2026-08-03 draft review (no document date or clause text changed between the
two fetches). A separate search for a DeepSeek DPA / data processing addendum
found none (see §2.3).

## 2. Verified conclusions (conservative)

### 2.1 Data retention and storage at DeepSeek

- **No zero-retention commitment exists for the API.** Nothing in S1/S2/S3
  states that API inputs/outputs are not retained.
- **Documented transient retention:** context caching is on by default and
  persists request prefixes to disk; cleared "usually within a few hours to a
  few days" (S5). There is no documented way to disable it.
- **No API-specific commitment covering other retention or deletion was
  identified.** The general Privacy Policy's retention statements
  ("as long as necessary", account-linked data kept "as long as you have an
  account", S3) apply to data DeepSeek processes as controller under that
  policy; S3's introduction expressly excludes personal data collected from
  end users of downstream applications, and S1 §5.5 puts the controller role
  on us for that data.
- **Storage location: unverified for our users' content.** S3 states data it
  governs is stored "in People's Republic of China", but per the same scope
  exclusion that statement does not cover downstream end-user data; no
  API-specific storage-location statement exists in S1/S5/S6/S7.
- ⇒ Terms wording (final): the disk-cache default and hours-to-days clearing
  are stated with attribution to the API documentation; the PRC storage
  statement is reported **with its scope limit**, and the terms say we
  **could not verify** an API-specific storage location. **No "zero
  retention" claim, no unqualified "stored in China" claim.**

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
- ⇒ Terms wording (final, unchanged from draft): "its Terms of Use allow it to
  use inputs and outputs to improve its services under strict
  de-identification, and we could not verify whether its consumer-facing
  opt-out of model training applies to API requests"; users are told to treat
  sent content as potentially retained and used for service improvement.
  **No "not used for training" claim.**

### 2.3 Formal DPA and GDPR transfer basis

- **No separate DPA / data processing addendum was found** (checked again
  2026-08-04: no such document in DeepSeek's official policy directory, and no
  evidence of one in independent compliance analyses). The applicable
  agreement for API use is the Open Platform Terms of Service (S1), a
  "Specific Agreement" to the Terms of Use. S1 §3.3/§5.5 put the end-user
  disclosure and consent-or-other-lawful-basis burden on us as the downstream
  developer/controller.
- ⇒ Consent wording (final): "Our AI provider's terms require us, as the
  downstream developer, to disclose our processing rules to you and, where
  applicable law requires, to obtain your consent or have another lawful
  basis" — matching S1 §3.3's actual text (the draft's "requires us … to
  obtain your consent" overstated it).
- ⇒ GDPR transfer mechanism (final, recorded per CP4 round-1 P0-4): with no
  adequacy decision, DPA, or other safeguard available from DeepSeek, the
  transfer of user-selected content relies on the user's **explicit consent as
  a derogation**; the consent flow discloses the transfer risks (retention,
  improvement use, unverified location) before acceptance, and consent can be
  withdrawn at any time by ceasing to use the feature. This is now stated in
  both the privacy policy ("AI Features" + a pointer in "International
  Transfers") and the AI terms ("Third-Party AI Provider"). This documents the
  mechanism; it is **not a legal sign-off** — qualified legal sign-off on this
  basis remains an external release gate (unit 4.3b user gate, §6).

### 2.4 `user_id` parameter (pseudonymous ID) — actual state

- The V4 API parameter is **`user_id`** (S6/S7): custom string, charset
  `[a-zA-Z0-9\-_]`, max 512, "Do not include user privacy information in the
  user_id". Documented purposes: content-safety review, KVCache isolation for
  privacy management, scheduling/rate-limit isolation.
- Our implementation: `user_id = HMAC_SHA256(AI_USER_ID_HMAC_SECRET,
  supabaseUserId)` hex (64 chars, within charset/length) — no email, username,
  or raw account ID is sent.
- **Draft deviation resolved:** the 2026-08-03 draft recorded that
  `web/src/server/polish/deepseek.ts` serialized the field as `user`. This was
  fixed before CP4: the provider now sends `user_id: request.providerUserId`
  (`deepseek.ts`, request-body builder), so the documented KVCache/scheduling
  isolation actually applies and the terms' identifier paragraph is true
  end-to-end.

## 3. Wording decision map (final)

| # | Terms passage (zh.ts / en.ts section) | Basis |
|---|----------------------------------------|-------|
| D1 | Intro: AI terms are supplementary to Terms of Use + Privacy Policy; separate checkbox consent recorded (user ID, version, timestamp) before first use; provider requires disclosure + consent **or another lawful basis** where applicable | S1 §3.3; migration `20260802120000_add_ai_terms_acceptance.sql`; CP4 round-1 P0-4 consent-basis correction |
| D2 | "AI 润色功能": request content is forwarded **in plaintext** through our server to DeepSeek | `web/src/server/polish/deepseek.ts` (HTTPS POST of `messages` to `api.deepseek.com/chat/completions`); E2EE section unchanged |
| D3 | "发送的内容": level 0 = selected texts only (+ style options); level 1 = + scope metadata (company/org, project title/detail, education org/title/detail, research title/date, skill category) + sibling items in the same entry/section; level 2 = + profile summary bodies + skill labels; header name/email/phone never read; per-request disclosure shows the exact payload | `web/src/components/cv-builder/polish/scope-builder.ts` (`assembleReferences`, level roles), `web/src/server/polish/prompt.ts` (`trimReferencesForLevel`), UI labels `PolishDialog.level.*` in messages |
| D4 | Pseudonymous identifier: we send an HMAC-SHA256 hash of the account ID as `user_id`, never email/username/raw UUID; DeepSeek documents `user_id` as used for content-safety review, cache isolation and scheduling isolation | S6, S7; `web/src/server/polish/deepseek.ts` (`user_id: request.providerUserId`; deviation resolved, §2.4) |
| D5 | "第三方 AI 服务": disk cache default-on, cleared "usually within a few hours to a few days" (attributed to API docs); **no API-specific commitment on other retention/deletion identified**; general Privacy Policy stores data it governs in the PRC **but expressly does not govern downstream end-user data** → API-specific storage location **unverified**; ToU allow de-identified use for improvement; API opt-out unverified; GDPR explicit-consent derogation paragraph | S2 §4.3, S3 (incl. intro scope limit), S4, S5; CP4 round-1 P0-4 scoped rewrite |
| D6 | "我们存储的内容": no CV text/AI output/style instructions stored server-side; metadata ledger fields listed; **scheduled for deletion** — finalized ledger 90 days after completion, per-minute counters after 2 days, daily aggregates after 90 days — by a **daily** cleanup job, so records may remain until the next scheduled run (up to ~1 extra day); terms acceptance kept until account deletion | migration `20260802130000_add_ai_quota_ledger.sql` (tables, `cleanup_ai_polish_metadata`, cron `ai-polish-retention-cleanup` 03:15 UTC); `web/src/server/polish/lifecycle.ts` (`PolishLogEvent` — no content fields by construction); CP4 round-1 P1-5 retention-wording correction |
| D7 | "配额与取消": 20 requests/day per user, 3 requests/minute, global daily capacity limit; reset at UTC midnight; a request canceled after it reached the AI provider still consumes quota; failed requests are refunded | `reserve_ai_polish_request` constants (20/day, 3/min), `ai_feature_config.global_daily_limit`, settlement table in `lifecycle.ts` |
| D8 | "AI 输出需要你审阅": output is AI-generated, may contain errors, for reference only; human review required before use | S1 §8.1 (developer must disclose exactly this); existing UI flow (accept/reject per item) |
| D9 | Privacy policy: "AI 功能" section (forwarding, pointer to AI terms, **explicit-consent derogation + withdrawal**); "International Transfers" pointer scoping the AI feature to the consent mechanism; "数据保留" bullet aligned with D6's scheduled-deletion wording; privacy has its own effective date (§4) | S1 §3.3/§5.5; CP4 round-1 P0-3/P0-4/P1-5 |

## 4. Version and effective-date decision (final)

- `AI_TERMS_VERSION` (`constants.ts`) and
  `public.current_ai_terms_version()` are both **2026-08-04**, bumped from
  2026-08-02 by migration `20260804120000_bump_ai_terms_version.sql`
  (`create or replace`, signature unchanged, so the RLS insert policy and
  `has_accepted_current_ai_terms()` need no rebuild; grants preserved).
- Reason: the release aggregate delta materially rewrote the AI terms relative
  to what 2026-08-02 first denoted in repository history (named DeepSeek
  processing, plaintext forwarding, level 0/1/2 contents, HMAC identifier,
  logging fields/retention, quota/cancellation, DeepSeek cache/storage
  disclosures). The hosted AI migration has not been applied yet — zero
  production acceptance records exist — so the bump forces no real user to
  re-consent; it makes the first production acceptance unambiguously refer to
  the final document (CP4 round-1 P0-3).
- `AI_TERMS_EFFECTIVE_DATE`: "August 4, 2026" / "2026 年 8 月 4 日".
- Privacy policy gains a material AI-processing section, so it gets its own
  `PRIVACY_EFFECTIVE_DATE` ("August 4, 2026" / "2026 年 8 月 4 日"); the
  unchanged Terms of Use keep `LEGAL_EFFECTIVE_DATE` (2026-07-03).

## 5. Retention cleanup (cron) status

- **Local (Docker Supabase), verified 2026-08-04:** pg_cron 1.6.4 enabled;
  both jobs present and active — `ai-polish-retention-cleanup`
  (`15 3 * * *`) and `ai-polish-stale-reconciliation` (`*/5 * * * *`);
  `cron.job_run_details` shows real executions (stale-reconciliation every
  5 minutes; retention-cleanup at 03:15 UTC the same day, all `succeeded`);
  manual `select public.cleanup_ai_polish_metadata();` as service_role returns
  the JSON counts without error; `web/test/db/reconcile-cleanup.test.ts`
  passes.
- **Hosted:** external rollout dependency (§6) — pg_cron must be enabled
  before the migration is applied (otherwise the migration warns and the two
  jobs must be scheduled manually per the comments in migration
  `20260802130000`), then both jobs confirmed present/active and the first
  cleanup manually invoked once. Runbook lives in the unit 4.2 PR body.

## 6. Remaining open items (external rollout steps only)

1. Hosted Supabase rollout: enable pg_cron, apply migrations (including
   `20260804120000_bump_ai_terms_version.sql`), confirm both cron jobs, run
   the first cleanup manually (§5). Tracked by the rollout unit, not here.
2. Qualified legal sign-off on the explicit-consent derogation as the GDPR
   transfer basis before global rollout (§2.3) — unit 4.3b user gate.
3. Re-verify the DeepSeek policy pages after any upstream update (dates quoted
   above are as of 2026-08-04).
