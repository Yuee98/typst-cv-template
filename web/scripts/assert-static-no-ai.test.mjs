import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { assertStaticNoAi, STATIC_AI_DENYLIST } from "./assert-static-no-ai.mjs";

const tempDirs = [];

async function makeOutput() {
  const directory = await mkdtemp(join(tmpdir(), "cv-static-ai-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function directoryStat() {
  return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
}

function fileStat() {
  return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
}

function otherStat() {
  return { isDirectory: () => false, isFile: () => false, isSymbolicLink: () => false };
}

function runCli(output) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./assert-static-no-ai.mjs", import.meta.url)), output]);
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("assertStaticNoAi", () => {
  it("accepts clean nested regular files", async () => {
    const output = await makeOutput();
    await mkdir(join(output, "_next", "static"), { recursive: true });
    await writeFile(join(output, "index.html"), "<main>CV</main>");
    await writeFile(join(output, "_next", "static", "app.js"), Buffer.from([0, 1, 2, 3]));

    await expect(assertStaticNoAi(output)).resolves.toEqual({ filesScanned: 2 });
  });

  it.each(STATIC_AI_DENYLIST)("fails with only the marker and relative path for nested %s leakage", async (marker) => {
    const output = await makeOutput();
    await mkdir(join(output, "_next", "static"), { recursive: true });
    const index = STATIC_AI_DENYLIST.indexOf(marker);
    const relativePath = `_next/static/leak-${index}.bin`;
    const sentinel = `private-sentinel-${index}`;
    await writeFile(join(output, relativePath), `${sentinel}${marker}${sentinel}`);

    await expect(assertStaticNoAi(output)).rejects.toThrow(
      `Static AI artifact check failed: marker "${marker}" found in ${relativePath}.`,
    );
    try {
      await assertStaticNoAi(output);
    } catch (error) {
      expect(error.message).not.toContain(sentinel);
    }
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

  it("visits nested fake entries in deterministic byte order", async () => {
    const visited = [];
    const root = join(await makeOutput(), "synthetic");
    const nested = join(root, "nested");
    const fsOps = {
      lstat: async (path) => (path === root || path === nested ? directoryStat() : fileStat()),
      readdir: async (path) => {
        if (path === root) return [{ name: "nested" }];
        return [{ name: "z.bin" }, { name: "a.bin" }];
      },
      readFile: async (path) => {
        visited.push(path);
        return Buffer.from("clean");
      },
    };

    await expect(assertStaticNoAi(root, { fsOps })).resolves.toEqual({ filesScanned: 2 });
    expect(visited).toEqual([join(nested, "a.bin"), join(nested, "z.bin")]);
  });

  it("fails closed for a nested non-regular entry without relying on filesystem permissions", async () => {
    const root = join(await makeOutput(), "synthetic");
    const fsOps = {
      lstat: async (path) => (path === root ? directoryStat() : otherStat()),
      readdir: async () => [{ name: "pipe" }],
      readFile: async () => Buffer.from("clean"),
    };

    await expect(assertStaticNoAi(root, { fsOps })).rejects.toThrow("non-regular file is not allowed: pipe.");
  });

  it("fails closed for unreadable nested directories and regular files without relying on chmod", async () => {
    const root = join(await makeOutput(), "synthetic");
    const unreadableDirectoryOps = {
      lstat: async () => directoryStat(),
      readdir: async () => { throw new Error("denied"); },
      readFile: async () => Buffer.from("clean"),
    };
    await expect(assertStaticNoAi(root, { fsOps: unreadableDirectoryOps })).rejects.toThrow(
      "unable to read directory .",
    );

    const unreadableFileOps = {
      lstat: async (path) => (path === root ? directoryStat() : fileStat()),
      readdir: async () => [{ name: "locked.bin" }],
      readFile: async () => { throw new Error("denied"); },
    };
    await expect(assertStaticNoAi(root, { fsOps: unreadableFileOps })).rejects.toThrow(
      "unable to read regular file locked.bin.",
    );
  });

  it("CLI exits nonzero and does not echo neighboring artifact content", async () => {
    const output = await makeOutput();
    const sentinel = "cli-private-sentinel";
    await writeFile(join(output, "leak.js"), `${sentinel}${STATIC_AI_DENYLIST[0]}${sentinel}`);

    const result = await runCli(output);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('marker "/api/polish" found in leak.js.');
    expect(result.stderr).not.toContain(sentinel);
  });
});
