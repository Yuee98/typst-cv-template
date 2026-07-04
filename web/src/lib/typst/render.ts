"use client";

type TypstModule = typeof import("@myriaddreamin/typst.ts/contrib/snippet");

export type LoadStage =
  | "idle"
  | "loading-assets"
  | "compiling"
  | "ready"
  | "error";

export interface LoadProgress {
  stage: LoadStage;
  /** Overall 0-100 while downloading assets; null for compiling/stages without measurable progress */
  percent: number | null;
}

export type ProgressCallback = (progress: LoadProgress) => void;

let typstModule: TypstModule | null = null;
let instanceReady: Promise<InstanceType<TypstModule["TypstSnippet"]>> | null = null;
let renderQueue = Promise.resolve();

// Fonts added by user (accumulated across instances)
const userFontData: Uint8Array[] = [];
const userFontKeys = new Set<string>();

const BUNDLED_FONT_URLS = [
  "/typst/fonts/LiberationSerif-Regular.ttf",
  "/typst/fonts/LiberationSerif-Bold.ttf",
  "/typst/fonts/LiberationSerif-Italic.ttf",
  "/typst/fonts/LiberationSerif-BoldItalic.ttf",
  "/typst/fonts/NotoSerifCJKsc-Regular.otf",
  "/typst/fonts/NotoSerifCJKsc-Bold.otf",
];

// Asset sizes fetched from build-time manifest (asset-sizes.json)
interface AssetManifest {
  compilerWasm: number;
  rendererWasm: number;
  fonts: Record<string, number>;
}

let cachedManifest: AssetManifest | null = null;

async function fetchAssetManifest(): Promise<AssetManifest> {
  if (cachedManifest) return cachedManifest;
  const response = await fetch("/typst/asset-sizes.json");
  if (!response.ok) {
    throw new Error(`Failed to fetch asset-sizes.json (${response.status}). Run "pnpm sync:typst-assets" first.`);
  }
  cachedManifest = await response.json();
  return cachedManifest!;
}

/**
 * Fetch a URL while accumulating received bytes into a shared counter.
 * The progress callback always reports the combined total across all concurrent downloads.
 *
 * @param url       The URL to fetch
 * @param index     This download's slot in `sharedBytes`
 * @param sharedBytes  Mutable array of received bytes per download (last element = total)
 * @param totalSize Combined expected size of all downloads
 * @param onProgress Progress callback
 */
