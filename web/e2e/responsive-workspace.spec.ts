import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { CvData } from "../src/lib/cv/schema";

// Each test gets an isolated context and only current-format local documents.
// No Auth session, consent, cloud write, or Provider generation is permitted.
test.use({ storageState: { cookies: [], origins: [] } });
test.setTimeout(120_000);

const firstId = "67c38251-92c4-4f72-a6bf-10b41a90a001";
const secondId = "67c38251-92c4-4f72-a6bf-10b41a90a002";
const collapsedKey = "typst-cv-builder:ui:library-collapsed";
const viewports = [
  { width: 390, height: 844, bounded: false, docked: false },
  { width: 320, height: 568, bounded: false, docked: false },
  { width: 768, height: 1024, bounded: false, docked: false },
  { width: 959, height: 960, bounded: false, docked: false },
  { width: 960, height: 960, bounded: true, docked: false },
  { width: 1100, height: 1050, bounded: true, docked: false },
  { width: 1440, height: 1400, bounded: true, docked: false },
  { width: 1024, height: 768, bounded: true, docked: false },
  { width: 1536, height: 960, bounded: true, docked: true },
] as const;

function cv(name: string): CvData {
  const sectionOrder = ["profile", "skills", "experience", "education", "research", "publications", "additional"] as const;
  return {
    schemaVersion: 7,
    typstLang: "en",
    sectionOrder: [...sectionOrder],
    header: { name, subtitle: "Responsive workspace fixture", email: "responsive@example.test", phone: "123456", selfName: name },
    sectionTitles: {
      profile: { title: "Profile", isDisplay: true, pageBreakBefore: false },
      skills: { title: "Skills", isDisplay: true, pageBreakBefore: true },
      experience: { title: "Experience", isDisplay: true, pageBreakBefore: false },
      education: { title: "Education", isDisplay: true, pageBreakBefore: false },
      research: { title: "Research", isDisplay: true, pageBreakBefore: false },
      publications: { title: "Publications", isDisplay: true, pageBreakBefore: false },
      additional: { title: "Additional", isDisplay: true, pageBreakBefore: false },
    },
    profile: Array.from({ length: 12 }, (_, i) => ({ body: `Item ${i + 1}. Built reliable applications with accessible interfaces and clear documentation. Collaborated with colleagues to ship maintainable products and verify real user workflows across devices.` })),
    skills: [{ label: "Engineering", body: "TypeScript, accessible interfaces, reliable systems" }],
    experience: [], education: [], research: [], publications: [], additional: [],
  };
}

async function blockWrites(context: BrowserContext) {
  const blocked: string[] = [];
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const writing = !["GET", "HEAD", "OPTIONS"].includes(request.method());
    const supabase = url.hostname.endsWith(".supabase.co") || /^\/(?:rest|auth|storage)\/v1(?:\/|$)/.test(url.pathname) ||
      (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.port === "54321");
    const readonlyRpc = request.method() === "POST" && /^\/rest\/v1\/rpc\/(?:app_context|legal_current|keep_project_active)$/.test(url.pathname);
    if (writing && (url.pathname.startsWith("/api/polish") || supabase && !readonlyRpc)) {
      blocked.push(`${request.method()} ${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  return blocked;
}

async function seed(page: Page) {
  const timestamp = "2026-11-08T00:00:00.000Z";
  const documents = [
    { id: firstId, title: "Responsive first CV", storageKind: "local", createdAt: timestamp, updatedAt: timestamp, data: cv("Responsive first") },
    { id: secondId, title: "Responsive second CV", storageKind: "local", createdAt: timestamp, updatedAt: timestamp, data: cv("Responsive second") },
  ];
  await page.addInitScript(({ documents, collapsedKey }) => {
    window.localStorage.clear();
    const summaries = documents.map(document => ({ id: document.id, title: document.title, storageKind: document.storageKind, createdAt: document.createdAt, updatedAt: document.updatedAt }));
    window.localStorage.setItem("typst-cv-builder:documents:index", JSON.stringify({ version: 1, documents: summaries }));
    window.localStorage.setItem("typst-cv-builder:documents:active", documents[0].id);
    window.localStorage.setItem(collapsedKey, "false");
    for (const document of documents) window.localStorage.setItem(`typst-cv-builder:documents:${document.id}`, JSON.stringify(document));
  }, { documents, collapsedKey });
}

type Locale = "en" | "zh";
const labels = {
  en: { library: "Open CV library", header: "Header", ready: "Ready", actions: ["Theme", "Interface language", "GitHub", "Account"] },
  zh: { library: "打开简历库", header: "页眉", ready: "就绪", actions: ["主题", "界面语言", "GitHub", "账户"] },
} as const;

const profileTab = (page: Page) => page.getByRole("tab", { name: "Profile. Drag to reorder section.", exact: true });
const libraryTrigger = (page: Page) => page.getByRole("button", { name: "Open CV library", exact: true });
const libraryDialog = (page: Page) => page.getByRole("dialog", { name: "CV Library", exact: true });

async function boot(page: Page, locale: Locale = "en") {
  await page.goto(`/${locale}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole("tab", { name: labels[locale].header, exact: true })).toBeVisible();
  await expect(page.locator('input[name="header.name"]')).toHaveValue("Responsive first");
  await expect(page.getByRole("status", { name: labels[locale].ready, exact: true })).toBeVisible();
  await expect.poll(() => page.locator(".preview-pane .typst-page-shell svg").count()).toBeGreaterThan(1);
}

async function noHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)).toBeLessThanOrEqual(1);
}

