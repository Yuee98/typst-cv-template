# AI Provider Operations Runbook (OPS-002)

This runbook describes the current DB-013 control plane and its local-only
promotion boundary. It is a readback-and-authority guide, not an operator
wrapper and not a table-DML recipe. A lifecycle change must be performed only
by a qualified, authorized service-role operator using the DB-013 RPC surface
below, after the required human approval. Nothing here grants hosted
authorization or permits bypassing the three gates.

## 1. Three independent gates

The feature is usable only when the relevant gates agree; none substitutes for
another.

| Gate | Authority and effect | Operational consequence |
| --- | --- | --- |
| Build UI | `NEXT_PUBLIC_AI_POLISH_ENABLED` is baked into the browser build. Only the literal string `true` exposes AI Polish UI/copy. | Changing it requires a build and deployment. It must remain off for static export builds, which have no API route. |
| Deployment API | `AI_POLISH_ENABLED` is the server deployment gate for the API. It is read at module scope. | A changed value takes effect only in the next deployment; it is not an incident-response kill switch. |
| Database runtime | `public.ai_feature_config.ai_polish_enabled` is checked by the reserve and start-attempt lifecycle. | This is the immediate runtime kill switch, without a redeploy. It does not make a UI build or an API deployment safe by itself. |

For an incident, disable the database runtime gate first. Confirm that new
reservations/transmissions are denied, then remove the active routing pointer
through the qualified lifecycle authority if needed, and finally disable the
deployment API and the next build's UI gate. Do not reverse that order: a
redeploy is delayed, while the DB switch is evaluated by the request lifecycle.

## 2. Authority boundaries

The database route snapshot is the authority for the selected immutable
profile version, price version, routing policy, legal bundle, and versioned
runtime contract ID. A retry inherits its reservation snapshot; it does not look
up a newer route. A request start rechecks the kill switch, allowlist, global
capacity, and frozen-profile availability and fails closed when any is
unavailable.

Environment variables provide credentials only, through the code-owned aliases
`DEEPSEEK_API_KEY` and `MIMO_API_KEY`. A selected DB alias must match the
reviewed registry, and the production endpoint comes from that registry. Do
not add or use `AI_PROVIDER`, `AI_MODEL`, `AI_BASE_URL`, or equivalent
provider/model/base-URL selector variables. They would bypass the versioned,
audited DB authority. Test-only endpoint injection is forbidden in production.

There is no automatic cross-provider fallback. If the selected profile or its
credential is unavailable, the request fails closed; it is never rerouted to a
different provider.

## 3. Preconditions before any lifecycle promotion

Before an authorized operator considers a new provider, profile, price, or
policy edge, obtain current reviewed-source audit evidence and record the exact
versioned runtime-contract ID that covers the proposed profile's legal manifest.
Lifecycle operations collectively require the following checks where their
operation applies:

- `assert_ai_routing_lifecycle_evidence_v1` requires a sealed matching runtime
  root; syntactically valid reviewed source commit/SHA audit metadata; a
  nonempty actor and reason; and a non-future recheck timestamp plus its
  SHA-256. Reviewed-source metadata records the operator's evidence but is not
  the runtime identity and does not impose Git ancestry;
- operation-specific profile, price, policy, and runtime/legal validators
  require an unretired profile/version, current source evidence, exact
  price/component facts where sealing applies, sealed legal/runtime coverage,
  and a valid policy transition or pointer target as applicable;
- the application code registry independently requires the selected
  adapter/endpoint/credential aliases, capability, cache policy, calculator,
  legal manifest, and display disclosure to be code-registered. The policy
  validator rejects malformed, retired, expired, unsealed, legal-unbound, and
  wrong-profile targets.

All of these facts are versioned. Do not mutate an activated profile, price,
policy, runtime, or legal bundle in place; create and validate a successor
through the approved design and lifecycle process.

## 4. DB-013 lifecycle surface and audit contract

DB-013 revokes general lifecycle and routing-pointer DML, and grants the
following public functions only to `service_role`. It retains narrow,
structurally guarded `service_role` column updates for
`ai_feature_config.ai_polish_enabled`, `global_daily_limit`, and
`enabled_user_allowlist`; `ai_provider_profile_versions.display_disclosure_key`;
and `ai_price_versions.components_sealed_at`. The first retained authority is
the immediate database kill switch described above; it is not a broad
activation surface. The signatures are exact PostgreSQL argument type
signatures, shown for identification; this runbook intentionally gives no
invocation payload or direct table-update recipe.

