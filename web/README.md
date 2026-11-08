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

The editor uses one responsive flex workspace and one form instance. Viewports narrower than 960px or shorter than 500px scroll as a page, with the library in an animated drawer and the preview below the expanded editor. At 960px wide and 500px high, editor and preview share bounded columns, including in square or tall windows; the toolbar and library keep their responsive menu behavior. The library docks only at 1440px wide, a minimum 4:3 aspect ratio and 500px height. The toolbar fits its translated content in one row when possible, with a borderless menu before the logo and the other buttons on the right. When it needs two rows, the brand occupies the first and the menu and actions share the second; in page flow the brand scrolls out naturally until only that control row remains pinned. Every viewport uses the same scrolling preview with all pages present: stacked panels are capped at the smaller of 70dvh and 48rem, while side-by-side panels fill the workspace. Touch inputs retain 16px text in the intermediate workspace. These conditions use available viewport space, not device detection. Resizing preserves the active editor tab and values; opening the drawer does not change the saved desktop collapse preference. Printing includes all preview pages.

## Current database and local initialization

The current contract is `cv_app_db_2`. See the [database design](../docs/database-rebuild-design.md), [implemented RPC contract](../docs/database-contract.md), [implementation plan](../docs/database-rebuild-plan.md) and [hosted cutover runbook](../docs/database-rebuild-runbook.md). Fifteen schema/stage migrations create 30 private business and typed-audit tables. `supabase/baseline.json` explicitly lists the baseline; `baseline_digest` covers that list and `migration_manifest_digest` covers the full chain. This unreleased rebuild directly removes the former TOTP design from those files. `public` contains read-only invoker views and explicitly granted RPCs; [generated public types](src/lib/supabase/database.types.ts) and shared Zod contracts define the client boundary.

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

Run that command from the repository root. The helper only accepts local execution. It atomically installs the environment identity and first administrator, requiring an existing valid Auth account. Signup and `user_metadata` never grant Admin. Repeating initialization verifies the same result rather than choosing a new administrator. Bootstrap writes typed SYSTEM audit records. Runtime starts disabled without service configurations or fabricated consent. Subsequent administrator changes use the current member management flow.

Copy `.env.example` to `web/.env.local` and set the local public URL/key, service credential and `ADMIN_ENVIRONMENT=local` for the server build. Configurations reference an existing `AI_PROVIDER_KEY_*` server environment variable by its exact name; key values remain on the server. `NEXT_PUBLIC_AI_POLISH_ENABLED` controls feature visibility, `AI_POLISH_ENABLED` is the deployment gate, and `ai.runtime_control` controls admission. Current configurations, prices and time-rule membership determine the available choices and default option. There is no publishing or retirement workflow.

## Admin and legal operations

Admin sections and details use soft navigation. Lists, details and analytics reuse account/project/token-epoch/instance-scoped memory data for 30 seconds; Controls reloads on entry. The BFF uses one verified user bearer and one `admin_read` RPC for the context and page, with private/no-store HTTP responses. Writes invalidate affected lists and refresh mounted related pages; every write retains live server/database authorization. Account, token, denied-access and instance changes clear the appropriate cache.

Sign in at `/en/admin` or `/zh/admin`. All reads and writes require a valid account, live Auth session and active administrator membership. Ordinary users and revoked/expired sessions remain denied. There is no TOTP enrollment, second-factor gate or security panel in the application.

The six sections are Configurations, Time rules, Runtime controls, Usage and requests, Users, and Audit. Lists open View/Edit dialogs. Adapters are read-only code-owned entries; each editable service configuration holds the actual endpoint, model, credential reference, matching disclosure, enabled state and four-rate price. Current state is editable, with each table's typed audit preserving history. Active administrators have a private generated Auth FK with `ON DELETE RESTRICT`: revoke membership before deleting the Auth account. The generated linkage is excluded from Admin responses.

Configuration and price save in one transaction and share a revision. A time rule saves its period, allowed configurations and one default together. Ordinary periods use Asia/Shanghai weekday/minute intervals; an all-NULL period is the fallback. Prices use native currency and four integer nanos-per-million rates, with decimal amounts shown in forms. There are no JSON advanced inputs or identity/version selectors.

Save service configurations and time rules, then set the audience and quotas in Runtime controls before enabling AI. Save-time checks verify exact disclosure scope, credential presence and a public HTTPS destination without sending an inference request. They do not prove the upstream currently accepts the key. There are no validation reports or readback tickets. Emergency disable persists cancellation for in-flight work; re-enabling cannot revive canceled requests.