async function selectedDocument(page: Page) {
  return page.evaluate(() => window.localStorage.getItem("typst-cv-builder:documents:active"));
}

async function nonDocumentScrollers(page: Page, selector: string) {
  return page.locator(selector).evaluate(element => {
    const scrollers: { top: number; overflow: string }[] = [];
    for (let parent = element.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
      const overflow = getComputedStyle(parent).overflowY;
      if (/(auto|scroll)/.test(overflow) && parent.scrollHeight > parent.clientHeight + 2) scrollers.push({ top: parent.scrollTop, overflow });
    }
    return scrollers;
  });
}

async function squareToolbar(page: Page, docked = false, locale: Locale = "en") {
  const header = page.locator("header.cv-toolbar");
  await expect(header).toHaveAttribute("data-wrapped", /^(true|false)$/);
  const wrapped = await header.getAttribute("data-wrapped") === "true";
  const controls = page.locator(".cv-toolbar-controls");
  // In one row the controls use display:contents, so they have no own box.
  const bounds = (await (wrapped ? controls : header).boundingBox())!;
  const right = [];
  for (const name of labels[locale].actions) {
    const button = page.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(Math.abs(box.width - 32)).toBeLessThanOrEqual(0.6);
    expect(Math.abs(box.height - 32)).toBeLessThanOrEqual(0.6);
    right.push(box);
  }
  for (let i = 1; i < right.length; i++) {
    const gap = right[i].x - right[i - 1].x - right[i - 1].width;
    expect(gap).toBeGreaterThanOrEqual(-0.5);
    expect(gap).toBeLessThanOrEqual(12);
    expect(Math.abs(right[i].y - right[0].y)).toBeLessThanOrEqual(1);
  }
  const rightInset = bounds.x + bounds.width - right.at(-1)!.x - 32;
  expect(rightInset).toBeGreaterThanOrEqual(-1);
  expect(rightInset).toBeLessThanOrEqual(20);
  const brand = (await page.locator(".toolbar-brand").boundingBox())!;
  const logo = (await page.locator(".toolbar-brand img").boundingBox())!;
  if (!docked) {
    const trigger = page.getByRole("button", { name: labels[locale].library, exact: true });
    await expect(trigger).toBeVisible();
    const box = (await trigger.boundingBox())!;
    expect(Math.abs(box.width - 32)).toBeLessThanOrEqual(0.6);
    expect(Math.abs(box.height - 32)).toBeLessThanOrEqual(0.6);
    expect(box.x - bounds.x).toBeGreaterThanOrEqual(-1);
    expect(box.x - bounds.x).toBeLessThanOrEqual(20);
    expect(Math.abs(box.y - right[0].y)).toBeLessThanOrEqual(1);
    const borderVisible = await trigger.evaluate(element => {
      const style = getComputedStyle(element);
      return ["Top", "Right", "Bottom", "Left"].some(side => {
        const width = style.getPropertyValue(`border-${side.toLowerCase()}-width`);
        const color = style.getPropertyValue(`border-${side.toLowerCase()}-color`);
        return parseFloat(width) > 0 && color !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(color);
      });
    });
    expect(borderVisible, "the menu is borderless").toBe(false);
    if (!wrapped) {
      expect(logo.x).toBeGreaterThanOrEqual(box.x + box.width);
      expect(logo.x - box.x - box.width).toBeLessThanOrEqual(16);
      expect(Math.abs(box.y + box.height / 2 - logo.y - logo.height / 2)).toBeLessThanOrEqual(1);
    }
  }
  if (wrapped) expect(brand.y + brand.height).toBeLessThanOrEqual(right[0].y);
  else {
    expect(brand.x + brand.width).toBeLessThanOrEqual(right[0].x + 1);
    expect(Math.abs(logo.y + logo.height / 2 - right[0].y - 16)).toBeLessThanOrEqual(1);
  }
  return { wrapped, header: (await header.boundingBox())!, controls: wrapped ? (await controls.boundingBox())! : null };
}

