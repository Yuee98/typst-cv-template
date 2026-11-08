# Database contract

Implementation target: cv_app_db_2. Hosted databases have not been switched.

# cv_app_db_2 — frozen integration contract
All RPCs take p_input jsonb unless explicitly no arguments. JSON is strict at BFF. PostgreSQL bigint IDs/revisions/rates/counts are decimal strings; adapter_id is integer 1/2/3. Auth IDs/operation_key/client_request_key are UUID strings. Shared guard: {contract_code:'cv_app_db_2',database_instance_id:UUID}. No legacy aliases.

## Public bootstrap/CV
app_context() => {ready,contract_code,database_instance_id:UUID|null,environment:'LOCAL'|'PREVIEW'|'PRODUCTION'|null,capabilities:{cv_schema_version:7,encrypted_envelope_version:1}}.
keep_project_active() => true (anon/authenticated/service_role).
Existing cv_document_create/update/convert/rename/delete RPC names/parameters and cv_document_summaries/cv_document_contents readonly views retained; p_input must include expected_auth_user_id and shared guard, current v7 only.

## Legal DTO
LegalDocument = {document_id:decimal,external_id:'ldoc_...',kind:'TERMS'|'AI_COMMON'|'AI_PROVIDER',zh_title,en_title,zh_body,en_body,effective_date:'YYYY-MM-DD',content_digest:64hex,enabled:boolean,revision:decimal,document_audit_id:decimal,recipient_name:string|null,adapter_id:1|2|3|null,endpoint_url:string|null,model_id:string|null}.
legal_current() => {documents:LegalDocument[]} (current enabled documents only).
legal_document_read(p_input:{external_id,document_audit_id,content_digest}) => LegalDocument (exact historical audit only if that audit was enabled).
legal_my_acceptances readonly view => {document_id,document_audit_id,content_digest} for current user only.
legal_accept_document(p_input:{...guard,expected_auth_user_id,document_id,document_audit_id}) => {accepted:true,acceptance_audit_id:decimal} (TERMS only).
legal_accept_ai(p_input:{...guard,expected_auth_user_id,common:{document_id,document_audit_id},provider:{document_id,document_audit_id}}) => {accepted:true,common_acceptance_audit_id,provider_acceptance_audit_id} atomically.
A displayed historical enabled audit is acceptable only while its full content/scope digest matches current enabled document. Acceptance audit points exactly to what was accepted. AI reserve rechecks current common/provider documents and accepted digests.
LegalDisplay={contract:'cv_app_db_2',common:LegalDocument,provider:LegalDocument}.

## AI service-only (EXECUTE service_role only)
Every input contains ...guard,owner_auth_user_id. Reserve/start/cancel/snapshot/quota require active account; complete/finalize allow deleted-user late facts on an existing request whose owner is NULL.
Quota={day,limit,reserved,charged,remaining,minute_limit,reset_at}; counts decimal strings.
ai_quota => Quota.
ai_availability => {contract_code,database_instance_id,enabled,reason:string|null,control_revision:decimal,default_config_id:decimal|null,quota,configurations:[{config_id:decimal,name,revision:decimal,adapter_id:1|2|3,execution_contract,endpoint_url,model_id,credential_ref,eligible:boolean,reason:string|null,consent_required:boolean,legal_display:LegalDisplay}]}.
Execution contracts: adapter1 deepseek_responses_v1, 2 mimo_responses_v1, 3 gemini_interactions_v1. All endpoint/model/keyref are DB config; transport semantics are code-defined. BFF strips execution credentials/endpoint fields before browser projection.
Price={currency,input_standard_nanos_per_million,input_cache_read_nanos_per_million,input_cache_write_nanos_per_million,output_nanos_per_million}; four rates decimal strings.
ai_reserve input += {client_request_key,request_fingerprint:64hex,config_id,expected_config_revision,expected_control_revision,common_document_audit_id,provider_document_audit_id} => {request_id:'req_...',state,replayed:boolean,quota}.
ai_execution_snapshot input += {request_id} => {request_id,state,config_id,config_name,config_revision,adapter_id,execution_contract,endpoint_url,model_id,credential_ref,price:Price,common_acceptance_audit_id,provider_acceptance_audit_id,provider_document_id,provider_document_audit_id,time_canceled:ISO|null,attempts:[{attempt_no:1|2,state,retry_allowed:boolean|null,transmitted:boolean|null}]}.
ai_attempt_start input += {request_id,attempt_no:1|2} => {request_id,attempt_no,state,may_transmit:boolean}.
ai_attempt_complete input += {request_id,attempt_no:1|2,state:'SUCCEEDED'|'CANCELED'|'FAILED_UPSTREAM'|'TIMED_OUT'|'INVALID_OUTPUT'|'UNKNOWN',transmitted:boolean|null,provider_billable:boolean|null,retry_allowed:boolean,usage_complete:boolean,usage:{input_total,input_standard,cache_read,cache_write,output,reasoning}} => {request_id,attempt_no,state,replayed:boolean}. Usage values decimal strings|null. No client estimated/provider-reported cost fields; DB computes costs from frozen typed snapshot.
ai_finalize input += {request_id} => {request_id,state:'HELD'|'FINALIZED',outcome:null|'SUCCEEDED'|'CANCELED'|'FAILED_UPSTREAM'|'INVALID_OUTPUT'|'RELEASED',charged:boolean|null,quota}.
ai_cancel input += {request_id} => {request_id,state,time_canceled:ISO,quota}. First server timestamp only, no sequence.

