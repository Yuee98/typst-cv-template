# AI provider contract v2

Status: successor implementation contract, `ai_provider_contract_v2`. The bytes and v1 semantics of `ai-provider-contract.md` remain unchanged. This document is not a claim that any new Provider, model or legal fact has been approved.

## Immutable execution configuration

`profile_execution_config_v2` has exactly these fields: schemaVersion, profileKey, providerId, gatewayKind, adapterKind, wireApiKind, endpointUrl, credentialEnvName, modelId, capabilityContractId, cachePolicyId, legalManifestId, calculatorKind, displayDisclosureKey, config. Identifiers follow the existing ASCII code-ID grammar; providerId is a canonical UUID. Model IDs are bounded nonempty ASCII protocol strings, not a list of existing model names. Extra fields, legacy aliases or unknown versions reject.

The profile version fixes all execution fields. Provider directory identity is the recipient/operator/gateway; mutable display/defaults are creation conveniences. Defaults are copied once, never reread by execution or retries. Price versions belong to the exact profile version. Adapter catalog is migration-maintained; DB catalog intersected with the running code's supported implementations yields authoring choices. Deprecation excludes new authoring but preserves supported historical execution.

`config_sha256` continues to hash only canonical adapter config. It does not claim to identify endpoint/model/credential or the whole execution object. Immutable profile version ID identifies that complete object. No execution_sha256, credential_generation or destination_policy_id is introduced.

## Transport and capability

Runtime validates the complete frozen v2 tuple and produces an in-memory endpoint/key/model/adapter config. Transport adapters receive that object; they do not select a profile, read arbitrary environment names or fall back to default URLs. v1 retains its strict registered mappings and can use a legacy preparation wrapper.

Credential names match `^AI_PROVIDER_KEY_[A-Z0-9_]+$` and resolve only from a filtered secret map. A deployment-owned non-secret manifest binds each name to exact recipient/origin and a revision. Admin cannot broaden that manifest. The actual key is never persisted, hashed, displayed or logged. API credentials cannot address other runtime secrets.

Canonical endpoint is HTTPS, without userinfo, query, fragment, IP literals or unapproved ports. Exact approved origin, recipient and adapter/wire path must agree. Redirects fail. Generic custom DNS/proxy destinations remain unavailable until connection-level egress defenses are separately implemented. A syntactically valid endpoint or catalog adapter does not imply recipient authorization or protocol compatibility.

Supported new model IDs require approved request/response/usage/calculator semantics plus explicit external model, pricing and legal evidence. They do not require per-model code constants. New semantics require a new code capability and reviewed runtime contract; name compatibility is insufficient.

## Upgrade and ledger

Add v2 nullable fields plus discriminated checks to profile and attempt tables. v1 keeps non-null aliases and no v2 fields; v2 requires endpoint/env and no aliases. Extend both immutable guards and snapshot equality checks. Reservation, execution snapshot, attempt start, observation, complete/finalize/reconcile and safe projections must agree before v2 can be activated. No UPDATE backfill of old versions or historical attempts.

Upgrade testing starts from current migrations plus active v1 policy, gate enabled, users with old consent, finalized history, in-flight request and pending retry. Expand preserves that route and legal current. Separate new fixtures cover two v2 destinations with identical config_sha256 and distinct profile IDs, unsupported adapter/wire, malformed mixed versions, wrong-profile price and Shanghai/UTC route boundaries.

## Legal publication

Keep one current legal bundle. Future candidates can be authored against their exact sealed bundle using a candidate-only validator. Live pointer/reserve/reopen require current. Approved structured bilingual display data is bound to sealed facts/content identity, rendered with supported common templates and accepted by exact bundle identity. Arbitrary JSON/HTML and model-label-only legal approval are forbidden.

Deploy the old/new renderer before changing current. Prepare both new-route and rollback candidates under the new bundle; create equivalent v2 profile/price successors where legacy targets cannot legally bind the new runtime. With gate off, an audited owner transaction clears old pointer then changes current/control revision. New-current validation, activation, pointer/readback and a separate reopen follow. Old policies remain history; prior frozen reservations are not rebound or reinterpreted by new-reservation consent rules.
