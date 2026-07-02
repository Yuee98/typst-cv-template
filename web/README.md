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

## Vercel

Use the repository root as the Vercel root directory.

- Build command: `pnpm --filter web build`
- Output directory: `web/out`
