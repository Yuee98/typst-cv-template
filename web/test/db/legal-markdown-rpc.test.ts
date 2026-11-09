import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { legalCurrentSchema, legalDocumentSchema } from "../../src/lib/legal/terms-acceptance";
import { isLegalHref, parseLegalMarkdown } from "../../src/lib/legal/markdown";
import { withFixture } from "./fixtures";

type Sample = { id: string; value: string; valid: boolean; repeat?: number };
type MetadataSample = Sample & { field: "zh_title" | "en_title" | "recipient_name" | "effective_date" };
const corpus = JSON.parse(readFileSync(new URL("../../../supabase/test-fixtures/legal-markdown-corpus.json", import.meta.url), "utf8")) as {
  hrefs: Sample[]; bodies: Sample[]; metadata: MetadataSample[];
};
const materialize = (sample: Sample) => sample.value.repeat(sample.repeat ?? 1);
const enabled = process.env.CV_DB_SQL_TEST === "true" || Boolean(process.env.SUPABASE_TEST_URL);
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function privateQuery(database: string, statement: string): unknown {
  // This suite may inspect only its schema-only disposable fixture, never main.
  if (database !== "cv_provider_live_fixture") throw new Error("Unexpected disposable database");
  return JSON.parse(execFileSync("docker", ["exec", "-i", "supabase_db_typst-cv-template", "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], { input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim());
}
function ledger(database: string) {
  return privateQuery(database, `select jsonb_build_object(
    'documents',(select jsonb_agg(to_jsonb(d) order by id) from legal.documents d),
    'document_audits',(select count(*) from audit.documents),
    'operations',(select count(*) from admin.operations),
    'runtime',(select to_jsonb(c) from ai.runtime_control c));`);
}
const documentPayload = () => ({
  id: null as string | null, expected_revision: null as string | null, kind: "AI_PROVIDER",
  zh_title: "独立测试接收方", en_title: "Independent synthetic recipient",
  zh_body: "Synthetic legal body.", en_body: "Synthetic legal body.",
  effective_date: "2026-11-09", recipient_name: "Synthetic legal recipient", enabled: true
});

describe.skipIf(!enabled)("restricted legal Markdown at the authenticated public RPC boundary", () => {
  it("rejects malformed creates and both translated update bodies atomically without poisoning the strict catalog", async () => {
    await withFixture(async fixture => {
      // fixture.admin uses SET LOCAL ROLE authenticated -> public RPC -> COMMIT,
      // with a synthetic valid Auth session/member. No owner write substitutes it.
      const save = (payload: Record<string, unknown>) => fixture.admin("admin_legal_document_save", payload);
      const beforeCreate = ledger(fixture.database);
      for (const field of ["zh_body", "en_body"] as const) {
        expect(() => save({ ...documentPayload(), [field]: "<p>poison</p>" })).toThrow("INVALID_REQUEST/INVALID_LEGAL_BODY");
        expect(() => save({ ...documentPayload(), [field]: "![image](https://example.com/image)", enabled: false })).toThrow("INVALID_REQUEST/INVALID_LEGAL_BODY");
      }
      expect(ledger(fixture.database)).toEqual(beforeCreate);
      const created = save(documentPayload());
      const current = { ...documentPayload(), id: String(created.entity_id), expected_revision: String(created.revision) };
      const roundTrip = () => legalDocumentSchema.parse(fixture.admin("admin_read", {
        expected_environment: "LOCAL", section: "disclosures", kind: "documents", id: current.id
      }).data);
      // Every allowed shape is committed by the actual RPC, including exact
      // UTF-16 capacity, preserved literals, IPv6 and all current official links.
      for (const [index, sample] of corpus.bodies.filter(sample => sample.valid).entries()) {
        const field = index % 2 ? "en_body" : "zh_body";
        const value = materialize(sample);
        expect(() => parseLegalMarkdown(value), sample.id).not.toThrow();
        const receipt = save({ ...current, [field]: value });
        current.expected_revision = String(receipt.revision);
        expect(roundTrip()[field], sample.id).toBe(value);
      }
      for (const sample of corpus.metadata.filter(sample => sample.valid)) {
        const receipt = save({ ...current, [sample.field]: materialize(sample) });
        current.expected_revision = String(receipt.revision);
        expect(roundTrip()[sample.field], sample.id).toBe(materialize(sample));
      }
      const beforeRejectedUpdates = ledger(fixture.database);
      for (const sample of corpus.bodies.filter(sample => !sample.valid)) {
        for (const field of ["zh_body", "en_body"] as const) {
          expect(() => save({ ...current, [field]: materialize(sample) }), `${sample.id}/${field}`).toThrow("INVALID_REQUEST/INVALID_LEGAL_BODY");
        }
      }
      for (const sample of corpus.metadata.filter(sample => !sample.valid)) {
        expect(() => save({ ...current, [sample.field]: materialize(sample) }), sample.id).toThrow();
      }
      expect(ledger(fixture.database)).toEqual(beforeRejectedUpdates);
      const read = await fixture.client.rpc("legal_current");
      expect(read.error).toBeNull();
      expect(() => legalCurrentSchema.parse(read.data)).not.toThrow();
      const availability = await fixture.client.rpc("ai_availability", { p_input: {
        contract_code: "cv_app_db_2", database_instance_id: fixture.instanceId, owner_auth_user_id: fixture.userId
      } });
      expect(availability.error).toBeNull();
      expect(availability.data).toMatchObject({ enabled: true });
    });
  }, 120_000);

  it("uses exactly the same shared URL and Markdown corpus in the SQL guard and strict reader", async () => {
    await withFixture(async fixture => {
      for (const [kind, helper] of [["hrefs", "href_valid"], ["bodies", "markdown_valid"]] as const) {
        const samples = corpus[kind].map(sample => ({ id: sample.id, value: materialize(sample), expected: sample.valid }));
        const actual = privateQuery(fixture.database, `select jsonb_agg(jsonb_build_object('id',x.id,'valid',legal.${helper}(x.value)) order by x.id)
          from jsonb_to_recordset(${literal(JSON.stringify(samples))}::jsonb) x(id text,value text,expected boolean);`) as Array<{ id: string; valid: boolean }>;
        const expected = samples.map(sample => ({ id: sample.id, valid: sample.expected })).sort((a, b) => a.id.localeCompare(b.id, "en"));
        // Compare by identity instead of locale ordering (Postgres may use C).
        expect(Object.fromEntries(actual.map(sample => [sample.id, sample.valid]))).toEqual(Object.fromEntries(expected.map(sample => [sample.id, sample.valid])));
        for (const sample of samples) {
          let readerAccepts: boolean;
          if (kind === "hrefs") readerAccepts = isLegalHref(sample.value);
          else { try { parseLegalMarkdown(sample.value); readerAccepts = true; } catch { readerAccepts = false; } }
          expect(readerAccepts, sample.id).toBe(sample.expected);
        }
      }
    });
  });
});
