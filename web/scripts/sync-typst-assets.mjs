import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const webRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(webRoot, "..", "..");
const publicTypstDir = join(webRoot, "..", "public", "typst");
const wasmDir = join(publicTypstDir, "wasm");
const publicFontsDir = join(publicTypstDir, "fonts");
const localFontsDir = join(webRoot, "..", "fonts");

const rootBodyFont = '#let body-font = ("Times New Roman", "Noto Serif SC", "SimSun")';
const webBodyFont =
  '#let body-font = ("Liberation Serif", "Noto Serif CJK SC")';

async function copyPackageAsset(packageName, relativePath, outputName) {
  const packageJson = require.resolve(`${packageName}/package.json`);
  const source = join(dirname(packageJson), relativePath);
  await copyFile(source, join(wasmDir, outputName));
}

await mkdir(wasmDir, { recursive: true });
await mkdir(publicFontsDir, { recursive: true });

// Patch style.typ for web: swap to bundled font stack
const styleSource = await readFile(join(repoRoot, "style.typ"), "utf8");
if (!styleSource.includes(rootBodyFont)) {
  throw new Error("Unable to patch style.typ font stack for web assets.");
}
await writeFile(join(publicTypstDir, "style.typ"), styleSource.replace(rootBodyFont, webBodyFont));

// Copy bundled font files to public/typst/fonts/
const fontFiles = await readdir(localFontsDir);
for (const file of fontFiles) {
  if (file.endsWith(".ttf") || file.endsWith(".otf")) {
    await copyFile(join(localFontsDir, file), join(publicFontsDir, file));
  }
}

// Copy WASM binaries
await copyPackageAsset(
  "@myriaddreamin/typst-ts-web-compiler",
  "pkg/typst_ts_web_compiler_bg.wasm",
  "typst_ts_web_compiler_bg.wasm",
);
await copyPackageAsset(
  "@myriaddreamin/typst-ts-renderer",
  "pkg/typst_ts_renderer_bg.wasm",
  "typst_ts_renderer_bg.wasm",
);

// Generate asset sizes manifest for progress tracking
const manifest = {
  compilerWasm: (await stat(join(wasmDir, "typst_ts_web_compiler_bg.wasm"))).size,
  rendererWasm: (await stat(join(wasmDir, "typst_ts_renderer_bg.wasm"))).size,
  fonts: Object.fromEntries(
    await Promise.all(
      (await readdir(publicFontsDir))
        .filter((f) => f.endsWith(".ttf") || f.endsWith(".otf"))
        .map(async (f) => [f, (await stat(join(publicFontsDir, f))).size]),
    ),
  ),
};
await writeFile(
  join(publicTypstDir, "asset-sizes.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log("Generated asset-sizes.json:", manifest);
