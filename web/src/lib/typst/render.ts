"use client";

type TypstModule = typeof import("@myriaddreamin/typst.ts/contrib/snippet");

let typstReady: Promise<TypstModule> | null = null;
let renderQueue = Promise.resolve();

async function loadTypst() {
  if (!typstReady) {
    typstReady = import("@myriaddreamin/typst.ts/contrib/snippet").then((module) => {
      module.$typst.setCompilerInitOptions({
        getModule: () => "/typst/wasm/typst_ts_web_compiler_bg.wasm",
      });
      module.$typst.setRendererInitOptions({
        getModule: () => "/typst/wasm/typst_ts_renderer_bg.wasm",
      });
      module.$typst.use(module.TypstSnippet.preloadFontAssets({ assets: ["text", "cjk"] }));
      return module;
    });
  }

  return typstReady;
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
    const [{ $typst }, styleSource] = await Promise.all([loadTypst(), fetchStyleSource()]);
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
