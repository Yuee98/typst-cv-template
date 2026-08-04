# Typst CV Template

[English](README.md) | [中文](README_CN.md)

A compact, bilingual CV template built with Typst, plus a web-based resume builder that renders the same template in the browser.

This project has two main parts:

1. **[Typst Template](#typst-template)** — a standalone `#import`-able template you can use in your own Typst projects.
2. **[Web Resume Builder](#web-resume-builder)** — a Next.js app for editing, previewing, and exporting your resume online.

---

## Typst Template

The template lives at `style.typ` and can be imported directly into any Typst document.

### Requirements

- [Typst](https://typst.app/)
- Fonts that support your target languages. The default stack is `Times New Roman`, `Noto Serif SC`, and `SimSun`.

### Build

```powershell
# Create output directory if needed
mkdir -p output/pdf

# Compile sample resumes
typst compile .\resume_cn.typ .\output\pdf\cv_cn_typst.pdf
typst compile .\resume_en.typ .\output\pdf\cv_en_typst.pdf
typst compile .\resume_mixed.typ .\output\pdf\cv_mixed_typst.pdf

# Watch mode for local editing
typst watch .\resume_cn.typ .\output\pdf\cv_cn_typst.pdf
```

### Files

- `style.typ`: shared layout and typography helpers; the reusable template entrypoint.
- `resume_cn.typ`: Chinese resume entrypoint.
- `resume_en.typ`: English resume entrypoint.
- `resume_mixed.typ`: Chinese and English combined entrypoint.
- `content/cn.typ`: sample Chinese resume content.
- `content/en.typ`: sample English resume content.

### Content Helpers

- `resume-entry(...)`: one company or role with a single project or scope. Pass `keep: true` for short entries such as education records that should stay on one page.
- `company-entry(org, date)[...]`: one company or role block.
- `project-entry(title, detail, bullets, date: none)`: one project or scope inside a company block. Use `title` for the role or position, and `detail` for the project, team, or product line.

`project-entry` keeps the role title on the left and project metadata on the right. If `date` is provided, it is rendered inline as `date · detail`; the date stays upright and the detail is italicized.

Section headings stick to their following content, while bullet items and publications are kept together where possible. Longer sections can still break between entries or bullets.

### Use This Template in Your Own Project

Keep your real resume content in a private repository and import this template as a subtree:

```powershell
git remote add cv-template https://github.com/YOUR_NAME/typst-cv-template.git
git subtree add --prefix=template cv-template main --squash
```

Then import `template/style.typ` from your private entrypoint and include your private content files.

---

## Web Resume Builder

The web app is a Next.js project under `web/`. It compiles your resume in the browser using [typst.ts](https://github.com/Myriad-Dreamin/typst.ts) and shares the same `style.typ` as the standalone template.

### Features

- **Live Typst preview** — see your CV rendered as printable A4 pages while you edit, using the same template as the standalone Typst project.
- **Form-based editor** — edit header, profile, skills, experience, education, research, publications, and additional sections through structured forms instead of Typst markup.
- **Drag-and-drop layout** — reorder CV sections, companies, projects, and entries with `@dnd-kit`.
- **Flexible storage** — store CVs locally in the browser, sync them to the cloud, or lock them with client-side encryption.
- **Authentication** — sign in with email/password or GitHub OAuth via Supabase.
- **Bilingual UI** — the builder UI is available in English and Chinese. The CV content language can be set independently (`zh` or `en`).
- **Custom fonts** — optionally pick local fonts through the Font Access API for preview and PDF export.
- **Document library** — manage multiple CVs, duplicate, rename, delete, move between storage modes, and reorder them in the sidebar.
- **Dark / light / system theme** — switch appearance via `next-themes`.

### Privacy-First Encrypted Storage

Encrypted CVs are protected with **client-side AES-GCM-256**. Your encryption password is used to derive a key via PBKDF2-SHA-256 and never leaves the browser. The server only stores the encrypted payload, so even the database administrators cannot read your CV content.

- Unlock an encrypted CV once per session to edit it.
- Optionally remember the password on a trusted device.
- Changes to encrypted CVs are saved only when you explicitly choose to save.

This makes the encrypted mode a good fit for resumes that contain sensitive personal or employment details.

### Export Formats

The builder can export your resume in several formats:

- **PDF** — rendered by Typst and ready to send or print.
- **`.typ` source** — a standalone Typst file that imports `style.typ`, so you can keep editing offline.
- **`.zip` package** — includes the source, `style.typ`, `data.json`, and a short README.
- **JSON** — structured CV data for backup or re-import into the builder.

### Development

```powershell
pnpm install
pnpm dev   # dev server in "server" mode (API routes included)
```

### Build & Check

The web app builds in two modes (see `web/scripts/run-next-mode.mjs`):

```powershell
pnpm build          # default = server build
pnpm build:server   # Node server build for Vercel — includes the generated /api/polish routes
pnpm build:static   # static export for GitHub Pages — no API routes, no AI UI entry
pnpm test           # vitest unit tests
pnpm lint
pnpm typecheck
```

(All are root-level passthroughs of the `web/` package scripts.)

The server-build job in `.github/workflows/ci.yml` starts the built app with CI-only fake auth/quota/provider dependencies and exercises the full API envelope without hosted services. For the local real-DeepSeek + local-Supabase release smoke and metrics commands, see `web/README.md`; that smoke is intentionally excluded from CI because it is billed and mutates its isolated local database.

The web app syncs the root `style.typ` into `web/public/typst/style.typ` before dev and build, so the root Typst style remains the source of truth.

### AI Polish (server deployments only)

AI polish is implemented for the supported free-text CV fields and is rolled out through three independent gates:

| Gate | Scope | Purpose |
|---|---|---|
| `NEXT_PUBLIC_AI_POLISH_ENABLED` | Build-time browser flag | Shows or removes the AI entry points. It is not a security switch. `build:static` refuses `true`, so the Pages artifact can never contain an AI entry point. |
| `AI_POLISH_ENABLED` | Vercel deployment | Disables both AI API routes before auth, database access, or provider work. Any value other than the exact string `true` returns `503 AI_DISABLED`. A Vercel env change requires a new deployment. |
| `public.ai_feature_config.ai_polish_enabled` | Supabase runtime | The immediate operational kill switch. Reserve and provider-start RPCs also enforce the non-empty canary allowlist and global daily limit without a redeploy. |

The API routes (`/api/polish` and `/api/polish/quota`) exist only in the **server build**. The static Pages export contains neither route and never receives server-only secrets. See `web/.env.example` for the complete environment variable contract.

### Deployment topology

`main` is the staging line and `release` is the production line. Production promotion is deliberately manual:

| Surface | Git source | Build | Database configuration | Trigger |
|---|---|---|---|---|
| Vercel Preview | `main` | Server | Dedicated test Supabase project | Push or merge to `main` |
| Test Supabase | `main` | Migrations in `supabase/` | Its own project; GitHub Integration working directory `.` | Push or merge to `main` |
| Vercel Production | `release` | Server | Dedicated production Supabase project | `release` moves after promotion |
| Production Supabase | `release` | Migrations in `supabase/` | Its own project; GitHub Integration working directory `.` | `release` moves after promotion |
| GitHub Pages | Commit selected by `Promote Release` | Static export | Public Supabase variables only; no AI API or service-role key | The manual promotion workflow |

The `Promote Release` workflow validates the selected commit from `main`, builds the static artifact, atomically advances `release` with an optional production tag, and deploys Pages. The `release` push then triggers Vercel Production and Production Supabase independently; those downstream deployments do not wait for each other or for Pages.

#### One-time environment configuration

Configure the Vercel project with **Root Directory** `web`, **Framework Preset** `Next.js`, **Build Command** `pnpm build:server`, no **Output Directory** override, and **Production Branch** `release`.

Create environment-specific values rather than sharing the production database or HMAC secret with Preview:

| Variable | Preview | Production | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Test project | Production project | Browser-safe project coordinates |
| `SUPABASE_SERVICE_ROLE_KEY` | Test project | Production project | Sensitive; server only |
| `DEEPSEEK_API_KEY` | Non-production key; it may also be used locally | Prefer a separate production key | Sensitive; server only |
| `AI_USER_ID_HMAC_SECRET` | Independent random secret | Independent random secret | Sensitive; never expose with `NEXT_PUBLIC_` |
| `AI_POLISH_ENABLED` | `false` for the initial closed-state deployment | `false` before the first production promotion | Deployment-level API gate |
| `NEXT_PUBLIC_AI_POLISH_ENABLED` | `false` for the initial closed-state deployment | `false` before the first production promotion | Build-time UI gate |

Do not set `POLISH_FAKE_LLM`, `POLISH_FAKE_BACKEND`, or `NEXT_PUBLIC_AI_POLISH_MOCK` in a hosted deployment. `AI_POLISH_MODEL` and `AI_POLISH_GLOBAL_DAILY_LIMIT` are not application environment variables; the model is pinned in code and the global limit lives in `public.ai_feature_config`.

Use two independent Supabase projects when database branching is unavailable: the test project watches `main`, while the production project watches `release`. Enable `pg_cron` in the `pg_catalog` schema before applying the migrations; the migration schedules `ai-polish-retention-cleanup` and `ai-polish-stale-reconciliation`. In each project's GitHub Integration, “production branch” means the branch deployed to that project—it does not make the test project the user-facing production database.

#### First rollout and later releases

1. With both Vercel flags set to `false`, merge a commit into `main`. Require GitHub CI, the Test Supabase deployment, and the Vercel Preview deployment to succeed. Verify the Preview homepage is `200`, the AI UI is absent, authenticated and unauthenticated AI API requests are blocked by the deployment gate, both cron jobs are active, and no provider request is made.
2. Configure a non-empty test-user allowlist, enable the test database runtime switch, set the two **Preview** Vercel flags to `true`, and redeploy Preview. Complete the bilingual browser, terms, E2EE warning, quota, cancellation, stale-write, deletion, metrics, and real-provider acceptance checks against the test project.
3. Run `Promote Release` only after Preview acceptance. Keep both **Production** Vercel flags `false` while the production migrations and first server deployment complete, then verify the closed state before enabling a non-empty production canary allowlist.
4. Turn on the two Production Vercel flags and redeploy while the database runtime switch remains off. After the exact deployment is verified, enable the database switch for allowlisted canary accounts. Clearing the allowlist for global availability remains a separate manual decision.

After the first rollout, the Vercel flags may remain `true`. For a migration that is not backward-compatible, turn off the database runtime switch before promotion and re-enable it only after the exact production deployment is verified; ordinary releases do not need to toggle Vercel env values.