| Function | Exact signature |
| --- | --- |
| Policy transition | `public.transition_ai_routing_policy_v2(uuid,text,text,text,text,text,text,timestamptz,text)` |
| Set active policy pointer | `public.set_ai_routing_policy_pointer_v1(uuid,text,text,text,text,text,timestamptz,text)` |
| Clear active policy pointer | `public.clear_ai_routing_policy_pointer_v1(uuid,text,text,text,text,text,timestamptz,text)` |
| Retire profile version | `public.retire_ai_provider_profile_version_v1(uuid,text,text,text,text,text,timestamptz,text)` |
| Retire profile | `public.retire_ai_provider_profile_v1(uuid,text,text,text,text,text,timestamptz,text)` |
| Close price version | `public.close_ai_price_version_v1(uuid,timestamptz,uuid,text,text,text,text,text,timestamptz,text)` |
| Seal price for activation | `public.seal_ai_price_for_activation_v1(uuid,text,text,text,timestamptz,timestamptz,jsonb,jsonb,text,text,text,text,text,timestamptz,text)` |
| Profile-version transition | `public.transition_ai_provider_profile_version_v1(uuid,text,text,text,text,text,text,timestamptz,text)` |
| Create routing-policy version | `public.create_ai_routing_policy_version_v1(uuid,text,integer,text,jsonb,uuid,text,text,text,text,text,text,text,timestamptz,text)` |

Every public lifecycle operation returns an audit UUID. The append-only audit
records the operation, the affected policy/profile/profile-version/price IDs,
status or pointer/generation/retirement/price-seal deltas as applicable, the
runtime ID, actor, reason, reviewed source commit OID, reviewed source
SHA-256, rechecked timestamp/SHA-256, occurrence timestamp, and transaction
ID. The shared evidence inputs are therefore:
`runtime_contract_id`, `actor`, `reason`,
`reviewed_source_commit_oid`, `reviewed_source_sha256`, `rechecked_at`, and
`rechecked_sha256`.

The audit table is append-only. Preserve returned audit IDs and read them back;
they are evidence of a successful control-plane change, not a substitute for
the post-change runtime checks below.

## 5. Current runtime and external evidence

The executable combined runtime is the immutable, versioned code ID
`runtime.deepseek-v2-mimo-v2.5-pro.v2`. Its
code-owned MiMo Responses adapter is available, but MiMo
(`mimo.cn.mimo-v2.5-pro.responses.v1`) remains a dark, unsealed draft and is
not active by default. A qualified DB-013 operator may promote it only after
the current evidence, seal, validation, and human-approval gates below have
passed. There is no automatic fallback and no hosted activation authorization.

`docs/ai-provider-contract.md` is an immutable reviewed service/legal evidence
blob for the current manifest and runtime roots. Its embedded price prose and
legacy runtime-hash mechanics are historical snapshots; do not edit it in
place or treat either as current activation/runtime authority. The successor
ID-only identity contract is `docs/ai-runtime-execution-contract.md`. Current
activation facts come only from the official recheck below, the exact seeded
price row, and DB-013's matching seal evidence.

The current external price evidence that must be rechecked before local
activation is:

- DeepSeek V4 Flash peak/offpeak pricing is sourced from the official pricing
  page/announcement at
  `https://api-docs.deepseek.com/zh-cn/quick_start/pricing/`. That evidence
  establishes `2026-08-16T16:00:00Z` as the current effective start, with
  weekday Asia/Shanghai windows `09:00-12:00` and `14:00-18:00`. Its raw
  snapshot was rechecked at `2026-08-28T08:05:41.804Z`, hash prefix
  `899aff...`.
- MiMo is effective at `2026-05-26T16:00:00Z`. Its current pricing page was
  checked at `2026-08-28T08:05:41.986Z`, hash prefix `d43d...` (official page:
  `https://mimo.mi.com/docs/en-US/price/pay-as-you-go`). The cache-write
  component is limited-time free with an unknown end date; treat that as an
  expiring fact, not a permanent zero price.

The price authority graph is **official page/announcement evidence -> reviewed
exact provenance seed -> DB-013 seal and validation -> policy/pointer**. The
current effective date must come from the first node, not be inferred by
reading a DB-012 legacy row. DB-012's legacy `provider_effective_to` records
the same `2026-08-16T16:00:00Z` transition boundary solely to close the
historical lane; it neither establishes the current price nor authorizes that
legacy price for activation. Before execution, prove that the selected exact
head contains the provenance seed carrying the source URL, check timestamp,
snapshot hash, and effective date above, then fresh-reset the local database.
Otherwise remain fail-closed.

These facts are evidence inputs, not permission to activate or call a
provider. A historical legacy price is never activatable. If the exact
source/head/reset boundary cannot be proved, stop.

