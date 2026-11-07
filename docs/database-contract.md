# Current database contract

Contract: `cv_app_db_1`. The executable catalogue is [migrations](../supabase/migrations); [generated public types](../web/src/lib/supabase/database.types.ts) describe the SQL signatures, and the shared Zod contracts validate application DTOs. This file describes the implemented interface. Hosted databases have not been switched.

Entity IDs use their external prefixes. Auth user IDs, database instance IDs and operation/request keys remain UUIDs. Revisions, generations, counters and nanos travel as decimal strings. SQL JSON uses snake_case; the AI browser API uses its explicit camelCase projection. JSON RPCs return `jsonb`; `keep_project_active()` returns a boolean.

All writes accept one `p_input jsonb` argument. Common fields are `contract_code: "cv_app_db_1"` and `database_instance_id`. CV and legal writes additionally require `expected_auth_user_id`, equal to the verified JWT user. The browser binds each account-owned operation to one verified access token, so a later account switch cannot change its principal. These expected values are guards, not authorization sources.

AI service RPCs also take `owner_auth_user_id`, supplied by the server after verifying the user's JWT. They require the same contract/instance guards and are granted only to `service_role`. Admin mutations use the current Admin bearer, require `operation_key` UUID and a trimmed reason of 3–500 characters, and validate current membership/session before checking idempotent replay. The service role cannot become an administrator through these APIs.

Errors use SQLSTATE `P0001` with a fixed error code as the message and a safe reason as detail. HTTP maps those codes to the shared error contract; configuration changes use `CONFLICT` with `CONFIG_CHANGED` or `OPTION_UNAVAILABLE`, and instance/account changes require a refresh. Private responses use `private, no-store`.

## Context and CV

- `app_context()` returns `{ready,contract_code,database_instance_id,environment,capabilities}`. Before atomic owner initialization, `ready=false` and the instance is NULL; business writes fail closed.
- `keep_project_active()` returns true and reads no business content.
- `cv_document_summaries` and `cv_document_contents` are read-only invoker views restricted to the JWT user's documents. Summary columns are `external_id,title,storage_mode,document_schema_version,revision,time_created,time_updated`; contents add `data,encrypted_payload`.
- `cv_document_create` takes `client_create_key,title,storage_mode,document_schema_version:7,data?,encrypted_payload?`. Exactly one payload matches `PLAIN` or `ENCRYPTED`. It returns the content row. Same key and exact creation payload replay the original document; a changed payload conflicts.
- `cv_document_update/convert` take `external_id,expected_revision,storage_mode,document_schema_version:7,data?,encrypted_payload?`. Update preserves the storage mode; convert changes it. `cv_document_rename` takes `external_id,expected_revision,title`; delete takes `external_id,expected_revision` and returns `{deleted:true}`. Other writes return the content row.

Encrypted payload version 1 is the sole current AES-GCM envelope. The database validates the declared content version and envelope, while the client validates v7 both before encryption and after decryption. An uncertain update keeps its old edit revision until readback; list refreshes do not silently rebase a dirty form. Draft contract `cv_draft_1` retains its original `baseRevision`. Pending creates retain the operation key and, for encryption, the same envelope across an uncertain retry.

## Legal content and acceptance

`legal_current()` is safe to read publicly and returns NULL before initialization. Afterwards it returns:

```text
terms: {external_id,content_digest,renderer_contract:"legal_document_1",content:{zh,en}}
ai_bundle: null | {
  external_id,manifest_digest,
  ai_terms:{external_id,content_digest,renderer_contract:"legal_document_1",content:{zh,en}},
  disclosures:[{external_id,provider_id,provider_code,model_id,recipient_code,
    content_digest,renderer_contract:"legal_display_1",content:{zh,en}}]
}
```

Document languages contain `title,effectiveDate,intro,sections`; disclosure languages contain `providerLabel,modelLabel,blocks`. `/terms`, `/ai-terms` and the acceptance modal read the current database content. The privacy page remains a source-owned public document. Signup does not manufacture a database acceptance from an old static version or a pending OAuth flag.

