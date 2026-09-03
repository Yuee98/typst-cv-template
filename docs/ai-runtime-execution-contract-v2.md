# AI runtime execution contract v2

Status: successor internal contract. Revision 1 document, fixed vectors, IDs and hashes remain unchanged. Runtime v2 implements the tuple and transport invariants in [provider v2](ai-provider-contract-v2.md).

The execution snapshot accepts a strict discriminated union of profile_execution_config_v1 and profile_execution_config_v2. Unknown/partial v2 never falls back to v1. The route still freezes exact policy/profile/price/legal/runtime IDs at reservation; retry consumes the same snapshot and never resolves the active pointer again.

Runtime contract v2 separates reviewed implementation capability (adapter, wire, config, usage, calculator, subject policy, display schema) from immutable data targets (profile version, canonical endpoint, model, legal manifest, sealed bundle and price binding). Registered code evidence authorizes only its declared parameterized semantics. Owner-imported external evidence authorizes concrete model/recipient/price facts. A service-role validation report checks their exact binding and running build/manifest revision but cannot manufacture either source authority.

Before send: strict decode → supported adapter/capability → exact target and price/legal binding → deployment build/manifest eligibility → approved endpoint and filtered secret → DB attempt admission → prepared transport. Failure sends no data and follows the existing no-transmission settlement contract. There is no cross-provider fallback.

Request/attempt snapshots preserve v1/v2 tags, frozen identity and observed metadata rules. v2 observations can retain actual model/endpoint only when exactly equal to the validated frozen values. Upstream IDs continue through the existing HMAC classification contract. Safe analytics never return endpoint, secret name/value, raw ID, CV, prompt or response body. Record actual build and non-secret binding manifest revision as attempt execution provenance; do not equate it to key rotation generation.

Registered build changes invalidate applicable reports. DB cannot attest unregistered Vercel environment values. Runtime compares its own build/config revision to operator-approved records; mismatch rejects new v2 sends. Compatible old in-flight execution remains frozen. Cutover rollback floors cover execution/consent and Admin JWT/report/readback together.

Portable vectors are added under `web/test/fixtures/admin-contract-v1.json` and successor execution fixtures. Negative vectors must exercise coherent tuple substitution, extra/missing fields, same adapter config with different destination/profile, model ID propagation, future bundle versus live gate, and stale report/control generation. Synthetic test models confer no hosted compatibility evidence.
