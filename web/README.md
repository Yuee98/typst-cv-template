# Typst CV Builder

Next.js app for editing structured CV data and previewing the shared Typst template in the browser. It has a server build for Vercel and a separate static export for GitHub Pages.

## Scripts

Run from the repository root:

```powershell
pnpm --filter web dev
pnpm --filter web build
pnpm --filter web lint
pnpm --filter web typecheck
pnpm --filter web test:e2e
```

`dev` and `build` run `sync:typst-assets` first. The sync script copies the root `style.typ` and the typst.ts WASM files into `web/public/typst/`, which is intentionally ignored because those files are generated from the workspace and installed packages.

### Test layout

Keep a one-to-one unit test next to its production module. When one feature needs multiple behavioral suites or shared test support, group those files under a feature-scoped `__tests__/<feature>/` directory; name support modules `fixtures` or `harness` without a `.test` suffix.

### Local server-mode browser E2E

The Chromium workflow exercises the real Next server build on the fixed loopback port `4173`. It creates and edits a local CV, verifies reload recovery, moves a section with keyboard drag-and-drop without changing the selected editor tab, switches locale, and validates the downloaded JSON schema. It runs with fake polish flags and empty Supabase/DeepSeek variables; it does not require or use `web/.env.local`, hosted credentials, or `/api/polish` requests.

Install the pinned browser once, then run the journey from the repository root:

```powershell
pnpm --filter web test:e2e:install
pnpm --filter web test:e2e
```

On CI, failures retain Playwright traces, screenshots, videos, and the HTML report as the `web-e2e-artifacts` workflow artifact.

## AI polish local smoke & metrics

Local-only tooling for the AI polish API. `test:integration` proves one selected
real profile (`deepseek` or `mimo`) against real local Supabase, with no fake
flags, end to end;
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
| `MIMO_API_KEY` | MiMo console; required only for `test:integration -- --profile mimo` |
| `OPENROUTER_API_KEY` | Future optional server-only alias; leave unset for the initial route |
| `AI_USER_ID_HMAC_SECRET` | generate locally, e.g. `openssl rand -hex 32` |
| `AI_POLISH_ENABLED` | set to `true` (deployment switch checked by the smoke) |

The database is the runtime authority for the provider/profile version, exact price version, routing policy, legal bundle, and runtime-contract ID/hash; the server freezes that route before a transmission. `DEEPSEEK_API_KEY` and `MIMO_API_KEY` only satisfy code-registered credential aliases and cannot activate a route by themselves. `OPENROUTER_API_KEY` is deliberately future optional, not initial-route enablement. Never add `AI_PROVIDER`, `AI_MODEL`, or `AI_BASE_URL` as application routing switches: those would bypass DB validation, audit, canary, and legal controls. No key belongs in browser code, database rows, logs, ledger data, or error payloads.

The DB-side runtime switch and the exact selected route must already be
prepared by a separate local driver. The smoke never activates a profile,
policy, price, or feature switch; it fails closed unless authenticated
availability exposes the selected frozen route.

### Real-key integration smoke

```powershell
pnpm supabase:start        # repo root, once
pnpm test:integration      # defaults to DeepSeek
pnpm test:integration -- --profile mimo
```

The script **rebuilds the server bundle by default every run** (testing the
current head; `--reuse-build` is an explicit iteration-only opt-in), starts
`next start`, creates a one-off user, signs in through the real gotrue
password grant, obtains an authenticated availability candidate, derives the
strict `expected_route_v1` assertion from it, then asserts:
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
user (and **verifies** the cascade left zero rows in `ai_request_ledger` /
`ai_usage_daily` / `ai_rate_minutes` / `user_terms_acceptances`) and stops the
server.

Release-gate integrity: the run refuses a non-loopback
`NEXT_PUBLIC_SUPABASE_URL` and any mismatch with the URL/keys reported by
`supabase status` (it mutates smoke users and their terms acceptance with the service key — never a
hosted project); build and start both get explicit `POLISH_FAKE_LLM=false` /
`POLISH_FAKE_BACKEND=false` / `CI=false`; only the selected provider credential
is forwarded; and fake, proxy, custom, or cross-profile upstream configuration
is rejected. It proves only the exact official DeepSeek Chat Completions or
MiMo Responses endpoint frozen in the selected profile. Availability is checked
again after terms acceptance and before cancellation; any route drift fails the
run before another provider transmission.

Cost discipline: every request uses one very short item; the run makes 2
user-visible polish requests (one success, one canceled) and each may use up
to 2 internal provider attempts — budget assertion ≤4 transmissions, typical
2. Parent and immutable attempt evidence must match the selected profile,
allowed frozen price version, combined/legacy runtime, gateway, wire API,
model, CNY currency, and exact official endpoint.

### Metrics and the global cost alert

```powershell
pnpm metrics:ai                     # last 24h from ai_request_ledger
pnpm metrics:ai -- --hours=48       # custom window
pnpm metrics:ai -- --no-alert       # never exit non-zero
```

Prints request volume by status, p50/p95 latency of succeeded rows, retry
rates (succeeded vs failed), invalid-output rate, DeepSeek context-cache hit
rates (all complete rows with input usage, plus the succeeded subset) and
token usage split by accounting completeness: known cost over all finalized
rows with recorded usage, the `usage_complete=true` subset, and the known
lower bound from incomplete rows (pages deterministically through the whole
window — Supabase caps a single page at 1000 rows). It then compares today's
`ai_global_usage_daily` against
`ai_feature_config.global_daily_limit`: ≥80% prints `ALERT` and exits 1, ≥100%
prints `CRITICAL` and exits 2 (`--no-alert` keeps exit 0); a configured
`global_daily_limit` of 0 prints a prominent NOTICE (the provider gate
rejects everything — deliberate config, not an idle day). This is a
local/manual inspection alert only; wiring alerting into an online channel is
a post-roadmap item.

## Hosting

Vercel must use the server build:

- Root Directory: `web`
- Framework Preset: `Next.js`
- Build Command: `pnpm build:server`
- Output Directory: leave unset; Next.js owns `.next/`
- Production Branch: `release` (`main` is the canonical staging Preview)

GitHub Pages is deployed separately by `.github/workflows/promote-release.yml` from `pnpm build:static`; its artifact is `web/out` and contains no AI routes or UI entry point. See the root `README.md` / `README_CN.md` deployment-topology section for the Vercel and Supabase environment matrix, feature-gate semantics, and staged rollout procedure.