async function stickyHeader(page: Page, wasWrapped: boolean, originalHeight: number) {
  const header = page.locator("header.cv-toolbar");
  expect(Math.abs((await header.boundingBox())!.height - originalHeight)).toBeLessThanOrEqual(1);
  const sticky = wasWrapped ? page.locator(".cv-toolbar-controls") : header;
  const row = (await sticky.boundingBox())!;
  expect(row.y).toBeGreaterThanOrEqual(-1);
  expect(row.y).toBeLessThanOrEqual(16);
  const brand = (await page.locator(".toolbar-brand").boundingBox())!;
  if (wasWrapped) expect(brand.y + brand.height).toBeLessThanOrEqual(1);
  else expect(brand.y).toBeGreaterThanOrEqual(0);
}

async function evidence(testInfo: TestInfo, name: string, data: unknown) {
  const path = testInfo.outputPath(name);
  await writeFile(path, JSON.stringify(data, null, 2));
  await testInfo.attach(name, { path, contentType: "application/json" });
}

async function animationMiddle(page: Page) {
  await page.waitForFunction(() => {
    const drawer = document.querySelector(".library-drawer");
    return drawer?.getAnimations().some(animation => {
      const duration = animation.effect?.getComputedTiming().duration;
      return typeof duration === "number" && duration > 0 && typeof animation.currentTime === "number" && animation.currentTime / duration >= 0.15 && animation.currentTime / duration < 0.7;
    });
  }, undefined, { polling: "raf" });
  return page.evaluate(() => {
    const drawer = document.querySelector<HTMLElement>(".library-drawer")!;
    const overlay = document.querySelector<HTMLElement>("[data-library-overlay]")!;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(drawer).transform);
    return { state: drawer.dataset.state, translateX: matrix.m41, width: drawer.getBoundingClientRect().width, opacity: Number(getComputedStyle(overlay).opacity) };
  });
}

async function animationSettled(page: Page) {
  await expect.poll(() => page.locator(".library-drawer").evaluate(element => element.getAnimations().every(animation => animation.playState === "finished"))).toBe(true);
}