`legal_accept_document` takes `document_version_id,content_digest`; `legal_accept_disclosure` takes `disclosure_id,content_digest,bundle_id,manifest_digest`. Both include the common client guards and return `{accepted:true,target_id,content_digest}`. Disclosure acceptance covers the common AI terms and the exact selected provider content bound by the bundle; it does not accept another provider. `legal_my_acceptances` projects external document/disclosure IDs, `accepted_content_digest,time_accepted`, under ownership RLS.

## AI execution

Every function below takes the common service guards in `p_input`:

| Function | Additional input | Result |
| --- | --- | --- |
| `ai_availability` | none | `generation,policy_version_id,rule_ordinal,options,default_option_id,observed_at,next_change_at,enabled,reason,database_instance_id,contract_code` |
| `ai_quota` | none | `day,limit,reserved,charged,remaining,minute_limit` |
| `ai_reserve` | `client_request_key,request_fingerprint,selected_option_id,expected_generation,expected_policy_version_id,expected_profile_version_id,disclosure_id,content_digest` | `request_id,state,replayed,quota` |
| `ai_execution_snapshot` | `request_id` | Frozen option/policy version, `profile_id` identity, `profile_version_id`, price, provider, capability, endpoint/credential reference/model/adapter configuration, consent evidence, cancellation sequence and attempts |
| `ai_attempt_start` | `request_id,attempt_no` (1 or 2) | `attempt_id,attempt_no,state,may_transmit` |
| `ai_attempt_complete` | `request_id,attempt_id,state,transmitted,provider_billable,retry_allowed,usage,provider_reported_cost_nanos?` | `attempt_id,state,replayed` |
| `ai_cancel` | `request_id` | `request_id,state,cancel_sequence` |
| `ai_finalize` | `request_id` | `request_id,state,outcome,charged,quota` |

`expected_profile_version_id` in reserve identifies the exact `pfv_` profile version. Availability options include their `option_id,profile_version_id,provider_id,provider_code,provider_name,recipient_code,model_id,disclosure_id,content_digest,bundle_id,manifest_digest,content,status,reason`. The service-only result also supplies `runtime_profile` for this server's capability, destination and credential checks. The HTTP layer removes that private object and returns only safe presentation fields. Endpoint and credential references never reach the browser availability DTO.

Only the initial successful attempt creation can return `may_transmit=true`; replay never permits another send. Usage contains `input_total,cache_read,cache_write,input_standard,output,reasoning`, with nullable decimal counters for unknown facts. The database computes estimated costs from frozen prices; finalize derives charging and aggregates from persisted attempt facts. `STARTED`/unknown facts remain HELD until supported settlement; an uncertain response is not permission to send again. No output body is persisted for replay.

## Supported provider profiles

| Provider | Capability / adapter / wire | Exact endpoint | Adapter configuration |
| --- | --- | --- | --- |
| DeepSeek | `DEEPSEEK_RESPONSES` / `deepseek_responses_v1` / `responses_v1` | `https://api.deepseek.com/responses` | `{"reasoningEffort":"none","structuredOutput":"json_object","providerSubjectField":"user"}` |
| MiMo | `MIMO_RESPONSES` / `mimo_responses_v1` / `responses_v1` | `https://api.xiaomimimo.com/v1/responses` | `{"reasoningEffort":"none","structuredOutput":"prompt_only","sendProviderSubjectId":false}` |
| Gemini | `GEMINI_INTERACTIONS` / `gemini_interactions_v1` / `interactions_v1` | `https://generativelanguage.googleapis.com/v1/interactions` | `{"thinkingLevel":"low","thinkingSummaries":"none","structuredOutput":"json_schema","sendProviderSubjectId":false,"store":false,"background":false}` |

All use `execution_contract=cv_polish_1` and `calculator_kind=linear_token_v1`; DeepSeek and Gemini cache policy is `automatic`, MiMo `none`. Code requires the exact compiled descriptor digest, endpoint and adapter configuration, plus a matching `AI_PROVIDER_KEY_<PROVIDER>_*` credential reference. There is no Chat transport fallback. Model IDs remain immutable profile configuration; current disclosures cover DeepSeek `deepseek-flash` and Gemini `gemini-3.8-flash`.

