import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { createServiceClient, RUN_DB_TESTS } from "./helpers";
import {
  INITIAL_LEGAL_BUNDLE_VERSION,
  runOwnerSql,
} from "./runtime-contract-fixtures";

const DEEPSEEK_PROVIDER_ID = "706513a5-462b-4bba-93b0-53e50661416e";

describe.skipIf(!RUN_DB_TESTS)("runtime and legal evidence v2", () => {
  let service: SupabaseClient;

  beforeAll(() => {
    service = createServiceClient();
  });

  it("publishes the exact compiled capability intersection", () => {
    const result = runOwnerSql(String.raw`
      \pset format unaligned
      \pset tuples_only on
      select jsonb_agg(jsonb_build_object(
        'id', code_capability_id,
        'gateway', gateway_kind,
        'adapter', adapter_kind,
        'wire', wire_api_kind,
        'hash', descriptor_sha256,
        'evidence', implementation_evidence_ids
      ) order by code_capability_id)::text
      from public.ai_runtime_code_capabilities_v2;
    `);
    const line = result.stdout
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .findLast((value) => value.startsWith("["));
    expect(line).toBeDefined();
    expect(JSON.parse(line ?? "null")).toEqual([
      {
        id: "runtime-capability.deepseek-chat-v1.2026-09-04",
        gateway: "direct_deepseek",
        adapter: "deepseek_chat_v1",
        wire: "chat_completions_v1",
        hash: "4e5a92750f77f148e6422dcf05b03d99333b357879dba5fdb7248d16dd08bdf2",
        evidence: [
          "implementation.deepseek-chat-v1.transport-and-parser.2026-09-04",
        ],
      },
      {
        id: "runtime-capability.mimo-responses-v1.2026-09-04",
        gateway: "direct_mimo",
        adapter: "mimo_responses_v1",
        wire: "responses_v1",
        hash: "3d26f7177a60396d63c0c09e7fad914b7a090bad6222c3836482ba512a009b5e",
        evidence: [
          "implementation.mimo-responses-v1.transport-and-parser.2026-09-04",
        ],
      },
    ]);
  });

  it("initializes the protected v2 current identity without changing v1", async () => {
    const result = await service.rpc("get_ai_current_legal_bundle_v2");
    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      schemaVersion: "ai_current_legal_bundle_v2",
      legalBundleVersion: INITIAL_LEGAL_BUNDLE_VERSION,
      revision: 1,
    });
    const legacy = runOwnerSql(String.raw`
      \pset format unaligned
      \pset tuples_only on
      select public.current_ai_terms_version();
    `);
    expect(legacy.stdout).toContain(INITIAL_LEGAL_BUNDLE_VERSION);
  });

  it("seals only strict text-only bilingual display content with exact digest", () => {
    const key = `test-display.${crypto.randomUUID()}`;
    const success = runOwnerSql(String.raw`
      begin;
      with content(value) as (
        values ('{
          "schemaVersion":"legal_display_content_v2",
          "en":{"providerLabel":"DeepSeek","modelLabel":"test-model","blocks":[{"kind":"paragraph","text":"Local test disclosure."}]},
          "zh":{"providerLabel":"DeepSeek","modelLabel":"test-model","blocks":[{"kind":"bulletList","items":["本地测试说明。"]}]}
        }'::jsonb)
      )
      insert into public.ai_legal_display_versions_v2(
        display_disclosure_key, legal_bundle_version, legal_manifest_id,
        provider_id, recipient_key, model_id, content, content_sha256,
        fact_ids, evidence_ids
      )
      select '${key}', '${INITIAL_LEGAL_BUNDLE_VERSION}',
        'deepseek-official-2026-08-23-v1', '${DEEPSEEK_PROVIDER_ID}',
        'deepseek', 'test-model', content.value,
        encode(extensions.digest(convert_to(content.value::text, 'UTF8'), 'sha256'), 'hex'),
        array['fact.local-test'], array['evidence.local-test']
      from content;
      update public.ai_legal_display_versions_v2
      set sealed_at = greatest(clock_timestamp(), created_at)
      where display_disclosure_key = '${key}';
      rollback;
    `);
    expect(success.status).toBe(0);

    for (const content of [
      '{"schemaVersion":"legal_display_content_v2","en":{"providerLabel":"x","modelLabel":"y","blocks":[{"kind":"html","text":"<p>x</p>"}]},"zh":{"providerLabel":"x","modelLabel":"y","blocks":[{"kind":"paragraph","text":"z"}]}}',
      '{"schemaVersion":"legal_display_content_v2","en":{"providerLabel":"x","modelLabel":"y","blocks":[{"kind":"paragraph","text":"z","href":"https://example.com"}]},"zh":{"providerLabel":"x","modelLabel":"y","blocks":[{"kind":"paragraph","text":"z"}]}}',
    ]) {
      const failure = runOwnerSql(String.raw`
        begin;
        insert into public.ai_legal_display_versions_v2(
          display_disclosure_key, legal_bundle_version, legal_manifest_id,
          provider_id, recipient_key, model_id, content, content_sha256,
          fact_ids, evidence_ids
        ) values (
          '${key}', '${INITIAL_LEGAL_BUNDLE_VERSION}',
          'deepseek-official-2026-08-23-v1', '${DEEPSEEK_PROVIDER_ID}',
          'deepseek', 'test-model', '${content.replaceAll("'", "''")}'::jsonb,
          '${"0".repeat(64)}', array['fact.local-test'],
          array['evidence.local-test']
        );
        rollback;
      `, { expectFailure: true });
      expect(failure.stderr).toMatch(/content_check|content hash mismatch/u);
    }
  });

  it("denies direct control-plane DML to every application role", () => {
    const result = runOwnerSql(String.raw`
      do $$
      declare role_name text; table_name text;
      begin
        foreach role_name in array array['anon','authenticated','service_role'] loop
          foreach table_name in array array[
            'public.ai_runtime_code_capabilities_v2',
            'public.ai_legal_display_versions_v2',
            'public.ai_current_legal_bundle_v2',
            'public.ai_runtime_target_bindings_v2'
          ] loop
            if has_table_privilege(role_name, table_name, 'INSERT,UPDATE,DELETE') then
              raise exception 'control-plane DML leaked to % on %', role_name, table_name;
            end if;
          end loop;
        end loop;
      end;
      $$;
    `);
    expect(result.status).toBe(0);
  });
});
