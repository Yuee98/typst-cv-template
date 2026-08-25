import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertStaticNoAi } from "./assert-static-no-ai.mjs";

const tempDirs = [];

async function makeOutput() {
  const directory = await mkdtemp(join(tmpdir(), "cv-static-ai-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("assertStaticNoAi", () => {
  it("accepts clean nested regular files", async () => {
    const output = await makeOutput();
    await mkdir(join(output, "_next", "static"), { recursive: true });
    await writeFile(join(output, "index.html"), "<main>CV</main>");
    await writeFile(join(output, "_next", "static", "app.js"), Buffer.from([0, 1, 2, 3]));

    await expect(assertStaticNoAi(output)).resolves.toEqual({ filesScanned: 2 });
  });

  it("fails with only the relative file and marker when a nested artifact leaks", async () => {
    const output = await makeOutput();
    await mkdir(join(output, "_next", "static"), { recursive: true });
    await writeFile(join(output, "_next", "static", "app.js"), "prefix /api/polish secret-looking-body");

    await expect(assertStaticNoAi(output)).rejects.toThrow(
      'Static AI artifact check failed: marker "/api/polish" found in _next/static/app.js.',
    );
  });

  it("fails closed when the output directory is missing", async () => {
    const output = join(await makeOutput(), "missing");

    await expect(assertStaticNoAi(output)).rejects.toThrow("Static export directory is missing or not a directory");
  });

  it("fails closed on a symbolic link when the platform permits creating one", async () => {
    const output = await makeOutput();
    const target = join(output, "target.js");
    const link = join(output, "linked.js");
    await writeFile(target, "clean");
    try {
      await symlink(target, link, "file");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EPERM") return;
      throw error;
    }

    await expect(assertStaticNoAi(output)).rejects.toThrow("symbolic link is not allowed");
  });
});