async function fetchWithProgress(
  url: string,
  index: number,
  sharedBytes: number[],
  totalSize: number,
  onProgress: ProgressCallback,
): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url} (${response.status})`);
  if (!response.body) return response.arrayBuffer();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;

    // Update this download's slot and report the combined total
    sharedBytes[index] = received;
    let sum = 0;
    for (let i = 0; i < index; i++) sum += sharedBytes[i];
    sum += received;
    for (let i = index + 1; i < sharedBytes.length; i++) sum += sharedBytes[i];
    onProgress({
      stage: "loading-assets",
      percent: Math.min(100, Math.round((sum / totalSize) * 100)),
    });
  }

  const buffer = new Uint8Array(received);
  let position = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, position);
    position += chunk.byteLength;
  }
  return buffer.buffer;
}

async function getOrCreateInstance(onProgress?: ProgressCallback) {
  if (!typstModule) {
    typstModule = await import("@myriaddreamin/typst.ts/contrib/snippet");
  }

  const mod = typstModule;
  const manifest = await fetchAssetManifest();

  // Compute per-file sizes from manifest
  const fontSizes = BUNDLED_FONT_URLS.map((url) => {
    const filename = url.split("/").pop()!;
    return manifest.fonts[filename] ?? 0;
  });
  const totalSize = manifest.compilerWasm + manifest.rendererWasm + fontSizes.reduce((a, b) => a + b, 0);

  // Shared byte counter: slot 0 = compiler, 1 = renderer, 2..7 = fonts
  const sharedBytes = new Array(2 + BUNDLED_FONT_URLS.length).fill(0);
  const noop = onProgress ?? (() => {});

  const [compilerWasm, rendererWasm, bundledData] = await Promise.all([
    fetchWithProgress("/typst/wasm/typst_ts_web_compiler_bg.wasm", 0, sharedBytes, totalSize, noop),
    fetchWithProgress("/typst/wasm/typst_ts_renderer_bg.wasm", 1, sharedBytes, totalSize, noop),
    Promise.all(
      BUNDLED_FONT_URLS.map((url, i) =>
        fetchWithProgress(url, 2 + i, sharedBytes, totalSize, noop)
          .then((buf) => new Uint8Array(buf)),
      ),
    ),
  ]);

  onProgress?.({ stage: "loading-assets", percent: 100 });
  // Brief pause so the user can see the bar reach 100%
  await new Promise((r) => setTimeout(r, 400));

  const instance = new mod.TypstSnippet();
  instance.setCompilerInitOptions({
    getModule: () => compilerWasm,
  });
  instance.setRendererInitOptions({
    getModule: () => rendererWasm,
  });

  // Disable default CDN font assets (we use bundled fonts instead)
  instance.use(mod.TypstSnippet.disableDefaultFontAssets());

  // Load bundled fonts
  instance.use(mod.TypstSnippet.preloadFonts(bundledData));

  // Load user fonts
  if (userFontData.length > 0) {
    instance.use(mod.TypstSnippet.preloadFonts([...userFontData]));
  }

  return instance;
}

function loadTypst(onProgress?: ProgressCallback) {
  if (!instanceReady) {
    instanceReady = getOrCreateInstance(onProgress);
  }

  return instanceReady;
}

function fontDataKey(fontData: Uint8Array) {
  let hash = 2166136261;
  for (const byte of fontData) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }

  return `${fontData.byteLength}:${hash >>> 0}`;
}

export function addFontFromData(fontData: Uint8Array) {
  const key = fontDataKey(fontData);
  if (userFontKeys.has(key)) return false;

  userFontKeys.add(key);
  userFontData.push(fontData);
  // Invalidate current instance so next render creates a new one with the new font
  instanceReady = null;
  return true;
}

export async function fetchStyleSource() {
  const response = await fetch("/typst/style.typ");
  if (!response.ok) {
    throw new Error(`Unable to load style.typ (${response.status})`);
  }

  return response.text();
}

export function renderTypstSvg(mainContent: string, onProgress?: ProgressCallback) {
  const nextRender = renderQueue.then(async () => {
    onProgress?.({ stage: "loading-assets", percent: 0 });
    const [$typst, styleSource] = await Promise.all([loadTypst(onProgress), fetchStyleSource()]);
    onProgress?.({ stage: "compiling", percent: null });
    await $typst.resetShadow();
    await $typst.addSource("/style.typ", styleSource);
    return $typst.svg({
      mainContent,
      data_selection: {
        body: true,
        defs: true,
        css: true,
        js: true,
      },
    });
  });

  renderQueue = nextRender.then(
    () => undefined,
    () => undefined,
  );

  return nextRender;
}

export function renderTypstPdf(mainContent: string, onProgress?: ProgressCallback) {
  const nextRender = renderQueue.then(async () => {
    onProgress?.({ stage: "loading-assets", percent: 0 });
    const [$typst, styleSource] = await Promise.all([loadTypst(onProgress), fetchStyleSource()]);
    onProgress?.({ stage: "compiling", percent: null });
    await $typst.resetShadow();
    await $typst.addSource("/style.typ", styleSource);
    const pdf = await $typst.pdf({ mainContent });
    if (!pdf) {
      throw new Error("Typst did not return a PDF.");
    }

    return pdf;
  });

  renderQueue = nextRender.then(
    () => undefined,
    () => undefined,
  );

  return nextRender;
}