The ordinary Terms and AI reading pages use current database documents or exact historical document-audit targets. Dialogs show short reminders and exact reading links; external document IDs, audit IDs and digests are checked before rendering. AI consent atomically covers the common terms and selected recipient's exact disclosure. There are no bundles or sealed manifests. Signup/OAuth never fabricates consent. All account-owned operations use a verified JWT and current database instance guard. A response lost during an Admin mutation retains the same form payload/key for retry, including when a later retry meets a transient validation error; keep that form open until its result is resolved.

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

Its launcher detects only the local Supabase endpoint, builds the server with provider credentials suppressed, creates two fixed local test accounts, temporarily grants fixture Admin membership and cleans them afterwards. It verifies ordinary-user denial, regular administrator sign-in followed by atomic configuration/price and rule saves, membership grant/revoke, both languages of exact legal reading targets, soft-navigation caching, write invalidation, denied-access clearing and guarded instance recovery. Existing LOCAL initialization is reused. Run browser suites serially because they share port/build output. The Admin wrapper removes temporary output; traces/videos/screenshots are disabled. The general editor suite retains its usual CI failure artifacts.

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

The smoke checks model availability, clones local schemas into a dedicated disposable database, creates synthetic legal content, current configurations/prices and time rules through current Admin RPCs, accepts the exact disclosures, and selects each Provider explicitly. It runs production `executePolish`/transport/validation against real HTTPS inference, checks durable usage, charging, frozen-price arithmetic and replay without a second send, then drops the temporary database. The normal local database is not reset or configured by this smoke. Its SQL bridge supplies synthetic ordinary-session Auth context; it does not replace real Auth/HTTP/browser tests or prove hosted deployment.

DeepSeek and MiMo use Responses: DeepSeek `https://api.deepseek.com/responses` and MiMo `https://api.xiaomimimo.com/v1/responses`. Google uses native stable Interactions at `https://generativelanguage.googleapis.com/v1/interactions` with explicit interaction-storage opt-out, low thinking and JSON schema, without an OpenAI compatibility fallback. Current smoke models are `deepseek-flash`, `mimo-v2.6-flash` and `gemini-3.8-flash`. Each receives one short synthetic English resume item, no references, with at most two generation attempts per Provider and a hard 2048 output-token ceiling per attempt. There is no outer automatic rerun. The real accounts may be charged by their Providers; the database prices are deliberately synthetic to verify accounting and do not represent the upstream invoice. Sanitized evidence uses the ignored selected-run path described above.

## Metrics and deployment boundary

The repository and web roots both contain a Vercel Git configuration that disables automatic deployments only for `codex/database-rebuild`. This keeps review pushes from publishing an app while the hosted databases still use the old contract. Main/release must still follow the separate cutover authorization and maintenance gates below.

`pnpm metrics:ai` reads `admin_read` usage analytics with `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `ADMIN_ENVIRONMENT` and `SUPABASE_ADMIN_ACCESS_TOKEN`. It preserves native currencies and unknown usage/cost facts, and does not print credentials or request content. `pnpm --filter web smoke:api` is a local fake-mode HTTP check for an already running server; paid hosted smoke belongs to a separately authorized cutover.

The manual rebuild workflow defaults to read-only plan and has no push/PR/schedule trigger. Hosted and rehearsal targets use only `application_allowlist`, defined by [the retired object inventory](../scripts/database-retired-objects.json) and [application cleanup SQL](../supabase/retired-application-reset.sql). Evidence and durable intent must match that method, the cleanup SQL/inventory digests and both migration digests; resume applies only missing phases or appended migrations. A missing checkpoint never authorizes another cleanup. Use the runbook’s plan/rebuild/resume flow rather than a native remote reset command. The workflow receives `rehearsal_evidence` as JSON and writes a temporary proof file; its source SHA must equal the checked-out full SHA. Commit the candidate first, then rehearse that SHA and supply the generated proof or CI artifact without committing a self-referencing proof.

Local verification records distinguish each tested source SHA and migration manifest; see the [verification history](../docs/database-rebuild-verification.md). An earlier native-reset probe removed platform Auth data, so hosted cutover uses the application allowlist and explicitly verifies platform preservation. The independent rehearsal tests old-60-to-current-chain rebuilding, interrupted and repeated resume, missing-checkpoint refusal and inspected constructed-state recovery. Supabase's platform MFA tables can remain preservation sentinels even though this application has no MFA design. No hosted reset, configuration change or deployment is authorized by local evidence. Future cutover needs fresh evidence for its actual candidate SHA and target environment.
