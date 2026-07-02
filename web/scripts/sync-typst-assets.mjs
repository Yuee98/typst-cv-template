import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const webRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(webRoot, "..", "..");
const publicTypstDir = join(webRoot, "..", "public", "typst");
const wasmDir = join(publicTypstDir, "wasm");
const rootBodyFont = '#let body-font = ("Times New Roman", "Noto Serif SC", "SimSun")';
const webBodyFont =
  '#let body-font = ("Times New Roman", "Noto Serif SC", "Noto Serif CJK SC", "SimSun")';

async function copyPackageAsset(packageName, relativePath, outputName) {
  const packageJson = require.resolve(`${packageName}/package.json`);
  const source = join(dirname(packageJson), relativePath);
  await copyFile(source, join(wasmDir, outputName));
}

await mkdir(wasmDir, { recursive: true });

const styleSource = await readFile(join(repoRoot, "style.typ"), "utf8");
if (!styleSource.includes(rootBodyFont)) {
  throw new Error("Unable to patch style.typ font stack for web assets.");
}

await writeFile(join(publicTypstDir, "style.typ"), styleSource.replace(rootBodyFont, webBodyFont));

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
