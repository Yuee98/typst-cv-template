# Admin development ledger

Main feature branch: `codex/admin-control-plane`, based on `main@2783057292cef4ba3889d6bded31ce7863b2270f`. Accepted plan: [implementation plan](admin-control-plane-implementation-plan.md), reviewed SHA `ecba8af39b47f5c84c9486684ed4c106bc4b5f0ab74df76cf5a297a327bcba4f`.

The user authorized implementation, asynchronous development checkpoints in Relay session `6a994932-0c0c-83e8-ba9b-878517117977`, and one economical subagent when useful. Development checkpoints do not consume the final convergence budget. Continue independent implementation while a checkpoint runs; reconcile applicable findings into the same ledger. Final artifact convergence remains a separate, bounded review. Merge into main remains user-owned.

Keep a linear feature history. Workers own disjoint files in the shared checkout; the main agent creates focused commits. If a separate development branch is needed, rebase it onto the feature branch and fast-forward integrate; avoid merge commits. Never rewrite another user's branch or include unrelated `.claude/` / `.pnpm-store/` files.

| Package | Status | Evidence |
| --- | --- | --- |
| I01 contracts | in progress | successor contracts, API DTOs and portable vectors |
| I02 read-only foundation | implemented, checkpoint verification | 7 real Auth/DB tests; server/static route builds; static artifact scan; anonymous dynamic detail browser check |
| I03 Provider binding schema | in progress | additive v2 schema applied locally; 15 focused DB tests; v1 rows and authority roots preserved |
| I04 dual runtime | in progress | strict v1/v2 parser and prepared Provider transports; synthetic DeepSeek/MiMo transport tests; lifecycle wiring remains dark |
| I05–I10 | pending | dependent on the dual runtime and evidence contracts |
| I11 optional probe | deferred release | separate full lifecycle gate |
| I12 environment release | pending | hosted identity/authorization reviewed before mutation |

No hosted migration, real Provider call, secret rotation, deployment promotion or main merge has been performed by this implementation run.

## Checkpoints

| Checkpoint | Artifact | Relay task | Findings |
| --- | --- | --- | --- |
| CP1 | PR #37, `111725b2a7647ef3c06cec0c0f6341aadc29a4c7`; I02 read-only boundary and contract drafts | `d2fe3afb-8c35-4159-b071-a2963a4c2ed9` | acknowledged/in progress; development continues with I03/I04 without duplicate submission |

Local foundation verification (2026-09-04): existing local DB advanced from `20260824009000` by `migration up --local`, without reset. Full unit suite: 1,758 passed, one existing skipped. Seven focused DB tests cover bootstrap/grants, metadata forgery, bearer forwarding, projection/pagination, revoke/ban/environment/session invalidation and audit/delete invariants. Server and static builds passed; the static scan inspected 135 files. An actual dynamic `/zh/admin/profiles/<uuid>` route displayed the login page with no browser console error. Subsequent UI integration fixes (search submission, environment badges, responsive nav) are validated again before the checkpoint commit. No hosted operation or Provider transmission occurred.

The first exact-head CI run found two bounded foundation defects. CodeQL rejected a mobile navigation value that was cast from a DOM string before URL construction; navigation now resolves every section through a literal route map and rejects unknown values. The real-DB fresh-reset suite correctly detected seven new SQL routines outside its frozen authority inventory. The successor inventory now binds each approved routine by schema, name, identity arguments, kind, canonical definition hash and explicit role ACL, while the original 375-routine authority root remains unchanged. Focused CodeQL-path unit coverage and the corrected authority assertion pass locally.

I03/I04 local progress (2026-09-04): migration `20260904000000_ai_provider_binding_v2_expand.sql` adds an adapter catalog, stable Provider identities and a strict `profile_execution_config_v2` branch without activating a v2 route or rewriting an existing execution row. Endpoint URL, `AI_PROVIDER_KEY_*` variable name and model ID are frozen on each successor profile version. The runtime validates the catalog-selected adapter against compiled support, exact official destination policy, a deployment binding manifest and a filtered secret namespace before constructing a branded transport. Synthetic transport tests prove long configured model IDs reach both request formats and retain existing usage/cost normalization. Existing v1 adapter and contract tests continue to pass. Reservation, attempt and legal/runtime evidence wiring remains intentionally dark until the next implementation step.
