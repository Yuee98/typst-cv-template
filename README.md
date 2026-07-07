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
pnpm --filter web dev
```

### Build & Check

```powershell
pnpm --filter web build
pnpm --filter web lint
pnpm --filter web typecheck
```

The web app syncs the root `style.typ` into `web/public/typst/style.typ` before dev and build, so the root Typst style remains the source of truth.

### Deploy on Vercel

Keep the project root at the repository root:

- Build command: `pnpm --filter web build`
- Output directory: `web/out`
