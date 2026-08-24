# AI runtime execution contract

Status: CTRL-010 revision 1, internal implementation contract.

This document is deliberately **not legal evidence**. It does not change the frozen provider contract, attempt-settlement contract, provider-subject evidence, legal manifests, terms, or legal fingerprints. Its consumers are DB-011A, RT-009, RT-009A, API-001/API-002, and observability code.

The words MUST, MUST NOT, SHOULD, and MAY are normative for those consumers. Any semantic change to the byte protocol, accepted identifier language, result union, or strict JSON shapes requires a new schema/domain version and new fixed vectors; silently widening revision 1 is forbidden.

## 1. Route-observation tags

Provider and gateway request identifiers are untrusted observations. Raw values MUST NOT enter the database, structured logs, error details, metrics labels, or client responses. A consumer may retain only the tagged value defined below or a fixed safe drop reason.

### 1.1 Field domains

Revision 1 has exactly two field kinds:

- `gateway_request_id`
- `provider_request_id`

The field kind is part of the authenticated message. The same raw ID therefore produces different tags in the two domains.

### 1.2 Raw-ID classification

Classification order is fixed:

1. A missing value, JavaScript `undefined`, or JSON `null` becomes `{ "kind": "absent" }`.
2. A non-string becomes `{ "kind": "dropped", "reason": "not_string" }`.
3. A string that does not match `^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$` exactly becomes `{ "kind": "dropped", "reason": "invalid_ascii_grammar" }`.
4. The accepted ASCII string is lowercased for comparison only. If it begins with any prefix in the list below, it becomes `{ "kind": "dropped", "reason": "sensitive_prefix" }`.
5. Otherwise it is eligible for HMAC tagging.

The raw string is never trimmed and is never Unicode-normalized. The grammar permits 8 through 128 ASCII characters, requires an ASCII alphanumeric first character, and permits only ASCII alphanumerics, `_`, and `-` afterward.

The case-insensitive prefix denylist is exact and ordered lexically in the shared fixture:

```text
access-token
access_token
api-key
api_key
apikey
authorization
basic
bearer
cookie
eyj
ghp_
github_pat_
password
passwd
refresh-token
refresh_token
secret
set-cookie
sk-
sk_
token
x-api-key
x-auth-token
```

No rejection result or error message may interpolate the raw value.

### 1.3 Secret processing

Revision 1 reuses the server-only `AI_USER_ID_HMAC_SECRET`; it never accepts a secret name from DB data. The implementation MUST validate and transform the configured value as follows:

1. Non-string: `secret_not_string`.
2. Reject any unpaired UTF-16 high or low surrogate: `secret_invalid_unicode`.
3. Remove only the following Unicode scalar values from each edge, without changing interior characters:
   - U+0009 through U+000D;
   - U+0020, U+00A0, U+1680;
   - U+2000 through U+200A;
   - U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF.
4. Empty after that exact operation: `secret_empty_after_trim`.
5. Encode the remaining scalar sequence as UTF-8 without NFC, NFD, compatibility normalization, case conversion, or any other transformation.

U+180E is intentionally not whitespace in this contract and MUST NOT be removed. Secret error codes are internal fixed vocabulary and must not include the value.

### 1.4 Exact authenticated bytes

For an eligible raw ID, construct this UTF-8 message using literal LF bytes (`0a`) and no trailing LF or NUL:

```text
route-observation-v1
field_kind:<FIELD_KIND>
raw_id_utf8_length:<DECIMAL_BYTES>
raw_id:<RAW_ID>
```

`<DECIMAL_BYTES>` is the canonical base-10 byte length of `<RAW_ID>` after UTF-8 encoding. It has no sign, padding, or leading zero. `<FIELD_KIND>` and `<RAW_ID>` are inserted verbatim after validation.

Compute HMAC-SHA256 over those message bytes with the processed secret UTF-8 bytes as the key. The only successful representation is:

```text
hmac-sha256:<64 lowercase hexadecimal characters>
```

The result union is exact:

```text
{ "kind": "absent" }
{ "kind": "dropped", "reason": "not_string" | "invalid_ascii_grammar" | "sensitive_prefix" }
{ "kind": "tagged", "value": "hmac-sha256:<lowerhex64>" }
```

Implementations MUST reproduce every byte/key/tag vector in `web/test/fixtures/ai-runtime-execution-contract-v1.json`. Those vectors independently distinguish gateway from provider domains, NFC from NFD key bytes, and U+180E from the explicit trim set.

## 2. Execution snapshot JSON

`get_ai_polish_execution_snapshot_v1(reservation_id, user_id)` returns the request-frozen execution facts needed before an attempt can start. It MUST be service-role-only, `SECURITY DEFINER` with an empty search path, and perform no persistent mutation.

The DB implementation locks and reads in this order:

1. the request ledger row;
2. the request-bound profile parent;
3. the request-bound profile version;
4. the exact request-bound price parent and sealed components.

