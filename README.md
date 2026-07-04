# Typst CV Template

A compact bilingual CV template built with Typst.

## Requirements

- Typst
- Fonts that support your target languages. The default stack is `Times New Roman`, `Noto Serif SC`, and `SimSun`.

## Build

```powershell
typst compile .\resume_cn.typ .\output\pdf\cv_cn_typst.pdf
typst compile .\resume_en.typ .\output\pdf\cv_en_typst.pdf
typst compile .\resume_mixed.typ .\output\pdf\cv_mixed_typst.pdf
typst watch .\resume_cn.typ .\output\pdf\cv_cn_typst.pdf
```

Create `output/pdf` first if it does not already exist.

## Structure

- `resume_cn.typ`: Chinese resume entrypoint.
- `resume_en.typ`: English resume entrypoint.
- `resume_mixed.typ`: Chinese and English combined entrypoint.
- `style.typ`: shared layout and typography helpers.
- `content/cn.typ`: sample Chinese resume content.
- `content/en.typ`: sample English resume content.
- `web/`: static Next.js CV builder that renders this template in the browser.

## Web Builder

```powershell
pnpm install
pnpm --filter web dev
pnpm --filter web build
pnpm --filter web lint
pnpm --filter web typecheck
```

The web app syncs the root `style.typ` into `web/public/typst/style.typ` before dev and build, so the root Typst style remains the source of truth.

For Vercel, keep the project root at the repository root:

- Build command: `pnpm --filter web build`
- Output directory: `web/out`

## Content Helpers

- `resume-entry(...)`: one company or role with a single project or scope. Pass `keep: true` for short entries such as education records that should stay on one page.
- `company-entry(org, date)[...]`: one company or role block.
- `project-entry(title, detail, bullets, date: none)`: one project or scope inside a company block. Use `title` for the role or position, and `detail` for the project, team, or product line.

`project-entry` keeps the role title on the left and project metadata on the right. If `date` is provided, it is rendered inline as `date · detail`; the date stays upright and the detail is italicized.

Section headings stick to their following content, while bullet items and publications are kept together where possible. Longer sections can still break between entries or bullets.

## Using This Template Privately

Keep your real resume content in a private repository and import this template as a subtree:

```powershell
git remote add cv-template https://github.com/YOUR_NAME/typst-cv-template.git
git subtree add --prefix=template cv-template main --squash
```

Then import `template/style.typ` from your private entrypoint and include your private content files.
