# Admin API contract v1

Status: implementation contract. Supersedes no existing AI execution or legal evidence. The accepted implementation plan defines release gates; this document fixes the application boundary used by I02 onward.

## Authentication and environment

Admin pages are generated only for server builds at `/{zh,en}/admin`. Pages initially render a content-free login/shell; all data uses bearer-authenticated `no-store` requests to `/api/admin`. The existing password/GitHub Supabase session is reused. Responses never contain tokens, Auth internals, Provider key material, CV text, prompts or outputs.

Every API request verifies its bearer using `auth.getUser(token)` and creates a request-scoped publishable-key client with the same bearer Authorization for RPC. `getUser` does not install a session. The RPC derives actor from `auth.uid()`, requires an authenticated, non-anonymous JWT, a live matching Auth session and an active administrator whose Auth account is confirmed, not banned or deleted. No user metadata role is trusted. DB helpers have fixed empty search paths and no PUBLIC execute grant.

`ADMIN_ENVIRONMENT=local|preview|production` and the Supabase URL identify the server's intended environment. An owner-initialized `admin_environment` row stores environment, project ref and exact Auth issuer. The server passes its expected environment/ref; the DB compares these and the verified JWT issuer. Local URL uses project ref `local`; hosted URLs must be canonical `<ref>.supabase.co`. Preview and Production use distinct projects. The user JWT does not attest a Vercel instance: build/binding claims come from registered deployment evidence and the trusted report producer.

`admin_principals` holds current membership and revision. Membership changes and business mutations serialize on the environment singleton before checking/locking actor membership. Audit actor IDs are historical values, without cascading Auth foreign keys. User deletion cannot remove an active administrator through Auth service_role; first revoke through the controlled path, preserving the last-admin invariant.

## Read RPCs and safe projections

All three RPCs below are SECURITY DEFINER, granted only to authenticated; direct invocation performs the same DB checks. Service_role cannot use them as an administrator without a genuine user JWT.

| RPC | Parameters | Return |
| --- | --- | --- |
| `admin_get_context_v1` | `p_environment text, p_project_ref text` | `admin_context_v1` |
| `admin_list_records_v1` | environment/ref, `p_section text, p_limit integer=25, p_after text=null, p_search text=null` | `admin_page_v1`, approved section-specific rows |
| `admin_get_record_v1` | environment/ref, `p_section text, p_id uuid` | approved entity record or not found |

Read sections initially include users, profiles, prices, policies and audit. Provider and analytics sections appear only when their actual catalog/query capabilities ship. Cursor pagination is by immutable ID (audit UUID plus timestamp ordering will use a typed cursor when added); bounded page size 1–100, search at most 100 characters. Reject unknown sections, invalid UUID cursors, unknown query keys and oversized parameters before querying. User email is confined to Users. Configuration IDs/aliases belong only to configuration detail; Audit exposes approved public event metadata and typed safe changes. No `select *` JSON serialization or raw ledger/event payload.

The browser contract lives in `web/src/lib/admin/contract.ts`; strict schemas reject extra fields. Environment/control revisions are decimal strings, never lossy JSON bigint numbers. Missing observations are null rather than zero. Feature global limit is calls/day, not currency. A legacy control-plane mode exposes read-only capabilities.

## Mutation kernel (I06/I07)

Each typed mutation has reason, idempotency UUID, expected target revision and its typed payload. The DB computes canonical payload identity. Actor/environment checks plus membership serialization precede the operation lookup; an already committed same-payload operation returns its original result before target state, expected revision, report expiry or original step-up checks. Revoked actor cannot read it. Different payload rejects. Only an absent operation proceeds to lock target/control/candidate, verify current TOTP/evidence/state and atomically commit domain data, audit and operation result. No durable pending/failed row is promised for rolled-back synchronous transactions.

TOTP high-risk authority requires a live session, current verified factor, JWT AAL2 and a recent TOTP AMR timestamp (10 minutes). First enrollment, replacement, factor withdrawal and signout are explicit local Auth test cases. JWT refresh is not reauthentication. One-way emergency disable requires current admin but no step-up. All new mutations remain dark until the separate DB013 privilege cutover.

Read-only helpers and mutations take the same membership serialization lock order. AI mutation suffix follows existing config → policy → runtime → profiles ordered by UUID → prices ordered by UUID → quota/ledger. Network operations run outside DB transactions. Apply state/evidence checks again in the new-mutation branch at commit.

## Producer grants and control cycle

Authenticated admin mutation RPCs can reference report/evidence IDs, never create reviewed source/legal authority or assert a passed report. Narrow report-record RPCs are service_role-only; source/legal/build import and first-admin bootstrap are DB-owner-only. No direct DML is restored to the application roles.

Pointer set/clear/rollback requires DB gate off and expected generation. A separate closing cycle and control revision bind trusted readback. Reopen requires latest cycle/pointer/current legal bundle/build/binding/evidence; it is a separate step-up mutation. Legal current switch is an owner operation, atomically clearing old pointer before changing current while gate is off. Candidate validation of a future sealed bundle does not admit user requests.

The authority cutover revokes the old DB013 operator signatures and direct UPDATE of `public.ai_feature_config.(ai_polish_enabled,global_daily_limit,enabled_user_allowlist)`, preserves protected data-plane lock privileges, then enables new JWT operations. External deployment/CLI readiness is verified before the transaction; the transaction only asserts DB records. Post-cutover rollback builds must support both execution generations and the new Admin protocol.

## Error and cache contract

Errors use `{ error: { code } }`: `UNAUTHORIZED` (401), `FORBIDDEN` (403), `ENVIRONMENT_MISMATCH` (403), `INVALID_REQUEST` (400), `NOT_FOUND` (404), `CONFLICT` (409), `STEP_UP_REQUIRED` (403), `NOT_READY` (409), `UNAVAILABLE` (503). No upstream exception messages, SQL statements, query payloads or credentials are echoed. All Admin data responses set `Cache-Control: private, no-store` and `Vary: Authorization`. UI clears its in-memory data on signout or user change. Server RPC is not gated by AI feature availability.
