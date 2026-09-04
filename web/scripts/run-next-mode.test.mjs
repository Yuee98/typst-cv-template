import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { GENERATED_ROUTES, syncApiRoutes } from "./run-next-mode.mjs";

const source = await readFile(new URL("./run-next-mode.mjs", import.meta.url), "utf8");
it("injects a false public AI flag only for static builds", () => {
  expect(source).toContain('...(mode === "static" ? { NEXT_PUBLIC_AI_POLISH_ENABLED: "false" } : {}),');
});
it("preserves the caller environment before applying the static-only override", () => {
  expect(source.indexOf("...process.env,")).toBeLessThan(source.indexOf('...(mode === "static" ? { NEXT_PUBLIC_AI_POLISH_ENABLED: "false" } : {}),'));
});
it("keeps the conflicting static flag guard ahead of generated-route mutation", () => {
  expect(source.indexOf("checkFlagConsistency(mode);")).toBeLessThan(source.indexOf("await syncApiRoutes(mode);"));
});

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "admin-routes-")); roots.push(root); return root; }

it("cycles server/static/server with a complete owned manifest", async () => {
  const root = await fixture();
  await syncApiRoutes("server", root);
  const first = await Promise.all(GENERATED_ROUTES.map(({ file }) => readFile(join(root, file), "utf8")));
  await writeFile(join(root, "src/app/api/keep.txt"), "unrelated");
  await syncApiRoutes("static", root);
  for (const { file } of GENERATED_ROUTES) await expect(stat(join(root, file))).rejects.toThrow();
  expect(await readFile(join(root, "src/app/api/keep.txt"), "utf8")).toBe("unrelated");
  await syncApiRoutes("server", root);
  expect(await Promise.all(GENERATED_ROUTES.map(({ file }) => readFile(join(root, file), "utf8")))).toEqual(first);
  const adminLayout = GENERATED_ROUTES.find(({ file }) => file.endsWith("admin/layout.tsx"));
  expect(adminLayout?.source).toContain('referrer: "no-referrer"');
});

it.each(["server", "static"])("refuses an unknown file before any %s mutations", async (mode) => {
  const root = await fixture();
  const last = join(root, GENERATED_ROUTES.at(-1).file);
  await mkdir(dirname(last), { recursive: true });
  await writeFile(last, "handwritten");
  await expect(syncApiRoutes(mode, root)).rejects.toThrow("hand-written");
  expect(await readFile(last, "utf8")).toBe("handwritten");
  await expect(stat(join(root, GENERATED_ROUTES[0].file))).rejects.toThrow();
});
