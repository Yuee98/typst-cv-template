import { validateProviderConfiguration } from "@/server/ai/provider";
import { fixtureProfile } from "@/server/ai/fixtures";
/** Opt-in real PostgreSQL envelope integration. Uses only a disposable local container. */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { polishPostRequestSchema, polishExpectedRouteFromAvailability } from "@/lib/polish/contract";
import { createFakeRuntime } from "@/server/ai/fake";
import { readAvailability } from "@/server/ai/availability";
import { executePolish } from "@/server/ai/runtime";
import { createAiDatabase } from "@/server/ai/database";
import type { SupabaseClient } from "@supabase/supabase-js";
const testUrl = process.env.SUPABASE_TEST_URL;
if (testUrl && (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(testUrl).hostname) || new URL(testUrl).protocol !== "http:")) throw new Error("SQL envelope tests require explicit local Supabase URL");
const enabled = process.env.CV_DB_SQL_TEST === "true" || Boolean(testUrl);
const user = "00000000-0000-4000-8000-000000000091";
let processHandle: ChildProcessWithoutNullStreams;
let pending: {
  marker: string;
  lines: string[];
  stderr: string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
} | null = null;
let sequence = 0;
function sql(statement: string): Promise<string> {
  if (pending) throw new Error("SQL fixture connection must be used serially");
  return new Promise((resolve, reject) => {
    const marker = `CV_SQL_END_${++sequence}`;
    pending = {
      marker,
      lines: [],
      stderr: "",
      resolve,
      reject
    };
    processHandle.stdin.write(`${statement}\n\\echo ${marker}\n`);
  });
}
describe.skipIf(!enabled)("real local PostgreSQL + current AI runtime", () => {
  beforeAll(async () => {
    const container = process.env.CV_DB_TEST_CONTAINER ?? (testUrl ? "supabase_db_typst-cv-template" : "cv-rebuild-sql-test");
    if (!["cv-rebuild-sql-test", "supabase_db_typst-cv-template"].includes(container)) throw new Error("Only reviewed local test containers allowed");
    processHandle = spawn("docker", ["exec", "-i", container, "psql", "-XAtq", "-U", "postgres", "-d", "postgres"], {
      stdio: "pipe"
    });
    let buffer = "";
    processHandle.stdout.on("data", chunk => {
      buffer += String(chunk);
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end).trimEnd();
        buffer = buffer.slice(end + 1);
        if (!pending) continue;
        if (line === pending.marker) {
          const current = pending;
          pending = null;
          if (current.stderr.includes("ERROR:")) current.reject(new Error("Local fixture SQL command failed"));else current.resolve(current.lines.join("\n"));
        } else pending.lines.push(line);
      }
    });
    processHandle.stderr.on("data", chunk => {
      if (pending) pending.stderr += String(chunk);
    });
    processHandle.on("error", error => {
      pending?.reject(error);
      pending = null;
    });
    processHandle.on("exit", () => {
      pending?.reject(new Error("Local fixture SQL connection closed"));
      pending = null;
    });
    const fixture = readFileSync(resolve(process.cwd(), "../supabase/tests/rebuild-ai-boundaries.sql"), "utf8");
    await sql(fixture.slice(0, fixture.indexOf('-- RUNTIME_FIXTURE_SETUP_END')));
  }, 20000);
  afterAll(async () => {
    if (processHandle) {
      await sql("rollback;").catch(() => undefined);
      processHandle.stdin.end();
    }
  });
  it("real service-role RPC JSON decodes and settles against the frozen database configuration", async () => {
    const db = createAiDatabase({
      rpc: async (name: string, args?: {
        p_input?: Record<string, unknown>;
      }) => {
        try {
          if (name !== "app_context" && !['ai_availability', 'ai_quota', 'ai_reserve', 'ai_execution_snapshot', 'ai_attempt_start', 'ai_attempt_complete', 'ai_cancel', 'ai_finalize'].includes(name)) throw new Error("Unexpected RPC");
          const input = args?.p_input;
          const parameter = input ? `'${JSON.stringify(input).replaceAll("'", "''")}'::jsonb` : "";
          const data = JSON.parse(await sql(`set local role service_role;select public.${name}(${parameter});reset role;`));
          return {
            data,
            error: null
          };
        } catch {
          return {
            data: null,
            error: {
              message: "INTERNAL_ERROR",
              details: "LOCAL_SQL_FIXTURE"
            }
          };
        }
      }
    } as unknown as SupabaseClient);
    const capabilities = JSON.parse(await sql("select jsonb_agg(jsonb_build_object('code',code,'adapter_kind',adapter_kind,'wire_api_kind',wire_api_kind,'execution_contract',execution_contract,'calculator_kind',calculator_kind,'cache_policy',cache_policy,'descriptor_digest',descriptor_digest)) from ai.capabilities;"));
    for (const [index, code] of [[1, "DEEPSEEK_RESPONSES"], [2, "MIMO_RESPONSES"], [3, "GEMINI_INTERACTIONS"]] as const) {
      const capability = capabilities.find((row: {
        code: string;
      }) => row.code === code);
      expect(() => validateProviderConfiguration({
        ...fixtureProfile(index),
        capability
      }, {
        AI_PROVIDER_KEY_DEEPSEEK_LOCAL: "local-only",
        AI_PROVIDER_KEY_MIMO_LOCAL: "local-only",
        AI_PROVIDER_KEY_GEMINI_LOCAL: "local-only"
      })).not.toThrow();
    }
    const context = await db.context();
    expect(context.ready).toBe(true);
    const availability = await readAvailability(db, user, context.database_instance_id!, {}, false);
    const request = polishPostRequestSchema.parse({
      clientRequestId: crypto.randomUUID(),
      granularity: "item",
      sectionId: "profile",
      language: "zh",
      items: [{
        id: "i0",
        kind: "profile",
        text: "五年后端开发经验，专注高并发分布式系统。"
      }],
      context: {
        level: 0,
        references: []
      },
      expectedRoute: polishExpectedRouteFromAvailability(availability)
    });
    const fake = createFakeRuntime();
    const result = await executePolish({
      db,
      secret: "isolated-local-test-secret",
      prepare: fake.prepare
    }, user, request, new AbortController().signal);
    expect(result.items[0].polished).toBe(request.items[0].text);
    expect(result.quota.remaining).toBe(99);
    const facts = JSON.parse(await sql("select jsonb_build_object('state',state,'charged',charged,'cost',estimated_cost_nanos::text,'currency',billing_currency) from ai.requests order by id desc limit 1;"));
    expect(facts).toMatchObject({
      state: "FINALIZED",
      charged: true,
      currency: "CNY"
    });
  }, 20000);
});