All adapters reject a response that explicitly reports a different model, while retaining known usage and safe request IDs for settlement. Only an exact reported match populates `actualModelId`; an absent model observation remains unknown. MiMo has a single model-observation implementation, with no optional historical mode.

DeepSeek carries the service's HMAC-SHA256 pseudonym in `user`, with no email, username or raw Auth UUID. The transport omits unsupported `store`; the official [Responses guide](https://api-docs.deepseek.com/guides/responses_api/) reports fixed `store:false`. That does not establish zero cache/log retention, a processing location or no-training terms; the [legal source record](../web/src/content/legal/ai-terms-sources.md) preserves those boundaries.

Gemini uses the official stable [Interactions API](https://ai.google.dev/api/interactions-api-v1), not an OpenAI compatibility endpoint. Requests carry `system_instruction`, `input`, a code-owned JSON schema, `generation_config` with low thinking and no thought summaries, `stream:false`, `store:false`, and `background:false`. They carry no user identifier, tools, labels or previous interaction. Only completed text `model_output` steps are output; thought bodies are ignored. Normalized billable output includes visible output plus thought tokens; `reasoning` records the thought subset and is not charged again. Cache-read counters are conserved against input; unreported cache-write stays NULL. Unexpected or missing usage remains unknown rather than invented zero.

The seventh migration introduced immutable `CV_APP_RESPONSES_20261107` legal content. The eighth creates the new three-provider `CV_APP_GEMINI_20261107` bundle and common AI terms, with exact disclosure identities/digests. Old sealed bytes remain unchanged. The new DeepSeek/MiMo disclosures retain their provider-specific facts while updating the shared provider list. Publication disables AI, clears the policy pointer and advances generation/close cycle. New profiles/policy bind the new targets and require fresh validation/readback and exact acceptance; previous bundle acceptances are not aliases for the new disclosures. `store:false` only disables retrievable Interactions history; Google billing tier, training/data-sharing settings, abuse logs and implicit caches require separate review described in the [runbook](database-rebuild-runbook.md).

## Admin reads and mutations

`admin_context()` returns the public context fields plus `member_id,aal,control`. It omits legal document bodies; `legal_current()` remains the dedicated legal-content API. Control contains `enabled,active_policy_version_id,audience,generation,close_cycle,revision,user_daily_limit,global_daily_limit,user_minute_limit`; the last six integer fields use decimal strings.

`admin_read(p_input)` returns `{context,data}` in one authenticated RPC and transaction, reusing the existing live account/session/membership gates and section projections. Inputs require `contract_code`, `expected_environment` (`LOCAL`, `PREVIEW`, or `PRODUCTION`) and a UI `section`. A cold read omits `database_instance_id`; subsequent reads supply the captured instance, and a mismatch fails with `CLIENT_UPDATE_REQUIRED`. Explicit null is invalid. Overview and controls return `data:null`; analytics accepts integer `days` from 1–31 (default 7). Record sections require their allowed underlying `kind` (`users/members`, `providers`, `profiles/profile_versions`, `price_versions`, `policies/policy_versions`, or `events` respectively). Lists accept `limit` 1–100 (default 25) and optional string `after`; details instead require `external_id`. Unknown, misplaced or incorrectly typed fields are rejected. The RPC grants EXECUTE only to `authenticated`, uses the restricted `app_api_owner` and empty search path, and adds no table/schema privileges or authorization cache.

`admin_records(p_kind,p_limit=50,p_after=NULL)` returns `{records,next_cursor}` with a maximum of 100. Kinds are `providers,profiles,profile_versions,price_versions,policies,policy_versions,members,validations,readbacks,operations,requests,users,events`. `admin_record(p_kind,p_external_id)` returns an entity record; Auth users have a limited list projection. `admin_analytics(p_days=30)` accepts 1–90 days and returns `days,global,profiles`, retaining separate currency groups. Configuration foreign keys are external IDs; immutable version records additionally expose their mutable parent's `parent_revision`.

All mutations below include common Admin fields. Mutable targets use `expected_revision`; version creation uses and advances its parent revision. Version lifecycle actions use `external_id,expected_status,config_digest,expected_revision` rather than a fictitious version revision.

| Function | Additional fields |
| --- | --- |
| `admin_provider_update` | `external_id,expected_revision,name,description,defaults:{capability_code,endpoint_url,credential_ref,model_id}`; incomplete defaults may be NULL |
| `admin_profile_create` | `provider_id,code,name,description` |
| `admin_policy_create` | `code,name,description` |
| `admin_profile_version_create` | `profile_id,expected_revision,capability_code,endpoint_url,credential_ref,model_id,adapter_config,disclosure_id` |
| `admin_price_version_create` | `profile_version_id,expected_revision,lane_code,currency,calculator_kind,parameters,valid_from,valid_until,components` |
| `admin_policy_version_create` | `policy_id,expected_revision,bundle_id,options:[{key,profile_version_id,price_lane_code,display_order}],rules:[{ordinal,is_fallback,weekday,start_minute,end_minute,option_keys,default_option_key}]` |
| `admin_profile_version_publish`, `admin_price_version_publish`, `admin_policy_version_publish` | Lifecycle fields and exact `validation_id` |
| `admin_profile_version_retire`, `admin_price_version_retire`, `admin_policy_version_retire` | Lifecycle fields; price intervals must already have ended |
| `admin_profile_retire`, `admin_policy_retire` | `external_id,expected_revision` |
| `admin_price_version_close` | Lifecycle fields; DB sets the current closing instant |
| `admin_price_version_replace` | Lifecycle fields, `currency,lane_code,calculator_kind,parameters,components,validation_id`; validates the current profile, closes the old price and creates/publishes its successor at one DB instant |
| `admin_ai_disable` | `expected_revision` |
| `admin_ai_set_policy` | `expected_revision,policy_version_id,validation_id`; NULL policy clears the pointer |
| `admin_ai_reopen` | `expected_revision,readback_id` |
| `admin_ai_update_limits` | `expected_revision,user_daily_limit,global_daily_limit,user_minute_limit` |
| `admin_ai_set_audience` | `expected_revision,audience` (`ALLOWLIST` or `ALL`) |
| `admin_ai_set_allowed_user` | `expected_revision,auth_user_id,allowed` |
| `admin_member_grant`, `admin_member_revoke` | `auth_user_id,expected_revision`; new grant creates a member, existing membership changes compare its revision |

Components are the four decimal-string amounts `INPUT_STANDARD,INPUT_CACHE_READ,INPUT_CACHE_WRITE,OUTPUT`, expressed in nanos per million tokens. Price replacement does not accept a separately pre-created successor ID, whose immutable start time could not match the database closing instant.

A committed mutation returns `{operation_id,operation,result,audit_id,time_committed}`; `operation` is the domain action without the `admin_` RPC prefix. Same actor/key/payload replays that receipt; changed input conflicts. Draft creation does not need provider credentials or step-up. Publishing, retirement, price close/replace, runtime changes other than emergency disable, and membership changes require verified recent TOTP/AAL2. The UI can renew an existing factor without re-enrollment. Account/instance changes discard visible private state; an uncertain mutation retains its original payload/key for retry.

## Validation and readback producers

These four functions are `service_role` only. Candidates and records include `contract_code,database_instance_id` in `p_input`; there is no browser-supplied successful report.

- `config_validation_candidate` takes `target_kind` (`PROFILE/PRICE/POLICY`), `target_id`. It returns environment/instance, target identity, `dependency_digest,passed,reasons,time_expires,data:{profiles,configuration}`. Profiles cover every candidate in every rule, including future periods and nondefault options.
- `config_validation_record` takes the same target plus `dependency_digest,passed,reasons` observed by this server. It rechecks database dependencies and returns `{external_id,target_kind,target_id,dependency_digest,passed,reasons,time_checked,time_expires}`.
- `runtime_readback_candidate` checks the currently selected disabled policy; `runtime_readback_record` takes `dependency_digest,passed,reasons` and returns `{external_id,policy_version_id,dependency_digest,passed,reasons,time_checked,time_expires}`.

The server checks compiled semantics, endpoint policy and provider-specific credential binding/presence without a paid upstream request. Database and server checks must both pass. Validation lasts at most 10 minutes; readback at most 5, shortened to the nearest relevant price boundary. A changed dependency, control revision/generation or closing cycle invalidates old evidence. Report success is not a promise that an external provider will accept the key later.
