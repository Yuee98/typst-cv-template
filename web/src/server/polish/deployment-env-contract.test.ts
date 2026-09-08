import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const environmentExampleUrl = new URL("../../../.env.example", import.meta.url);
const providerSeedMigrationUrl = new URL(
  "../../../../supabase/migrations/20260904000000_ai_provider_binding_v2_expand.sql",
  import.meta.url,
);

function parseEnvironmentAssignments(source: string) {
  const assignments = new Map<string, string>();
  const duplicates: string[] = [];

  for (const line of source.split(/\r?\n/u)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    const [, name, value] = match;
    if (assignments.has(name)) duplicates.push(name);
    assignments.set(name, value);
  }

  return { assignments, duplicates };
}

describe("v2 deployment environment contract", () => {
  it("documents every seeded provider secret binding without deployment identity", () => {
    const environmentExample = readFileSync(environmentExampleUrl, "utf8");
    const migration = readFileSync(providerSeedMigrationUrl, "utf8");
    const { assignments, duplicates } = parseEnvironmentAssignments(environmentExample);
    const seededAliases = [
      ...new Set(
        [...migration.matchAll(/'(AI_PROVIDER_KEY_[A-Z0-9_]+)'/gu)].map(
          (match) => match[1],
        ),
      ),
    ].sort();

    expect(duplicates).toEqual([]);
    expect(seededAliases).toEqual([
      "AI_PROVIDER_KEY_DEEPSEEK_PRIMARY",
      "AI_PROVIDER_KEY_MIMO_PRIMARY",
    ]);

    for (const name of seededAliases) {
      expect(assignments.get(name), `${name} must be an empty server-only placeholder`).toBe("");
      expect(name).not.toMatch(/^NEXT_PUBLIC_/u);
    }
    expect(assignments.has("AI_RUNTIME_BUILD_ID")).toBe(false);
    expect(assignments.has("AI_PROVIDER_BINDING_MANIFEST")).toBe(false);
  });
});
