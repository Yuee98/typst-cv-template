# Admin development ledger

Main feature branch: `codex/admin-control-plane`, based on `main@2783057292cef4ba3889d6bded31ce7863b2270f`. Accepted plan: [implementation plan](admin-control-plane-implementation-plan.md), reviewed SHA `ecba8af39b47f5c84c9486684ed4c106bc4b5f0ab74df76cf5a297a327bcba4f`.

The user authorized implementation, asynchronous development checkpoints in Relay session `6a994932-0c0c-83e8-ba9b-878517117977`, and one economical subagent when useful. Development checkpoints do not consume the final convergence budget. Continue independent implementation while a checkpoint runs; reconcile applicable findings into the same ledger. Final artifact convergence remains a separate, bounded review. Merge into main remains user-owned.

Keep a linear feature history. Workers own disjoint files in the shared checkout; the main agent creates focused commits. If a separate development branch is needed, rebase it onto the feature branch and fast-forward integrate; avoid merge commits. Never rewrite another user's branch or include unrelated `.claude/` / `.pnpm-store/` files.

| Package | Status | Evidence |
| --- | --- | --- |
| I01 contracts | in progress | successor contracts, API DTOs and portable vectors |
| I02 read-only foundation | implemented, checkpoint verification | 7 real Auth/DB tests; server/static route builds; static artifact scan; anonymous dynamic detail browser check |
| I03–I10 | pending | dependent on foundation contracts |
| I11 optional probe | deferred release | separate full lifecycle gate |
| I12 environment release | pending | hosted identity/authorization reviewed before mutation |

No hosted migration, real Provider call, secret rotation, deployment promotion or main merge has been performed by this implementation run.

## Checkpoints

| Checkpoint | Artifact | Relay task | Findings |
| --- | --- | --- | --- |
| CP1 | I01 contracts and first read-only boundary | not submitted | pending |

Local foundation verification (2026-09-04): existing local DB advanced from `20260824009000` by `migration up --local`, without reset. Full unit suite: 1,758 passed, one existing skipped. Seven focused DB tests cover bootstrap/grants, metadata forgery, bearer forwarding, projection/pagination, revoke/ban/environment/session invalidation and audit/delete invariants. Server and static builds passed; the static scan inspected 135 files. An actual dynamic `/zh/admin/profiles/<uuid>` route displayed the login page with no browser console error. Subsequent UI integration fixes (search submission, environment badges, responsive nav) are validated again before the checkpoint commit. No hosted operation or Provider transmission occurred.
