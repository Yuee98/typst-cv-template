# AI Provider Operations Runbook (OPS-002)

This runbook describes the control plane present at commit
`7216084a0b532349256a0daf3cd6cf4d4cc4b667`. It is a readback-and-authority
guide, not an operator wrapper and not a table-DML recipe. A lifecycle change
must be performed only by a qualified, authorized service-role operator using
the DB-013 RPC surface below, after the required human approval.

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
profile version, price version, routing policy, legal bundle, and runtime
contract ID/hash. A retry inherits its reservation snapshot; it does not look
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
policy edge, obtain a current reviewed source commit and record the exact
runtime-contract ID/hash that covers the proposed profile's legal manifest.
The DB-013 evidence validator requires all of the following:

- a sealed matching runtime root; the reviewed source commit OID must be a
  `sha1:` value and its recorded source SHA-256 must match the runtime-contract
  SHA-256;
- a nonempty actor and reason, a recheck timestamp not in the future, and a
  SHA-256 for that recheck;
- an unretired profile/version with a code-registered adapter, endpoint alias,
  credential alias, capability, cache policy, calculator, legal manifest, and
  display disclosure;
- an exact sealed legal bundle/manifest projection and runtime-target coverage;
- a price belonging to that exact profile version, with current source evidence
  and an exact rechecked source URL, currency, calculator, provider-effective
  interval, parameters, and component set before it may be sealed;
- a validated routing policy whose exact targets reference those immutable
  profile and price versions, plus its legal bundle and runtime pair. The
  policy validator rejects malformed, retired, expired, unsealed, legal-unbound
  and wrong-profile targets.

All of these facts are versioned. Do not mutate an activated profile, price,
policy, runtime, or legal bundle in place; create and validate a successor
through the approved design and lifecycle process.

## 4. DB-013 lifecycle surface and audit contract

DB-013 revokes direct control-plane writes and grants the following public
functions only to `service_role`. The signatures are exact PostgreSQL argument
type signatures, shown for identification; this runbook intentionally gives no
invocation payload or direct table-update recipe.

| Function | Exact signature |
| --- | --- |
| Policy transition | `public.transition_ai_routing_policy_v2(uuid,text,text,text,text,text,text,text,timestamptz,text)` |
| Set active policy pointer | `public.set_ai_routing_policy_pointer_v1(uuid,text,text,text,text,text,text,timestamptz,text)` |
| Clear active policy pointer | `public.clear_ai_routing_policy_pointer_v1(uuid,text,text,text,text,text,text,timestamptz,text)` |
| Retire profile version | `public.retire_ai_provider_profile_version_v1(uuid,text,text,text,text,text,text,timestamptz,text)` |
| Retire profile | `public.retire_ai_provider_profile_v1(uuid,text,text,text,text,text,text,timestamptz,text)` |
| Close price version | `public.close_ai_price_version_v1(uuid,timestamptz,uuid,text,text,text,text,text,text,timestamptz,text)` |
| Seal price for activation | `public.seal_ai_price_for_activation_v1(uuid,text,text,text,timestamptz,timestamptz,jsonb,jsonb,text,text,text,text,text,text,timestamptz,text)` |
| Profile-version transition | `public.transition_ai_provider_profile_version_v1(uuid,text,text,text,text,text,text,text,timestamptz,text)` |
| Create routing-policy version | `public.create_ai_routing_policy_version_v1(uuid,text,integer,text,jsonb,uuid,text,text,text,text,text,text,text,text,timestamptz,text)` |

Every public lifecycle operation returns an audit UUID. The append-only audit
records the operation, the affected policy/profile/profile-version/price IDs,
status or pointer/generation/retirement/price-seal deltas as applicable, the
runtime ID/hash, actor, reason, reviewed source commit OID, reviewed source
SHA-256, rechecked timestamp/SHA-256, occurrence timestamp, and transaction
ID. The shared evidence inputs are therefore:
`runtime_contract_id`, `runtime_contract_sha256`, `actor`, `reason`,
`reviewed_source_commit_oid`, `reviewed_source_sha256`, `rechecked_at`, and
`rechecked_sha256`.

The audit table is append-only. Preserve returned audit IDs and read them back;
they are evidence of a successful control-plane change, not a substitute for
the post-change runtime checks below.

## 5. MiMo status at this exact head

MiMo (`mimo.cn.mimo-v2.5-pro.responses.v1`) is dark and pending. Its seeded
profile version is `draft`, its price components are not sealed, and the real
runtime adapter resolver rejects the profile as unavailable. Activation is
prohibited at this commit, even if `MIMO_API_KEY` is configured or the combined
MiMo runtime contract is sealed. There is no approved path in this runbook to
override that state.

The repository contains an opt-in `MIMO_LIVE_SMOKE=1` live conformance test.
It is a paid, local provider call and is deliberately outside normal test runs.
It may be considered only after separate human authorization and local
credential handling; it is not a hosted canary, a production deployment, or an
activation authorization. A successful local smoke does not open any of the
three gates and does not waive the lifecycle preconditions.

## 6. Exact readback checklist and human gate

After any authorized lifecycle action, the qualified operator must read back
and preserve evidence for all of the following before asking a human to enable
or promote anything:

1. The returned append-only audit row, including its audit ID, operation,
   actor/reason, reviewed source commit/SHA, recheck time/SHA, runtime pair,
   and transaction ID.
2. The active `ai_feature_config` snapshot: `ai_polish_enabled`, active policy
   pointer, configuration generation, allowlist, and global daily limit.
3. The selected policy projection: status, timezone/rules, exact profile and
   price references, legal bundle, runtime ID/hash, and policy config hash.
4. The selected profile projection: status/not-retired state, code-registered
   aliases and adapter/wire API/model, capability/cache/calculator/legal and
   disclosure identifiers, plus its immutable config hash.
5. The selected price: profile-version linkage, lane/version/currency,
   validity interval, source URL/check time/snapshot, exact components, and
   `components_sealed_at` where activation requires it.
6. The sealed legal-bundle and runtime-root/target membership projections,
   proving the selected profile's manifest and route descriptor are covered by
   the exact runtime ID/hash.
7. A fresh authenticated availability read and, when separately approved, an
   API smoke that proves the returned route, disclosure, runtime pair, and
   accounting observations match the selected snapshot. Do not expose
   credentials, raw provider bodies, or user content in that evidence.

The final gate is human and qualified-authority approval: the designated human
must approve the scoped change and evidence, and a qualified service-role
operator must execute the approved DB-013 lifecycle action. This document does
not authorize deployment, production database changes, paid provider calls, or
activation.
