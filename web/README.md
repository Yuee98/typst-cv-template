# Typst CV Builder

Next.js editor for structured CV data and the shared Typst template. The server build includes Admin and AI routes for Vercel; the GitHub Pages export keeps the editor and authenticated cloud interfaces without those server routes.

## Development and builds

Use Node 24 and the workspace's pinned pnpm. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter web dev
pnpm typecheck
pnpm lint
pnpm test
pnpm build:server
pnpm build:static
pnpm --filter web assert:static-no-ai
```

Development and builds run `sync:typst-assets`, copying `style.typ` and installed Typst WASM assets into ignored `web/public/typst/`. Server/static output and generated routes are managed by `run-next-mode.mjs`; run builds serially. `pnpm --filter web test:admin-build-modes` verifies the two build modes together.

## Current database and local initialization

The current contract is `cv_app_db_1`. See the [database design](../docs/database-rebuild-design.md), [implemented RPC contract](../docs/database-contract.md), [implementation plan](../docs/database-rebuild-plan.md) and [hosted cutover runbook](../docs/database-rebuild-runbook.md). Four frozen baseline migrations create 31 private business tables; appended migrations add owner audit and administrator deletion protection, secure deferred validation, switch DeepSeek to Responses, and add Gemini Interactions with new legal content. `baseline_digest` covers the first four files; `migration_manifest_digest` covers all eight current files. `public` contains read-only invoker views and explicitly granted RPCs; [generated public types](src/lib/supabase/database.types.ts) and shared Zod contracts define the client boundary.

CV content is v7. Encryption envelope version 1 is the sole current AES-GCM format. JSON imports, local documents, drafts, plaintext cloud writes and decrypted content reject old or incomplete formats. No old storage-key recovery, content conversion or RPC fallback exists. A failed read preserves the existing document instead of silently saving an empty replacement.

Start Docker and the local Supabase stack before running database tests:

```sh
pnpm supabase:start
pnpm exec supabase db reset --local --no-seed --yes
pnpm exec supabase test db --local
pnpm --filter web test:db
```

`db reset --local` replaces only the selected local development database. SQL tests use rollback-only fixtures. The Data API suite verifies real Auth, permissions, account isolation, revision conflicts and current-format writes; it creates disposable local users. The runner refuses hosted endpoints and incomplete test credentials. Set `DB_TESTS_REQUIRED=1` when a missing local stack must fail the gate rather than report `SKIP`; CI already does this. `pnpm test:integration` runs the required local database gate and sends no paid provider requests.

For interactive local use, create/confirm an Auth account, then initialize the environment atomically as owner:

```sh
node scripts/db-initialize.ts --local --environment=LOCAL --admin-user=<confirmed-auth-uuid>
```

Run that command from the repository root. The helper only accepts local execution. It installs the environment identity, first administrator and current legal pointers together; it never grants Admin through signup or `user_metadata`. The owner locks an existing, undeleted and unbanned Auth target with `FOR KEY SHARE` before initialization. Repeating initialization verifies the same result rather than choosing a new first administrator. Bootstrap and owner publication of legal current targets write atomic SYSTEM audit events with a NULL actor; the target administrator is recorded as a target. Exact replays add no duplicate audit. Runtime starts disabled with no policy or fabricated consent. Subsequent administrator changes use the current member management flow.

Copy `.env.example` to `web/.env.local` and set the local public URL/key, service credential and `ADMIN_ENVIRONMENT=local` for the server build. Provider profiles reference `AI_PROVIDER_KEY_DEEPSEEK_*`, `AI_PROVIDER_KEY_MIMO_*` or `AI_PROVIDER_KEY_GEMINI_*`; key values remain in the server environment. `NEXT_PUBLIC_AI_POLISH_ENABLED` controls feature visibility, `AI_POLISH_ENABLED` is the deployment gate, and `ai.runtime_control` controls admission. The actual candidate set, model, price and default option come from published database configuration.

## Admin and legal operations

Sign in at `/en/admin` or `/zh/admin`. An ordinary Auth account receives no Admin access. The Overview security panel supports new TOTP enrollment and renewed verification of an existing factor; publishing, retirement, price changes, runtime reopening and membership changes require recent TOTP/AAL2. Emergency AI disable remains available to a valid administrator without step-up.

Provider defaults and profile/policy identities are mutable; versions are immutable after creation. Profiles and Policies offer separate identity/version lists. Users offers Accounts and Administrators lists, and member details expose the current revision needed to revoke or restore membership. Version details expose their parent revision for lifecycle actions; do not substitute the runtime control revision. Active administrators have a private generated Auth FK with `ON DELETE RESTRICT`: revoke membership before deleting the Auth account. Revoked membership keeps its historical UUID, and the generated linkage is excluded from Admin responses.

Configure profiles, prices and a policy in dependency order. Forms use explicit scalar fields and JSON advanced inputs for adapter configuration, price components, options and rules. A policy version submits its full options, per-period membership and default option atomically; fallback and future periods are part of the same version. Price amounts are decimal strings in nanos per million tokens. Atomic price replacement takes new price parameters and closes/publishes at one database instant, without a separately pre-created successor ID.

In Runtime controls, validate each target, publish its version, select the published policy while disabled, then check the selected policy before reopening to the allowlist. The checks inspect every option in every period, including nondefault options. Validation reports expire within 10 minutes and readbacks within 5, shortened to the next relevant price boundary; changed dependencies invalidate them. A check observes configuration and credential presence without sending a provider request. It does not prove that an upstream currently accepts the key.

The ordinary Terms page, AI Terms page and acceptance dialog read the target database's current content. AI consent covers common AI terms plus the selected provider's exact disclosure; switching options updates that target. Signup/OAuth never automatically creates current consent from a static historical version. All account-owned operations use a fixed verified JWT and current database instance guard. A response lost during an Admin mutation retains the same form payload/key for retry; keep that form open until its result is resolved.

## Browser verification

Install the pinned Chromium browser once:

```sh
pnpm --filter web test:e2e:install
```

The editor journey uses the real server build on HTTP loopback port `4173` with hosted credentials neutralized. It checks Admin-to-editor referrer isolation, current local CV editing, reload recovery, keyboard section reordering, locale switching and downloaded JSON validation:

```sh
pnpm --filter web test:e2e
```

The Admin journey uses the same port and requires the local Auth/Data API stack with AI disabled:

```sh
pnpm --filter web test:e2e:admin
```

Its launcher detects only the local Supabase endpoint, builds the server with provider credentials suppressed, creates two fixed local test accounts, temporarily grants fixture Admin membership and cleans them afterwards. It verifies an ordinary user's denial, real authenticated profile creation, actual TOTP verification followed by a high-risk membership grant, current member revision display, and both languages of the current database Terms and provider disclosures. Existing LOCAL environment initialization is reused. Run both browser suites serially because they share port/build output. Use the Admin wrapper, which removes temporary browser output containing possible MFA enrollment material; its trace/video/screenshots are disabled. The general editor suite retains its usual CI failure artifacts.

The independent Provider selection journey uses a real Next HTTP server with the existing paired fake runtime, a test-only server/browser clock fixed in the A/B period, and Playwright-intercepted Auth/Data API at the unused loopback origin `http://127.0.0.1:54329`:

