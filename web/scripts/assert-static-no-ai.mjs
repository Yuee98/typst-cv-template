import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STATIC_AI_DENYLIST = [
  "/api/polish",
  "usePolishFlow",
  "getAvailability",
  "getQuota",
  "PolishFlowProvider",
];

const encodedDenylist = STATIC_AI_DENYLIST.map((marker) => ({ marker, bytes: Buffer.from(marker) }));
const defaultFsOps = Object.freeze({ lstat, readdir, readFile });

function displayPath(root, path) {
  return relative(root, path).split("\\").join("/") || ".";
}

function fail(message) {
  throw new Error(`Static AI artifact check failed: ${message}`);
}

async function readEntry(path, root, fsOps) {
  try {
    return await fsOps.lstat(path);
  } catch {
    fail(`unable to inspect ${displayPath(root, path)}.`);
  }
}

function assertFsOps(fsOps) {
  if (
    !fsOps ||
    typeof fsOps.lstat !== "function" ||
    typeof fsOps.readdir !== "function" ||
    typeof fsOps.readFile !== "function"
  ) {
    fail("filesystem operations are unavailable.");
  }
}

/**
 * Fail closed unless a static export contains only traversable directories and
 * regular files that do not embed an AI client marker. Symbolic links are
 * rejected rather than followed so an artifact cannot escape its output root.
 */
export async function assertStaticNoAi(outputDirectory, { fsOps = defaultFsOps } = {}) {
  assertFsOps(fsOps);
  const root = resolve(outputDirectory);
  let rootStat;
  try {
    rootStat = await fsOps.lstat(root);
  } catch {
    fail("Static export directory is missing or not a directory.");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("Static export directory is missing or not a directory.");
  }

  let filesScanned = 0;

  async function scanDirectory(directory) {
    let entries;
    try {
      entries = await fsOps.readdir(directory, { withFileTypes: true });
    } catch {
      fail(`unable to read directory ${displayPath(root, directory)}.`);
    }

    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const entryStat = await readEntry(path, root, fsOps);
      const displayed = displayPath(root, path);
      if (entryStat.isSymbolicLink()) fail(`symbolic link is not allowed: ${displayed}.`);
      if (entryStat.isDirectory()) {
        await scanDirectory(path);
        continue;
      }
      if (!entryStat.isFile()) fail(`non-regular file is not allowed: ${displayed}.`);

      let bytes;
      try {
        bytes = await fsOps.readFile(path);
      } catch {
        fail(`unable to read regular file ${displayed}.`);
      }
      filesScanned += 1;
      for (const { marker, bytes: markerBytes } of encodedDenylist) {
        if (bytes.indexOf(markerBytes) !== -1) {
          fail(`marker "${marker}" found in ${displayed}.`);
        }
      }
    }
  }

  await scanDirectory(root);
  return { filesScanned };
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const defaultOutput = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
  try {
    const { filesScanned } = await assertStaticNoAi(process.argv[2] ?? defaultOutput);
    console.log(`Static AI artifact check passed: ${filesScanned} regular files scanned.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Static AI artifact check failed.");
    process.exitCode = 1;
  }
}