## Admin
Common mutation envelope={...guard,operation_key:UUID,reason:string}; every read/write requires a valid logged-in account, live Auth session and active administrator membership. There is no application MFA/TOTP/AAL2 requirement, enrollment UI or step-up error. Revision, instance, idempotency and audit checks remain.
Receipt={operation_id:decimal,operation:string,entity_kind:string,entity_id:decimal,revision:decimal,time_committed:ISO}. No JSON result storage; caller rereads affected aggregate after commit.
Configuration BFF validation errors use {error:{code:'INVALID_REQUEST',reason:'CREDENTIAL_UNAVAILABLE'|'ENDPOINT_INVALID'|'ENDPOINT_UNREACHABLE'}}. Only these allowlisted reasons are displayed; credential values and raw resolver exceptions never enter the response. Unknown mutation outcomes retain the original operation key and payload even if a later retry receives one of these validation errors.
For admin_ai_update, safe SQL reasons are LEGAL_UNAVAILABLE, FALLBACK_REQUIRED and INVALID_ROUTING_GRAPH. Disabled settings can be saved before routing is complete; enabling validates the common legal documents and all enabled rule memberships. Editing a field clears only a known failed operation's message; unknown outcomes remain locked to their original payload and key. Revision conflicts preserve the draft until the administrator refreshes and explicitly loads the newer state.
Context={ready:true,contract_code,database_instance_id,environment,member_id:decimal,control:{enabled,audience:'ALLOWLIST'|'ALL',revision,user_daily_limit,global_daily_limit,user_minute_limit},capabilities:{cv_schema_version:7,encrypted_envelope_version:1}}. Numeric control fields decimal strings.
admin_read input={contract_code,expected_environment,database_instance_id?:UUID,section:'configurations'|'rules'|'controls'|'usage'|'users'|'audit',kind?:string,id?:decimal,limit?:1..100,after?:opaque-string,days?:1..90,entity_kind?:string,entity_id?:decimal} => {context,data}.
- configurations kind configurations(default)|adapters|legal_documents. configs list/detail returns full aggregate with id,name,adapter_id,endpoint_url,model_id,credential_ref,legal_document_id,enabled,revision,price:Price; adapter {id:integer,name}; legal list/detail LegalDocument.
- rules kind rules(default), aggregate {id,weekday:int|null,start_minute:int|null,end_minute:int|null,enabled,revision,members:[{config_id,is_default}]}.
- controls => data:null.
- usage kind requests(default)|analytics; request detail is {request:<typed ledger>,snapshot:<frozen snapshot>,attempts:<typed facts>}; request lists are metadata summaries only.
- users kind accounts(default)|members|allowed_users; account limited Auth projection; members {id,auth_user_id,time_revoked,revision}; allowed_users {auth_user_id}.
- audit kind configurations|prices|rules|rule_members|runtime_control|allowed_users|documents|acceptances|members (default configurations); optional entity_id filter. Typed historical rows are flattened snake_case, no JSON old/new blobs.
Lists return {records:[...],next_cursor:string|null}; detail returns record; analytics {day_basis:'UTC_RESERVE_DAY',quota_day_basis:'UTC_PROVIDER_ADMISSION_DAY',global_quota:[...],configurations:[...]} grouped by frozen config audit and currency.
admin_context() => Context retained for POST preflight.
admin_configuration_save input += {id:decimal|null,expected_revision:decimal|null,name,adapter_id,endpoint_url,model_id,credential_ref,legal_document_id,enabled,price:Price} => Receipt. Always atomic config+price; expected legal scope checked inside TX.
admin_rule_save input += {id:decimal|null,expected_revision:decimal|null,weekday:int|null,start_minute:int|null,end_minute:int|null,enabled,members:[{config_id,is_default}]} => Receipt. Atomic parent+members. No is_fallback field.
admin_ai_update input += {expected_revision,enabled,audience,user_daily_limit,global_daily_limit,user_minute_limit} => Receipt. Enabling validates all active rules/legal/prices/credential structure; no validation/readback records. admin_ai_disable input += {expected_revision} => Receipt; emergency disable deliberately ignores a stale expected_revision, while retaining identity/instance/operation guards.
admin_allowed_user_set input += {expected_revision,auth_user_id,allowed:boolean} => Receipt.
admin_member_grant input += {auth_user_id,expected_revision:decimal|null} => Receipt; admin_member_revoke input += {id,expected_revision} => Receipt. Last-active guard retained.
admin_legal_document_save input += {id:decimal|null,expected_revision:decimal|null,kind,zh_title,en_title,zh_body,en_body,effective_date,recipient_name:null|string,adapter_id:null|1|2|3,endpoint_url:null|string,model_id:null|string,enabled} => Receipt (owner/Admin gated; no UI editor required now).

## Owner/local lifecycle
admin.initialize(p_name text,p_admin_user uuid) => void, owner only; takes existing valid Auth user, initializes LOCAL/PREVIEW/PRODUCTION with new instance once, AI off. idempotent same values. Ordinary integration uses real Auth sign-in/session authorization; disposable privileged SQL fixtures remain explicitly synthetic.
ai.reconcile(p_limit integer default100), ai.retention_cleanup(p_limit integer default1000), ai.register_jobs() owner-only. Jobs `cv-ai-reconcile` (`* * * * *`) and `cv-ai-retention` (`17 3 * * *`, environment pg_cron timezone) are registered inactive. Retention removes finalized request/attempt/snapshot facts after 90 days and minute counters after two days; unknown/held requests remain available for settlement.