```sh
pnpm --filter web test:e2e:provider-choice
```

It logs in a synthetic account, selects nondefault MiMo, verifies that changing provider clears the checkbox, records only MiMo’s exact disclosure, rereads the accepted state before sending, and checks the actual HTTP result and browser preview. No provider key is inherited or loaded; the launcher reuses the environment isolation helper. Unknown or external browser requests are blocked and fail the test. This mocked browser/fake HTTP journey proves UI sequencing and payloads; it does not prove hosted Auth, SQL permissions or paid upstream execution. Run it serially with the other suites because it shares the build and port `4173`. The ordinary credential-free suite ignores this independent spec.

Tests for one module sit beside that module. Larger behavioral suites and shared fixtures use feature-scoped `__tests__/<feature>/` directories without marking support modules as tests.

## Explicit local tests with real Providers

Ordinary unit, database and browser suites never load Provider keys or send paid requests. To deliberately test the current runtime against the supported official APIs, start the local Supabase stack, place the raw keys in `~/.keys/.deepseek.local.key` and `~/.keys/.mimo.local.key`, and Google in `~/.keys/.gemini.local.key`. The default command selects all three and requires all three keys; use the Google-only command below for an incremental check without repeating the earlier paid calls:

```bash
pnpm --filter web test:providers:live
```

`CV_LIVE_DEEPSEEK_KEY_FILE`, `CV_LIVE_MIMO_KEY_FILE` and `CV_LIVE_GEMINI_KEY_FILE` can select alternative key files. `CV_LIVE_PROVIDERS=GEMINI` selects only Google, so adding Google need not repeat the previous paid Provider checks:

```bash
CV_LIVE_PROVIDERS=GEMINI pnpm --filter web test:providers:live
```

