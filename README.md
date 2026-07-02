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

## Using This Template Privately

Keep your real resume content in a private repository and import this template as a subtree:

```powershell
git remote add cv-template https://github.com/YOUR_NAME/typst-cv-template.git
git subtree add --prefix=template cv-template main --squash
```

Then import `template/style.typ` from your private entrypoint and include your private content files.
