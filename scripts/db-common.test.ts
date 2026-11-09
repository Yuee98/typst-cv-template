import assert from "node:assert/strict";
import test from "node:test";
import { buildMigrationManifest } from "./db-common.ts";

const entries = ["foundation", "ai_tables", "legal_tables", "audit_tables", "public_api", "catalog"].map((name, index) => ({
  name: `2026110800000${index}_${name}.sql`,
  digest: String(index + 1).repeat(64)
}));
const names = entries.map(entry => entry.name);

test("the reviewed baseline includes every schema file rather than an assumed first four", () => {
  const original = buildMigrationManifest(entries, names);
  const changed = entries.map(entry => ({ ...entry }));
  changed[4].digest = "a".repeat(64);
  assert.notEqual(buildMigrationManifest(changed, names).baseline_digest, original.baseline_digest);
});

test("an appended migration changes the full manifest while retaining the reviewed baseline", () => {
  const original = buildMigrationManifest(entries, names);
  const appended = buildMigrationManifest([...entries, { name: "20261108000006_ai_fix.sql", digest: "f".repeat(64) }], names);
  assert.equal(appended.baseline_digest, original.baseline_digest);
  assert.notEqual(appended.migration_manifest_digest, original.migration_manifest_digest);
});

test("missing, reordered or duplicate baseline files are rejected", () => {
  assert.throws(() => buildMigrationManifest(entries.slice(1), names));
  assert.throws(() => buildMigrationManifest(entries, [...names].reverse()));
  assert.throws(() => buildMigrationManifest(entries, [names[0], names[0]]));
  assert.throws(() => buildMigrationManifest([...entries].reverse(), names));
});

test("baseline file names cannot escape the migrations directory", () => {
  assert.throws(() => buildMigrationManifest(entries, ["../private.sql"]));
  assert.throws(() => buildMigrationManifest(entries, []));
});

test("different schema file names cannot reuse one migration version", () => {
  const duplicated = [{ ...entries[0], name: "20261108000000_ai.sql" }, { ...entries[1], name: "20261108000000_legal.sql" }];
  assert.throws(() => buildMigrationManifest(duplicated, duplicated.map(entry => entry.name)), /timestamps/);
});