It MUST NOT read the current routing pointer, run the routing selector again, choose a latest price, substitute a default profile, or expose an endpoint URL or credential value. Missing and wrong-user requests are intentionally indistinguishable.

### 2.1 Exact result union

A successful result has exactly these keys:

```json
{
  "schemaVersion": "ai_polish_execution_snapshot_v1",
  "ok": true,
  "reservationId": "<canonical uuid>",
  "routeSnapshot": {},
  "profileExecutionConfig": {},
  "priceSnapshot": {}
}
```

An unsuccessful result has exactly these keys:

```json
{
  "schemaVersion": "ai_polish_execution_snapshot_v1",
  "ok": false,
  "reason": "NOT_FOUND"
}
```

`reason` is exactly one of `NOT_FOUND`, `ALREADY_FINALIZED`, or `SERVICE_UNAVAILABLE`:

- unknown reservation and wrong user: `NOT_FOUND`;
- already-finalized reservation: `ALREADY_FINALIZED`;
- legacy, partial, drifting, unsealed, malformed, unavailable, or arithmetically unrepresentable frozen facts: `SERVICE_UNAVAILABLE`.

No extra keys are allowed in either branch.

### 2.2 `routeSnapshot`

The route object has exactly these keys:

```text
schemaVersion
configGeneration
routingPolicyVersionId
profileVersionId
priceVersionId
legalBundleVersion
runtimeContractId
runtimeContractSha256
gatewayKind
modelId
wireApiKind
displayDisclosureKey
```

`schemaVersion` is `route_snapshot_v1`. `configGeneration` is a canonical non-negative decimal string within PostgreSQL `bigint`. IDs read from UUID columns use canonical lowercase UUID text. `runtimeContractSha256` is exactly 64 lowercase hexadecimal characters. All other identity strings are non-empty registry or frozen-ledger values; none is a display name, URL, or secret.

The object MUST be reconstructed from the locked request row, not mutable current configuration.

### 2.3 `profileExecutionConfig`

The profile object reuses `profile_execution_config_v1` and has exactly these keys:

```text
schemaVersion
profileKey
gatewayKind
adapterKind
wireApiKind
credentialAlias
endpointAlias
modelId
capabilityContractId
cachePolicyId
legalManifestId
calculatorKind
displayDisclosureKey
config
```

It contains immutable aliases and adapter configuration only. `credentialAlias` and `endpointAlias` are code-owned lookup aliases, never a secret or arbitrary URL. RT-009 MUST pass the complete object through the strict code-owned profile registry and reject unknown, missing, extra, or mismatched values before attempt start or network transmission.

### 2.4 `priceSnapshot`

The price object reuses `price_snapshot_v1` and has exactly these keys:

```text
schemaVersion
priceVersionId
currency
calculatorKind
components
parameters
```

`components` may contain only `input_standard`, `input_cache_read`, `input_cache_write`, and `output`. Every present value is the exact `nanos_per_million` encoded as a canonical non-negative decimal JSON string within PostgreSQL `bigint`. Missing optional components MUST be omitted, not emitted as `null` and not silently filled with zero. A real free component is represented by the explicit string `"0"`. `parameters` is validated by the code-owned calculator's exact schema.

### 2.5 Cross-object invariants

Before attempt start or network transmission, all of the following MUST hold:

- `reservationId` identifies the locked request used to produce all three objects;
- route `profileVersionId` identifies the exact profile version projected into `profileExecutionConfig`;
- route and price `priceVersionId` are equal;
- route and profile `gatewayKind`, `modelId`, `wireApiKind`, and `displayDisclosureKey` are equal;
- profile and price `calculatorKind` are equal;
- the profile version belongs to its locked profile parent and the price belongs to that same profile;
- the legal manifest belongs to the route's exact sealed legal bundle;
- the route runtime ID/hash pair exists in the code-owned RT-009A registry;
- the profile execution config and price snapshot each pass their code-owned exact validators.

Any failure is fail-closed and causes no provider transmission. Start-attempt separately rechecks mutable availability after the immutable execution snapshot is accepted.

## 3. Fixed vectors and change control

`web/test/fixtures/ai-runtime-execution-contract-v1.json` is the portable revision-1 vector set. Its test is intentionally an independent reference implementation: it must not import a future route-observation helper or execution-snapshot parser. Production implementations later consume the same vectors.

The current success vectors cover DeepSeek off-peak pricing with an omitted cache-write component and MiMo peak pricing with an explicit free cache-write component. They are contract examples, not activation, current-price authority, legal evidence, or permission to call either provider.

A change that only adds a new profile example may append a vector if all revision-1 grammars and shapes remain unchanged. Any widening or reinterpretation of fields, whitespace, bytes, denylist behavior, result vocabulary, or JSON shape requires a new domain/schema version and a separately reviewed migration path.