Single-provider evidence goes to `tmp/provider-live-<provider>-smoke.json` (for example `provider-live-gemini-smoke.json` or `provider-live-mimo-smoke.json`); the default full run uses `tmp/provider-live-smoke.json`. These are explicit paid tests; neither command verifies the project billing tier or data-sharing policy. Before real CV use, the owner must separately verify active Cloud Billing and sharing/dataset settings as described in the [legal source record](src/content/legal/ai-terms-sources.md). Secret values remain in memory and are never written to the database, repository, logs or evidence. This command is explicitly opt-in and refuses CI/hosted execution; neither normal test config includes `test/live/`, and no workflow invokes it.

The smoke checks model availability, clones only the local database into a dedicated disposable database, creates synthetic legal content and published profile/price/policy versions through the current Admin RPCs, validates all candidates and readback, accepts the exact disclosures, and selects each Provider explicitly. It runs the production `executePolish`/transport/validator against real HTTPS inference, checks durable usage, user charging, frozen-price arithmetic and replay without a second send, then drops the temporary database. The normal local database is not reset or configured by this smoke. The local SQL bridge supplies synthetic Auth context; it does not replace the separate real Auth/HTTP/browser tests or prove hosted deployment.

DeepSeek and MiMo use Responses: DeepSeek `https://api.deepseek.com/responses` and MiMo `https://api.xiaomimimo.com/v1/responses`. Google uses native stable Interactions at `https://generativelanguage.googleapis.com/v1/interactions` with explicit interaction-storage opt-out, low thinking and JSON schema, without an OpenAI compatibility fallback. Current smoke models are `deepseek-flash`, `mimo-v2.6-flash` and `gemini-3.8-flash`. Each receives one short synthetic English resume item, no references, with at most two generation attempts per Provider and a hard 2048 output-token ceiling per attempt. There is no outer automatic rerun. The real accounts may be charged by their Providers; the database prices are deliberately synthetic to verify accounting and do not represent the upstream invoice. Sanitized evidence uses the ignored selected-run path described above.

## Metrics and deployment boundary

The repository and web roots both contain a Vercel Git configuration that disables automatic deployments only for `codex/database-rebuild`. This keeps review pushes from publishing an app while the hosted databases still use the old contract. Main/release must still follow the separate cutover authorization and maintenance gates below.

`pnpm metrics:ai` reads current `admin_analytics` with `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_ADMIN_ACCESS_TOKEN`. It preserves native currencies and unknown usage/cost facts, and does not print credentials or request content. `pnpm --filter web smoke:api` is a local fake-mode HTTP check for an already running server; paid hosted smoke belongs to a separately authorized cutover.

The manual rebuild workflow defaults to read-only plan and has no push/PR/schedule trigger. Hosted and rehearsal targets use only `application_allowlist`, defined by [the retired object inventory](../scripts/database-retired-objects.json) and [application cleanup SQL](../supabase/retired-application-reset.sql). Evidence and durable intent must match that method, the cleanup SQL/inventory digests and both migration digests; resume applies only missing phases or appended migrations. A missing checkpoint never authorizes another cleanup. Use the runbook’s plan/rebuild/resume flow rather than a native remote reset command. The workflow receives `rehearsal_evidence` as JSON and writes a temporary proof file; its source SHA must equal the checked-out full SHA. Commit the candidate first, then rehearse that SHA and supply the generated proof or CI artifact without committing a self-referencing proof.

In this task’s isolated local rehearsal, native Supabase CLI `2.109.0 db reset --db-url` removed the fixture Auth users, sessions and MFA data. This observation is limited to that version and environment. The allowlist rehearsal passed the old-60-to-four-baseline rebuild, interruption recovery, repeated resume, same-instance fifth through eighth migration upgrades and equality of all 12 platform fingerprints. Missing checkpoint, including missing history together, correctly refused another rebuild. A separately constructed `reset_started` checkpoint resumed with matching method/digests/live catalog and preserved the instance and audit sentinel. This is a constructed fault test, not a claim of killing the process inside cleanup: the proof records `constructed_checkpoint_recovery_passed=true` and deliberately leaves `checkpoint_loss_recovery_passed=false`. Local reset, role tests, Auth/Data API tests, both build modes, the editor journey and the Admin journey have also been exercised. Explicit local live smoke has passed one Responses generation request each to DeepSeek and MiMo, followed by a separate Gemini Interactions request after the eighth migration, with synthetic text and isolated database settlement. No test/prod SQL or database reset, hosted configuration change, promotion or online deployment has been performed. The local proof is `tmp/remote-rehearsal-proof.json`; final evidence bound to the actual merge SHA and hosted G10/G11 remain release prerequisites. These local evidence snapshots precede PR publication; current CI results must be read from checks and artifacts for the exact PR head.
