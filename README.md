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

The server-build job in `.github/workflows/ci.yml` starts the built app with CI-only fake auth/quota/provider dependencies and exercises the full API envelope without hosted services. Local database checks and read-only Admin metrics are documented in `web/README.md`; ordinary tests never call paid upstream APIs.

The web app syncs the root `style.typ` into `web/public/typst/style.typ` before dev and build, so the root Typst style remains the source of truth.

### AI polish and database

Users select a Provider/model from the set allowed during the current time window. Published database configuration, pricing and exact disclosure are frozen when a request reserves quota. Both allowed attempts retain that selection. DeepSeek, MiMo and Google Gemini through AI Studio are supported; Google uses native Interactions with `gemini-3.8-flash`.

Business tables live in private schemas. Clients use read-only views and RPCs guarded by database instance and revision. Every CV entry accepts v7 and the current storage/encryption format. Historical JSON, storage keys and APIs are rejected.

See [web development](web/README.md) and the [database contract](docs/database-contract.md) for configuration and local checks. Provider secrets use only `AI_PROVIDER_KEY_DEEPSEEK_*` / `AI_PROVIDER_KEY_MIMO_*` / `AI_PROVIDER_KEY_GEMINI_*`; database profiles reference their names, never their values.

### Deployment

The test Supabase project watches `main`; production watches `release`. Verify the separate database mapping for Vercel Preview/Production and Pages. `Promote Release` advances production manually. Follow the [rebuild runbook](docs/database-rebuild-runbook.md) for the one-time switch.

This rebuild is being implemented on a local development branch. Test/prod have not been reset or deployed. The new migration chain must not be applied directly over the old history; hosted cutover requires separate authorization and the runbook.