async function armDrawerTiming(page: Page, opening: boolean) {
  await page.evaluate(opening => {
    const result = { opening, firstFrameMs: 0, settledMs: 0, frames: 0, done: false, timedOut: false, longTaskSupported: PerformanceObserver.supportedEntryTypes.includes("longtask"), longTasksMs: [] as number[] };
    Object.assign(window, { __responsiveDrawerTiming: result });
    const selector = opening ? ".library-trigger" : '.library-drawer button[title="Collapse CV library"]';
    document.querySelector(selector)!.addEventListener("click", () => {
      const start = performance.now();
      const observer = result.longTaskSupported ? new PerformanceObserver(entries => result.longTasksMs.push(...entries.getEntries().map(entry => entry.duration))) : null;
      observer?.observe({ type: "longtask" });
      const frame = (time: number) => {
        result.frames++;
        const drawer = document.querySelector(".library-drawer");
        if (!result.firstFrameMs) result.firstFrameMs = time - start;
        const settled = opening ? drawer && drawer.contains(document.activeElement) && drawer.getAnimations().every(animation => animation.playState === "finished") : !drawer;
        if (settled || time - start > 5000) {
          result.settledMs = time - start; result.done = true; result.timedOut = !settled;
          result.longTasksMs.push(...(observer?.takeRecords().map(entry => entry.duration) ?? [])); observer?.disconnect();
        } else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }, { once: true });
  }, opening);
}

async function drawerTiming(page: Page) {
  await page.waitForFunction(() => (window as unknown as { __responsiveDrawerTiming: { done: boolean } }).__responsiveDrawerTiming.done);
  const result = await page.evaluate(() => (window as unknown as { __responsiveDrawerTiming: { opening: boolean; firstFrameMs: number; settledMs: number; frames: number; timedOut: boolean; longTaskSupported: boolean; longTasksMs: number[] } }).__responsiveDrawerTiming);
  expect(result.timedOut).toBe(false);
  return result;
}

test.describe("responsive local workspace", () => {
  let blocked: string[];
  let resizeErrors: string[];
  test.beforeEach(async ({ page, context, baseURL }) => {
    const origin = new URL(baseURL ?? "http://127.0.0.1:4173");
    const loopback = origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname);
    const authorizedPreview = process.env.CV_RESPONSIVE_PREVIEW_ORIGIN;
    const privatePreview = /^192\.168\.\d{1,3}\.\d{1,3}$/.test(origin.hostname) && origin.origin === authorizedPreview;
    expect(loopback || privatePreview, "Use the local test server or the explicitly authorized private preview origin").toBe(true);
    resizeErrors = [];
    page.on("pageerror", error => { if (/ResizeObserver.*loop/i.test(error.message)) resizeErrors.push(error.message); });
    page.on("console", message => { if (/ResizeObserver.*loop/i.test(message.text())) resizeErrors.push(message.text()); });
    blocked = await blockWrites(context);
    await seed(page);
  });
  test.afterEach(() => {
    expect(blocked, "responsive acceptance must not attempt cloud/auth/AI writes").toEqual([]);
    expect(resizeErrors, "header fit must not cause ResizeObserver loops").toEqual([]);
  });

  for (const locale of ["en", "zh"] as const) {
    for (const viewport of viewports.filter(size => [320, 390, 768, 1536].includes(size.width))) {
      test(`header ${locale} ${viewport.width}x${viewport.height}: menu precedes logo when fitted and controls stay grouped`, async ({ page }, testInfo) => {
        await page.setViewportSize(viewport);
        await boot(page, locale);
        await page.evaluate(() => window.scrollTo(0, 0));
        const layout = await squareToolbar(page, viewport.docked, locale);
        await noHorizontalOverflow(page);
        const samples = [];
        for (let i = 0; i < 6; i++) {
          samples.push(await page.locator("header.cv-toolbar").evaluate(element => ({ wrapped: element.getAttribute("data-wrapped"), height: element.getBoundingClientRect().height })));
          await page.waitForTimeout(50);
        }
        expect(new Set(samples.map(value => JSON.stringify(value))).size, "fitting converges without row oscillation").toBe(1);
        await page.screenshot({ path: testInfo.outputPath(`header-${locale}-${viewport.width}-top.png`) });
        if (!viewport.bounded) {
          // Use the fixture's long editor section so the tall portrait viewport
          // has enough natural document scroll to exercise the sticky boundary.
          await page.getByRole("tab", { name: locale === "en" ? /^Profile\./ : /^简介/ }).click();
          await page.evaluate(() => window.scrollTo(0, 500));
          await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
          await stickyHeader(page, layout.wrapped, layout.header.height);
          await squareToolbar(page, viewport.docked, locale);
          await page.screenshot({ path: testInfo.outputPath(`header-${locale}-${viewport.width}-scrolled.png`) });
        }
        await evidence(testInfo, "header-layout.json", { locale, viewport, wrapped: layout.wrapped, height: layout.header.height, samples, resizeErrors });
      });
    }
  }

  for (const viewport of viewports) {
    test(`${viewport.width}x${viewport.height}: editor remains reachable and layout uses the appropriate scroll surface`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await boot(page);
      await page.screenshot({ path: testInfo.outputPath("workspace.png"), fullPage: !viewport.bounded });
      await noHorizontalOverflow(page);
      await squareToolbar(page, viewport.docked);
      await expect(page.locator('a[href="#cv-preview"]')).toHaveCount(0);
      await expect(page.locator(".editor-column")).toHaveCount(1);
      await expect(page.locator(".preview-pane")).toHaveCount(1);
      const editor = (await page.locator(".editor-column").boundingBox())!;
      const preview = (await page.locator(".preview-column").boundingBox())!;
      if (viewport.bounded) {
        expect(editor.x + editor.width).toBeLessThanOrEqual(preview.x + 1);
        expect(Math.abs(editor.y - preview.y)).toBeLessThanOrEqual(1);
        expect(editor.width).toBeGreaterThan(250);
        expect(preview.width).toBeGreaterThan(250);
        expect(editor.height).toBeGreaterThan(viewport.height / 2);
        expect(Math.abs(editor.height - preview.height)).toBeLessThanOrEqual(1);
        expect(Math.max(editor.y + editor.height, preview.y + preview.height)).toBeLessThanOrEqual(viewport.height + 1);
      } else expect(preview.y).toBeGreaterThanOrEqual(editor.y + editor.height - 1);
      await evidence(testInfo, "workspace-layout.json", { viewport, editor, preview });
      if (viewport.docked) {
        await expect(libraryTrigger(page)).not.toBeVisible();
        await expect(page.getByRole("heading", { name: "CV Library", exact: true })).toBeVisible();
        await expect(page.locator(".library-sidebar")).toHaveCount(1);
      } else {
        await expect(libraryTrigger(page)).toBeVisible();
        await expect(page.getByRole("heading", { name: "CV Library", exact: true })).not.toBeVisible();
        await libraryTrigger(page).click();
        await expect(libraryDialog(page)).toBeVisible();
        await expect(page.locator(".library-sidebar")).toHaveCount(1);
        if (viewport.width >= 959) {
          await animationSettled(page);
          await page.screenshot({ path: testInfo.outputPath("workspace-drawer.png") });
        }
        await page.keyboard.press("Escape");
        await expect(page.locator(".library-drawer")).toHaveCount(0);
        await expect(libraryTrigger(page)).toBeFocused();
      }
      await profileTab(page).click();
      const last = page.locator('textarea[name="profile.11.body"]');
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
      await last.fill(`Bottom editor item reached at ${viewport.width} by ${viewport.height}.`);
      await expect(last).toHaveValue(`Bottom editor item reached at ${viewport.width} by ${viewport.height}.`);
      const scrollers = await nonDocumentScrollers(page, 'textarea[name="profile.11.body"]');
      const windowScroll = await page.evaluate(() => window.scrollY);
      if (viewport.bounded) {
        expect(windowScroll).toBeLessThanOrEqual(1);
        expect(scrollers.some(scroller => scroller.top > 1)).toBe(true);
        const pages = page.locator(".typst-page-shell");
        await pages.last().scrollIntoViewIfNeeded();
        expect((await nonDocumentScrollers(page, ".typst-page-shell:last-child")).some(scroller => scroller.top > 1)).toBe(true);
        expect(await page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(1);
      } else {
        expect(windowScroll).toBeGreaterThan(100);
        expect(scrollers.some(scroller => scroller.top > 1)).toBe(false);
      }
      await noHorizontalOverflow(page);
    });
  }

  test("mobile library closes by button, Escape and selection without duplicate sidebar or collapsed persistence", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page);
    const original = await page.evaluate(key => localStorage.getItem(key), collapsedKey);
    await libraryTrigger(page).click();
    await expect(libraryDialog(page)).toBeVisible();
    await expect(page.locator(".library-sidebar")).toHaveCount(1);
    await libraryDialog(page).getByRole("button", { name: "Collapse CV library", exact: true }).click();
    await expect(libraryDialog(page)).not.toBeVisible();
    await expect(libraryTrigger(page)).toBeFocused();
    await libraryTrigger(page).click();
    await expect(libraryDialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(libraryDialog(page)).not.toBeVisible();
    await libraryTrigger(page).click();
    await libraryDialog(page).locator(`[data-cv-card-select="${secondId}"]`).click();
    await expect(libraryDialog(page)).not.toBeVisible();
    await expect(page.locator('input[name="header.name"]')).toHaveValue("Responsive second");
    expect(await selectedDocument(page)).toBe(secondId);
    expect(await page.evaluate(key => localStorage.getItem(key), collapsedKey)).toBe(original);
    await noHorizontalOverflow(page);
  });

  test("drawer visibly slides and fades in and out, retaining its DOM through exit; latency is sampled separately", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await boot(page);
    await libraryTrigger(page).click();
    const opening = await animationMiddle(page);
    expect(opening.state).toBe("open");
    expect(opening.translateX).toBeLessThan(0);
    expect(opening.translateX).toBeGreaterThan(-opening.width);
    expect(opening.opacity).toBeGreaterThan(0);
    expect(opening.opacity).toBeLessThan(1);
    await page.screenshot({ path: testInfo.outputPath("drawer-opening-middle.png"), animations: "allow" });
    await animationSettled(page);
    await libraryDialog(page).getByRole("button", { name: "Collapse CV library", exact: true }).click();
    const closing = await animationMiddle(page);
    expect(closing.state).toBe("closed");
    expect(closing.translateX).toBeLessThan(0);
    expect(closing.translateX).toBeGreaterThan(-closing.width);
    expect(closing.opacity).toBeGreaterThan(0);
    expect(closing.opacity).toBeLessThan(1);
    await expect(page.locator(".library-drawer")).toBeAttached();
    await page.screenshot({ path: testInfo.outputPath("drawer-closing-middle.png"), animations: "allow" });
    await expect(page.locator(".library-drawer")).toHaveCount(0);
    await expect(page.locator("[data-library-overlay]")).toHaveCount(0);
    // No screenshots run during these samples: image capture pauses rendering
    // and would contaminate animation/input latency observations.
    const samples = [];
    for (let i = 0; i < 3; i++) {
      await armDrawerTiming(page, true); await libraryTrigger(page).click(); samples.push(await drawerTiming(page));
      await armDrawerTiming(page, false); await libraryDialog(page).getByRole("button", { name: "Collapse CV library", exact: true }).click(); samples.push(await drawerTiming(page));
    }
    await evidence(testInfo, "drawer-performance.json", { opening, closing, samples, screenshotsDuringTiming: false });
  });

  test("scrolled action menus preserve the page scroll owner and nested dialogs retain modal focus", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page);
    await profileTab(page).click();
    await page.evaluate(() => window.scrollTo(0, 500));
    const position = () => page.evaluate(() => ({
      scrollY: window.scrollY,
      headerY: document.querySelector("header.cv-toolbar")!.getBoundingClientRect().y,
      locked: document.body.getAttribute("data-scroll-locked"),
      bodyOverflow: getComputedStyle(document.body).overflowY,
    }));
    const stable = async (before: Awaited<ReturnType<typeof position>>) => {
      const after = await position();
      expect(after.locked).toBeNull();
      expect(after.bodyOverflow).not.toBe("hidden");
      expect(Math.abs(after.scrollY - before.scrollY)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.headerY - before.headerY)).toBeLessThanOrEqual(1);
    };
    for (const name of ["Theme", "Interface language", "GitHub", "Account", "Export"]) {
      const trigger = page.getByRole("button", { name, exact: true });
      if (name === "Export") await trigger.scrollIntoViewIfNeeded();
      const before = await position();
      await trigger.click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeInViewport();
      await stable(before);
      await page.keyboard.press("ArrowDown");
      expect(await menu.evaluate(element => element.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await stable(before);
      if (name !== "Export") {
        await trigger.click();
        // Click a fully visible editor field, without scrolling it into view.
        // Nonmodal menu dismissal must not restore focus over this new target.
        const fieldName = await page.locator("textarea").evaluateAll(elements => elements.find(element => {
          const box = element.getBoundingClientRect();
          return box.y >= 100 && box.y + box.height < window.innerHeight - 16 &&
            document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element;
        })?.getAttribute("name"));
        expect(fieldName).toBeTruthy();
        const outside = page.locator(`textarea[name="${fieldName}"]`);
        await outside.click();
        await expect(menu).toHaveCount(0);
        await expect(outside).toBeFocused();
        await stable(before);
      }
    }
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.getByRole("button", { name: "Account", exact: true }).click();
    const login = page.getByRole("menuitem", { name: "Log in", exact: true });
    if (await login.getAttribute("data-disabled") === null) {
      await login.click();
      const auth = page.getByRole("dialog", { name: "Log in", exact: true });
      await expect(auth).toBeInViewport();
      await expect(page.locator("body")).toHaveAttribute("data-scroll-locked", "1");
      await auth.locator('input[type="email"]').click();
      await page.keyboard.press("Tab");
      expect(await auth.evaluate(element => element.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Escape");
      await expect(auth).toHaveCount(0);
    } else await page.keyboard.press("Escape");
    await libraryTrigger(page).click();
    await expect(libraryDialog(page)).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute("data-scroll-locked", "1");
    const create = libraryDialog(page).getByRole("button", { name: "New CV", exact: true });
    await create.click();
    await expect(page.getByRole("menu")).toBeInViewport();
    await expect(page.locator("body")).toHaveAttribute("data-scroll-locked", "1");
    await page.keyboard.press("ArrowDown");
    expect(await page.getByRole("menu").evaluate(element => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(libraryDialog(page)).toBeVisible();
    await expect(create).toBeFocused();
    await expect(page.locator("body")).toHaveAttribute("data-scroll-locked", "1");
    await page.keyboard.press("Escape");
    await expect(page.locator(".library-drawer")).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveAttribute("data-scroll-locked");
    await expect(libraryTrigger(page)).toBeFocused();
  });

  test("reduced motion removes drawer animation while retaining dismissal and focus behavior", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await boot(page);
    await libraryTrigger(page).click();
    await expect(libraryDialog(page)).toBeVisible();
    const motion = await page.evaluate(() => [document.querySelector(".library-drawer")!, document.querySelector("[data-library-overlay]")!].map(element => ({ animation: getComputedStyle(element).animationName, running: element.getAnimations().filter(animation => animation.playState === "running").length })));
    expect(motion.every(value => value.animation === "none" && value.running === 0)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator(".library-drawer")).toHaveCount(0);
    await expect(libraryTrigger(page)).toBeFocused();
  });

  test("the fitted header or wrapped button row sticks without changing height, with measured scroll frames", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await boot(page);
    await profileTab(page).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    const header = page.locator("header.cv-toolbar");
    const originalHeight = (await header.boundingBox())!.height;
    const layout = await squareToolbar(page);
    await page.screenshot({ path: testInfo.outputPath("phone-top.png") });
    const start = await page.evaluate(() => {
      const frames: number[] = [], longTasks: number[] = [];
      let previous = 0, frameId = 0;
      const supported = PerformanceObserver.supportedEntryTypes.includes("longtask");
      const observer = supported ? new PerformanceObserver(entries => longTasks.push(...entries.getEntries().map(entry => entry.duration))) : null;
      observer?.observe({ type: "longtask" });
      const tick = (time: number) => { if (previous) frames.push(time - previous); previous = time; frameId = requestAnimationFrame(tick); };
      frameId = requestAnimationFrame(tick);
      const changed: string[] = [];
      const mutation = new MutationObserver(records => changed.push(...records.map(record => record.attributeName ?? record.type)));
      mutation.observe(document.querySelector("header.cv-toolbar")!, { subtree: true, attributes: true, childList: true });
      Object.assign(window, { __responsiveScrollMeasurement: { frames, longTasks, supported, observer, mutation, changed, stop: () => cancelAnimationFrame(frameId) } });
      return performance.now();
    });
    await page.mouse.move(160, 420);
    for (let i = 0; i < 18; i++) {
      await page.mouse.wheel(0, 70);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    }
    const metrics = await page.evaluate(start => {
      const m = (window as unknown as { __responsiveScrollMeasurement: { frames: number[]; longTasks: number[]; supported: boolean; observer: PerformanceObserver | null; mutation: MutationObserver; changed: string[]; stop: () => void } }).__responsiveScrollMeasurement;
      m.stop(); m.longTasks.push(...(m.observer?.takeRecords().map(entry => entry.duration) ?? [])); m.observer?.disconnect(); m.mutation.disconnect();
      const sorted = [...m.frames].sort((a, b) => a - b);
      return { durationMs: performance.now() - start, frameCount: m.frames.length, frameIntervalsMs: m.frames, frameP95Ms: sorted[Math.floor((sorted.length - 1) * 0.95)], maxFrameMs: Math.max(...m.frames), gapsOver50Ms: m.frames.filter(value => value > 50).length, longTaskSupported: m.supported, longTasksMs: m.longTasks, headerDomMutations: m.changed, windowY: window.scrollY };
    }, start);
    expect(metrics.windowY).toBeGreaterThan(200);
    expect(metrics.frameCount).toBeGreaterThan(10);
    expect(metrics.headerDomMutations).toEqual([]);
    await stickyHeader(page, layout.wrapped, originalHeight);
    await squareToolbar(page);
    await page.screenshot({ path: testInfo.outputPath("phone-scrolled.png") });
    await evidence(testInfo, "scroll-performance.json", metrics);
    await noHorizontalOverflow(page);
  });

  test("mobile preview keeps every page in one bounded vertical scroller and prints every page", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page);
    const pane = page.locator(".preview-pane");
    const pages = page.locator(".preview-pane .typst-page-shell");
    const count = await pages.count();
    expect(count).toBeGreaterThan(1);
    for (let i = 0; i < count; i++) await expect(pages.nth(i)).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Preview pages", includeHidden: true })).toHaveCount(0);
    await pane.scrollIntoViewIfNeeded();
    const box = (await pane.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(Math.min(844 * 0.7, 48 * 16) + 2);
    const surface = page.locator(".preview-scroll");
    const before = await page.evaluate(() => window.scrollY);
    const scrollBox = (await surface.boundingBox())!;
    await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + Math.min(scrollBox.height / 2, 200));
    await page.mouse.wheel(0, 250);
    await expect.poll(() => surface.evaluate(element => element.scrollTop)).toBeGreaterThan(1);
    expect(Math.abs(await page.evaluate(() => window.scrollY) - before)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("phone-preview.png") });
    await page.emulateMedia({ media: "print" });
    for (let i = 0; i < count; i++) await expect(pages.nth(i)).toBeVisible();
    const pdf = await page.pdf({ format: "A4", preferCSSPageSize: true, printBackground: true });
    // Chromium emits explicit Page dictionary objects; this controlled fixture
    // cannot inject PDF syntax. Count printed pages, rather than just CSS flags.
    expect([...pdf.toString("latin1").matchAll(/\/Type\s*\/Page\b/g)]).toHaveLength(count);
    await page.emulateMedia({ media: "screen" });
    await expect(page.locator(".typst-page-shell:visible")).toHaveCount(count);
  });

  test("resizing between docked, bounded, portrait and short-height layouts preserves form and selected tab", async ({ page }) => {
    await page.setViewportSize({ width: 1536, height: 960 });
    await boot(page);
    await page.locator('input[name="header.name"]').fill("Responsive retained form");
    await profileTab(page).click();
    const first = page.locator('textarea[name="profile.0.body"]');
    await first.fill("Unsaved editor state survives viewport transitions.");
    for (const size of [{ width: 1440, height: 1400 }, { width: 1100, height: 1050 }, { width: 960, height: 960 }, { width: 959, height: 960 }, { width: 960, height: 960 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 1536, height: 400 }, { width: 1536, height: 960 }]) {
      await page.setViewportSize(size);
      await expect(profileTab(page)).toHaveAttribute("aria-selected", "true");
      await expect(first).toHaveValue("Unsaved editor state survives viewport transitions.");
      await expect(page.locator(".editor-column")).toHaveCount(1);
      await expect(page.locator(".preview-pane")).toHaveCount(1);
      expect(await selectedDocument(page)).toBe(firstId);
      await noHorizontalOverflow(page);
    }
    await page.getByRole("tab", { name: "Header", exact: true }).click();
    await expect(page.locator('input[name="header.name"]')).toHaveValue("Responsive retained form");
    expect(await page.evaluate(key => localStorage.getItem(key), collapsedKey)).toBe("false");
  });

  test.describe("touch workspace", () => {
    test.use({ hasTouch: true });
    test("960x960 coarse pointer retains readable input text in bounded panes", async ({ page }) => {
      await page.setViewportSize({ width: 960, height: 960 });
      await boot(page);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      const editor = (await page.locator(".editor-column").boundingBox())!;
      const preview = (await page.locator(".preview-column").boundingBox())!;
      expect(editor.x + editor.width).toBeLessThanOrEqual(preview.x + 1);
      expect(await page.locator('input[name="header.name"]').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
      await profileTab(page).click();
      expect(await page.locator('textarea[name="profile.0.body"]').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
      await noHorizontalOverflow(page);
    });
  });

});
