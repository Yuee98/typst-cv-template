# Typst CV Builder

Static Next.js app for editing structured CV data and previewing the shared Typst template in the browser.

## Scripts

Run from the repository root:

```powershell
pnpm --filter web dev
pnpm --filter web build
pnpm --filter web lint
pnpm --filter web typecheck
```

`dev` and `build` run `sync:typst-assets` first. The sync script copies the root `style.typ` and the typst.ts WASM files into `web/public/typst/`, which is intentionally ignored because those files are generated from the workspace and installed packages.

## AI polish local smoke & metrics

Local-only tooling for the AI polish API. `test:integration` proves the real
chain (real DeepSeek key + real local Supabase, no fake flags) end to end;
`metrics:ai` inspects the ledger and the global cost circuit breaker. Neither
runs in CI — real API calls cost money — and `test:integration` refuses to
start when `CI=true`.

### Environment (web/.env.local, git-ignored — never commit)

| Variable | Where to get it |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `supabase status` → Project URL (local: `http://127.0.0.1:54321`) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `supabase status` → Publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | `supabase status` → Secret key |
| `DEEPSEEK_API_KEY` | DeepSeek console (real key — billed per token) |
| `AI_USER_ID_HMAC_SECRET` | generate locally, e.g. `openssl rand -hex 32` |
| `AI_POLISH_ENABLED` | set to `true` (deployment switch checked by the smoke) |

The DB-side runtime switch (`ai_feature_config.ai_polish_enabled`) must also
be `true`; the smoke enables it via the service role when it finds it off
(test:db restores the post-migration `false` default after every run) and
puts the original value back during cleanup.

### Real-key integration smoke

```powershell
pnpm supabase:start        # repo root, once
pnpm test:integration      # or: pnpm --filter web test:integration
```

The script builds the server bundle if missing, starts `next start`, creates a
one-off user, signs in through the real gotrue password grant, then asserts:
401 without/with a fake token, 403 before AI-terms acceptance, 200 after
acceptance (result ids match the targets, polished text non-blank), ledger
settlement (`state=finalized`, `status=succeeded`, `quota_charged=true`,
`attempt_count>=1`, `latency_ms` recorded, `usage_complete=true`), the
`ai_usage_daily` +1, a 409 when resending the same `clientRequestId`, and the
cancel-while-in-flight settlement (`status=canceled`, `quota_charged=true`,
`failure_stage=canceled`, `provider_billable=null` — billability is unknown
when the abort lands mid-flight; the lifecycle treats both `AbortError` and
Next.js's client-disconnect `ResponseAborted` as user cancellation). It finishes with
a cache diagnosis line (`input_cached_tokens` vs `input_uncached_tokens`,
diagnostic only) and a provider-call/token/cost report, then deletes the test
user and stops the server.

Cost discipline: every request uses one very short item and the whole run
makes at most 2 provider transmissions (budget assertion: ≤4), keeping a full
smoke within a fraction of a RMB cent.

### Metrics and the global cost alert

```powershell
pnpm metrics:ai                     # last 24h from ai_request_ledger
pnpm metrics:ai -- --hours=48       # custom window
pnpm metrics:ai -- --no-alert       # never exit non-zero
```

Prints request volume by status, p50/p95 latency of succeeded rows, retry
rates (succeeded vs failed), invalid-output rate, DeepSeek context-cache hit
rate and token usage. It then compares today's `ai_global_usage_daily` against
`ai_feature_config.global_daily_limit`: ≥80% prints `ALERT` and exits 1, ≥100%
prints `CRITICAL` and exits 2 (`--no-alert` keeps exit 0). This is a
local/manual inspection alert only; wiring alerting into an online channel is
a post-roadmap item.

## Vercel

Use the repository root as the Vercel root directory.

- Build command: `pnpm --filter web build`
- Output directory: `web/out`
