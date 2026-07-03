"use client";

type TypstModule = typeof import("@myriaddreamin/typst.ts/contrib/snippet");

let typstModule: TypstModule | null = null;
let instanceReady: Promise<InstanceType<TypstModule["TypstSnippet"]>> | null = null;
let renderQueue = Promise.resolve();

// Fonts added by user (accumulated across instances)
const userFontData: Uint8Array[] = [];

const BUNDLED_FONT_URLS = [
  "/typst/fonts/LiberationSerif-Regular.ttf",
  "/typst/fonts/LiberationSerif-Bold.ttf",
  "/typst/fonts/LiberationSerif-Italic.ttf",
  "/typst/fonts/LiberationSerif-BoldItalic.ttf",
  "/typst/fonts/NotoSerifCJKsc-Regular.otf",
  "/typst/fonts/NotoSerifCJKsc-Bold.otf",
];

async function fetchBundledFonts(): Promise<Uint8Array[]> {
  return Promise.all(
    BUNDLED_FONT_URLS.map((url) =>
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((buf) => new Uint8Array(buf)),
    ),
  );
}

async function getOrCreateInstance() {
  if (!typstModule) {
    typstModule = await import("@myriaddreamin/typst.ts/contrib/snippet");
  }

  const mod = typstModule;

  const instance = new mod.TypstSnippet();
  instance.setCompilerInitOptions({
    getModule: () => "/typst/wasm/typst_ts_web_compiler_bg.wasm",
  });
  instance.setRendererInitOptions({
    getModule: () => "/typst/wasm/typst_ts_renderer_bg.wasm",
  });

  // Disable default CDN font assets (we use bundled fonts instead)
  instance.use(mod.TypstSnippet.disableDefaultFontAssets());

  // Load bundled fonts
  const bundledData = await fetchBundledFonts();
  instance.use(mod.TypstSnippet.preloadFonts(bundledData));

  // Load user fonts
  if (userFontData.length > 0) {
    instance.use(mod.TypstSnippet.preloadFonts([...userFontData]));
  }

  return instance;
}

async function loadTypst() {
  if (!instanceReady) {
    instanceReady = getOrCreateInstance();
  }

  return instanceReady;
}

export function addFontFromData(fontData: Uint8Array) {
  userFontData.push(fontData);
  // Invalidate current instance so next render creates a new one with the new font
  instanceReady = null;
}

async function fetchStyleSource() {
  const response = await fetch("/typst/style.typ");
  if (!response.ok) {
    throw new Error(`Unable to load style.typ (${response.status})`);
  }

  return response.text();
}

export function renderTypstSvg(mainContent: string) {
  const nextRender = renderQueue.then(async () => {
    const [$typst, styleSource] = await Promise.all([loadTypst(), fetchStyleSource()]);
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
