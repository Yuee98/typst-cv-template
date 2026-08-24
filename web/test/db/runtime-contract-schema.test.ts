import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { createAnonClient, createServiceClient, RUN_DB_TESTS } from "./helpers";
import {
  authorSyntheticRuntimeContract,
  DEEPSEEK_LEGAL_MANIFEST_ID,
  DEEPSEEK_LEGAL_MANIFEST_SHA256,
  INITIAL_LEGAL_BUNDLE_SHA256,
  INITIAL_LEGAL_BUNDLE_VERSION,
  runOwnerSql,
} from "./runtime-contract-fixtures";

const PERMISSION_DENIED = "42501";

describe.skipIf(!RUN_DB_TESTS)("runtime contract schema (real DB)", () => {
  let service: SupabaseClient;
  let anon: SupabaseClient;

  beforeAll(() => {
    service = createServiceClient();
    anon = createAnonClient();
  });

  it("freezes the exact additive columns, composite relations, and private grants", () => {
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      do $$
      begin
        if not exists (
          select 1
          from pg_attribute
          where attrelid = 'public.ai_provider_profile_versions'::regclass
            and attname = 'display_disclosure_key'
            and not attnotnull
            and atthasdef is false
        ) then
          raise exception 'display disclosure column is not nullable/no-default';
        end if;

        if not exists (
          select 1
          from pg_constraint
          where conrelid = 'public.ai_service_runtime_contract_targets'::regclass
            and conname = 'ai_service_runtime_contract_targets_contract_fkey'
            and confmatchtype = 'f'
        ) or not exists (
          select 1
          from pg_constraint
          where conrelid = 'public.ai_service_runtime_contract_targets'::regclass
            and conname = 'ai_service_runtime_contract_targets_projection_fkey'
            and confmatchtype = 'f'
        ) or not exists (
          select 1
          from pg_constraint
          where conrelid = 'public.ai_routing_policy_versions'::regclass
            and conname = 'ai_routing_policy_versions_runtime_contract_fkey'
            and confmatchtype = 'f'
        ) or not exists (
          select 1
          from pg_constraint
          where conrelid = 'public.ai_request_ledger'::regclass
            and conname = 'ai_request_ledger_runtime_contract_fkey'
            and confmatchtype = 'f'
        ) then
          raise exception 'runtime composite FK is not MATCH FULL';
        end if;

        if has_table_privilege(
          'service_role',
          'public.ai_service_runtime_contract_versions',
          'SELECT,INSERT,UPDATE,DELETE'
        ) or has_table_privilege(
          'service_role',
          'public.ai_service_runtime_target_versions',
          'SELECT,INSERT,UPDATE,DELETE'
        ) or has_table_privilege(
          'service_role',
          'public.ai_service_runtime_contract_targets',
          'SELECT,INSERT,UPDATE,DELETE'
        ) or has_table_privilege(
          'service_role',
          'public.ai_routing_policy_transition_intents',
          'SELECT,INSERT,UPDATE,DELETE'
        ) then
          raise exception 'service_role has direct runtime/private-intent privileges';
        end if;

        if has_function_privilege(
          'service_role',
          'public.seal_ai_price_components_v1(uuid[],timestamptz)',
          'EXECUTE'
        ) or has_function_privilege(
          'service_role',
          'public.assert_ai_routing_policy_v1(uuid,text,timestamptz)',
          'EXECUTE'
        ) or has_function_privilege(
          'service_role',
          'public.transition_ai_routing_policy_v1(uuid,text)',
          'EXECUTE'
        ) then
          raise exception 'service_role has private validator/seal/transition execute';
        end if;
      end;
      $$;
    `);
  });

  it("binds full target projection and seals one exact immutable target set", () => {
    const runtime = authorSyntheticRuntimeContract();
    const secondContractId = `test-runtime-contract.${crypto.randomUUID()}`;
    const secondContractHash = "7".repeat(64);

    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      begin;
      insert into public.ai_service_runtime_contract_versions (
        runtime_contract_id,
        runtime_contract_sha256,
        reviewed_source_commit_oid,
        legal_bundle_version,
        bundle_contract_sha256,
        runtime_target_set_sha256
      ) values (
        '${secondContractId}',
        '${secondContractHash}',
        'sha1:0123456789abcdef0123456789abcdef01234567',
        '${INITIAL_LEGAL_BUNDLE_VERSION}',
        '${INITIAL_LEGAL_BUNDLE_SHA256}',
        encode(
          extensions.digest(
            convert_to(
              octet_length(convert_to('${runtime.runtimeTargetId}', 'UTF8'))::text
                || ':${runtime.runtimeTargetId}:${runtime.runtimeTargetSha256}',
              'UTF8'
            ),
            'sha256'
          ),
          'hex'
        )
      );

      do $$
      begin
        begin
          insert into public.ai_service_runtime_contract_targets (
            runtime_contract_id,
            runtime_contract_sha256,
            runtime_target_id,
            runtime_target_sha256,
            profile_key,
            legal_manifest_id,
            manifest_sha256,
            route_descriptor_id,
            route_descriptor_sha256
          ) values (
            '${secondContractId}',
            '${secondContractHash}',
            '${runtime.runtimeTargetId}',
            '${runtime.runtimeTargetSha256}',
            '${runtime.profileKey}',
            '${runtime.legalManifestId}',
            '${runtime.manifestSha256}',
            '${runtime.routeDescriptorId}',
            repeat('f', 64)
          );
          raise exception 'wrong target projection was accepted';
        exception when foreign_key_violation then
          null;
        end;
      end;
      $$;

      insert into public.ai_service_runtime_contract_targets (
        runtime_contract_id,
        runtime_contract_sha256,
        runtime_target_id,
        runtime_target_sha256,
        profile_key,
        legal_manifest_id,
        manifest_sha256,
        route_descriptor_id,
        route_descriptor_sha256
      ) values (
        '${secondContractId}',
        '${secondContractHash}',
        '${runtime.runtimeTargetId}',
        '${runtime.runtimeTargetSha256}',
        '${runtime.profileKey}',
        '${runtime.legalManifestId}',
        '${runtime.manifestSha256}',
        '${runtime.routeDescriptorId}',
        '${runtime.routeDescriptorSha256}'
      );

      update public.ai_service_runtime_contract_versions
      set sealed_at = greatest(clock_timestamp(), created_at)
      where runtime_contract_id = '${secondContractId}';

      do $$
      begin
        begin
          update public.ai_service_runtime_contract_targets
          set runtime_contract_sha256 = repeat('8', 64)
          where runtime_contract_id = '${secondContractId}';
          raise exception 'membership parent pair mutation was accepted';
        exception when check_violation then
          null;
        end;

        begin
          delete from public.ai_service_runtime_contract_targets
          where runtime_contract_id = '${secondContractId}';
          raise exception 'sealed membership delete was accepted';
        exception when check_violation then
          null;
        end;

        begin
          update public.ai_service_runtime_target_versions
          set route_descriptor_sha256 = repeat('9', 64)
          where runtime_target_id = '${runtime.runtimeTargetId}';
          raise exception 'global target mutation was accepted';
        exception when check_violation then
          null;
        end;
      end;
      $$;
      rollback;
    `);
  });

  it("rejects empty, unsealed-legal, and out-of-bundle runtime roots", () => {
    const suffix = crypto.randomUUID();
    runOwnerSql(String.raw`
      \set ON_ERROR_STOP on
      begin;
      do $$
      declare
        v_bundle text := 'test-runtime-bundle.${suffix}';
        v_target text := 'test-runtime-target.mimo.${suffix}';
        v_root text := 'test-runtime-root.mimo.${suffix}';
        v_target_hash text := repeat('a', 64);
      begin
        insert into public.ai_legal_bundle_versions (
          legal_bundle_version,
          bundle_contract_sha256,
          manifest_set_sha256
        ) values (
          v_bundle,
          repeat('b', 64),
          encode(
            extensions.digest(
              convert_to(
                octet_length(convert_to('${DEEPSEEK_LEGAL_MANIFEST_ID}', 'UTF8'))::text
                  || ':${DEEPSEEK_LEGAL_MANIFEST_ID}:${DEEPSEEK_LEGAL_MANIFEST_SHA256}',
                'UTF8'
              ),
              'sha256'
            ),
            'hex'
          )
        );
        insert into public.ai_legal_bundle_manifests (
          legal_bundle_version,
          legal_manifest_id,
          manifest_sha256
        ) values (
          v_bundle,
          '${DEEPSEEK_LEGAL_MANIFEST_ID}',
          '${DEEPSEEK_LEGAL_MANIFEST_SHA256}'
        );

        insert into public.ai_service_runtime_contract_versions (
          runtime_contract_id,
          runtime_contract_sha256,
          reviewed_source_commit_oid,
          legal_bundle_version,
          bundle_contract_sha256,
          runtime_target_set_sha256
        ) values (
          'test-empty-root.${suffix}',
          repeat('c', 64),
          'sha1:0123456789abcdef0123456789abcdef01234567',
          v_bundle,
          repeat('b', 64),
          repeat('d', 64)
        );

        begin
          update public.ai_service_runtime_contract_versions
          set sealed_at = greatest(clock_timestamp(), created_at)
          where runtime_contract_id = 'test-empty-root.${suffix}';
          raise exception 'empty/unsealed-legal runtime root was accepted';
        exception when check_violation then
          null;
        end;

        update public.ai_legal_bundle_versions
        set sealed_at = greatest(clock_timestamp(), created_at)
        where legal_bundle_version = v_bundle;

        insert into public.ai_service_runtime_target_versions (
          runtime_target_id,
          runtime_target_sha256,
          profile_key,
          legal_manifest_id,
          manifest_sha256,
          route_descriptor_id,
          route_descriptor_sha256
        ) values (
          v_target,
          v_target_hash,
          'test.runtime.mimo.${suffix}',
          'mimo-cn-2026-08-23-v1',
          'f075f1e39e74a96ef2b536df8ba1e19c0840ce6d3be47d6deccd9c95da861c3f',
          'test-route.mimo.${suffix}',
          repeat('e', 64)
        );

        insert into public.ai_service_runtime_contract_versions (
          runtime_contract_id,
          runtime_contract_sha256,
          reviewed_source_commit_oid,
          legal_bundle_version,
          bundle_contract_sha256,
          runtime_target_set_sha256
        ) values (
          v_root,
          repeat('f', 64),
          'sha1:0123456789abcdef0123456789abcdef01234567',
          v_bundle,
          repeat('b', 64),
          encode(
            extensions.digest(
              convert_to(
                octet_length(convert_to(v_target, 'UTF8'))::text
                  || ':' || v_target || ':' || v_target_hash,
                'UTF8'
              ),
              'sha256'
            ),
            'hex'
          )
        );
        insert into public.ai_service_runtime_contract_targets (
          runtime_contract_id,
          runtime_contract_sha256,
          runtime_target_id,
          runtime_target_sha256,
          profile_key,
          legal_manifest_id,
          manifest_sha256,
          route_descriptor_id,
          route_descriptor_sha256
        ) values (
          v_root,
          repeat('f', 64),
          v_target,
          v_target_hash,
          'test.runtime.mimo.${suffix}',
          'mimo-cn-2026-08-23-v1',
          'f075f1e39e74a96ef2b536df8ba1e19c0840ce6d3be47d6deccd9c95da861c3f',
          'test-route.mimo.${suffix}',
          repeat('e', 64)
        );

        begin
          update public.ai_service_runtime_contract_versions
          set sealed_at = greatest(clock_timestamp(), created_at)
          where runtime_contract_id = v_root;
          raise exception 'out-of-bundle runtime target was accepted';
        exception when check_violation then
          null;
        end;
      end;
      $$;
      rollback;
    `);
  });

  it("denies direct catalog reads and writes to service and anonymous roles", async () => {
    for (const client of [service, anon]) {
      for (const table of [
        "ai_service_runtime_contract_versions",
        "ai_service_runtime_target_versions",
        "ai_service_runtime_contract_targets",
        "ai_routing_policy_transition_intents",
      ] as const) {
        const read = await client.from(table).select("*").limit(1);
        expect(read.data, table).toBeNull();
        expect(read.error?.code, table).toBe(PERMISSION_DENIED);

        const write = await client.from(table).insert({});
        expect(write.error?.code, table).toBe(PERMISSION_DENIED);
      }
    }
  });
});