## 6. Local-only staged promotion and smoke boundary

For a separately approved local exercise, use this staged boundary:

`current price evidence -> seal -> profile validated/active -> policy validated/active -> pointer -> DB kill switch (disabled before pointer, re-enabled only after pointer readback) -> authenticated availability -> separately paid smoke`

The database runtime gate must be disabled before changing the active pointer,
and must remain disabled through pointer and post-pointer readback. Only after
the pointer, audit row, and route projections agree may the qualified operator
re-enable the gate for an authenticated availability read. The final smoke is
an independently authorized, separately paid local provider call; it is never
a hosted canary, deployment authorization, or substitute for lifecycle
evidence. Clean up local smoke state with a fresh reset, and redact
credentials, raw provider bodies, user content, and reusable invocation
payloads from all evidence.

The repository's opt-in `MIMO_LIVE_SMOKE=1` conformance test is the separately
paid local smoke referred to above. Keep it outside normal test runs and never
use its result as activation or hosted authorization.

For operations, use the DeepSeek-only weekday rollback policy
`33333333-3333-4333-8333-333333333336` first. Consider the weekday G4 MiMo policy
`33333333-3333-4333-8333-333333333335` only after it is explicitly validated
and active, and only during the Beijing peak windows above. Neither policy
may be activated from stale or legacy price evidence.

## 7. Exact readback checklist and human gate

### CFG-003 weekday candidates and rollback order

The official G4 and explicit successor candidate windows are weekdays in
Asia/Shanghai: `[1,2,3,4,5]`, `09:00-12:00` and `14:00-18:00`, each
half-open. Weekends use the DeepSeek offpeak default route. The old G2
weekday-only policy and every historical legacy price are historical and must
never be used as a safe rollback. The seeded G4
candidate currently references MiMo while its profile is `draft` and its price
is unsealed; that is valid seed state, but it blocks activation until the
staged evidence, sealing, validation, and human gates have passed. Operators
must use the separately seeded weekday DeepSeek-only successor first through the
qualified lifecycle authority; G4 MiMo is considered only after it is active
and only within the Beijing peak windows.

The preceding daily policies `33333333-3333-4333-8333-333333333333` and
`33333333-3333-4333-8333-333333333334` remain immutable historical drafts.
They are explicitly forbidden as pointer targets or rollback candidates; do not
select, validate, promote, or reactivate them. The local successor installs
database constraints that reject lifecycle or pointer writes to those IDs even
from normal operator and service-role paths.

Treat a deployment stopped after migration `20260824007000` as incomplete and
non-operable. Before any profile, price, policy, pointer, or feature lifecycle
operation, positively read back migration `20260824008000` and both validated
table-owned constraints:
`ai_routing_policy_versions_cfg003_daily_dark_check` on
`public.ai_routing_policy_versions` and
`ai_feature_config_cfg003_daily_pointer_check` on
`public.ai_feature_config`. Missing, unvalidated, or differently defined guards
are a hard stop; do not rely on the daily rows merely remaining draft by
convention.

After any authorized lifecycle action, the qualified operator must read back
and preserve evidence for all of the following before asking a human to enable
or promote anything:

1. The returned append-only audit row, including its audit ID, operation,
   actor/reason, reviewed source commit/SHA, recheck time/SHA, runtime ID,
   and transaction ID.
2. The active `ai_feature_config` snapshot: `ai_polish_enabled`, active policy
   pointer, configuration generation, allowlist, and global daily limit.
3. The selected policy projection: status, timezone/rules, exact profile and
   price references, legal bundle, runtime ID, and policy config hash.
4. The selected profile projection: status/not-retired state, code-registered
   aliases and adapter/wire API/model, capability/cache/calculator/legal and
   disclosure identifiers, plus its immutable config hash.
5. The selected price: profile-version linkage, lane/version/currency,
   validity interval, source URL/check time/snapshot, exact components, and
   `components_sealed_at` where activation requires it.
6. The sealed legal-bundle and runtime-root/target membership projections,
   proving the selected profile's manifest and route descriptor are covered by
   the exact runtime ID.
7. A fresh authenticated availability read and, when separately approved, an
   API smoke that proves the returned route, disclosure, runtime ID, and
   accounting observations match the selected snapshot. Do not expose
   credentials, raw provider bodies, or user content in that evidence.

The final gate is human and qualified-authority approval: the designated human
must approve the scoped change and evidence, and a qualified service-role
operator must execute the approved DB-013 lifecycle action. This document does
not authorize deployment, production database changes, paid provider calls, or
activation.
