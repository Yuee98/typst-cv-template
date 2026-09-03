import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  adminWriteAuthoritySchema,
} from "@/lib/admin/contract";
import {
  createAnonClient,
  createServiceClient,
  createTestUser,
  deleteTestUser,
  RUN_DB_TESTS,
  signInAsUser,
  type TestUser,
} from "./helpers";
import { runOwnerSql } from "./runtime-contract-fixtures";

const base = { p_environment: "local", p_project_ref: "local" };
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

function totpCode(secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.replaceAll("=", "").toUpperCase()) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("invalid TOTP secret");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value =
    (((digest[offset] & 0x7f) << 24) |
      (digest[offset + 1] << 16) |
      (digest[offset + 2] << 8) |
      digest[offset + 3]) %
    1_000_000;
  return value.toString().padStart(6, "0");
}

describe.skipIf(!RUN_DB_TESTS)(
  "Admin write kernel with a real Auth session",
  () => {
    let service: SupabaseClient;
    let admin: SupabaseClient;
    let ordinary: SupabaseClient;
    let adminUser: TestUser;
    let ordinaryUser: TestUser;
    let ownsEnvironment = false;
    let factorId: string | null = null;
    let adminSessionId: string;
    let adminIssuer: string;

    beforeAll(async () => {
      service = createServiceClient();
      adminUser = await createTestUser(service, "admin-write");
      ordinaryUser = await createTestUser(service, "admin-write-ordinary");
      admin = await signInAsUser(adminUser);
      ordinary = await signInAsUser(ordinaryUser);
      const token = (await admin.auth.getSession()).data.session!.access_token;
      const claims = JSON.parse(
        Buffer.from(token.split(".")[1], "base64url").toString(),
      ) as { iss: string; session_id: string };
      adminSessionId = claims.session_id;
      adminIssuer = claims.iss;
      const exists = runOwnerSql(
        "select count(*) from public.admin_environment;",
      ).stdout.match(/\n\s*(\d+)\s*\n/)?.[1];
      if (exists !== "0") {
        throw new Error(
          "Admin tests require an uninitialized local Admin environment; never overwrite operator state",
        );
      }
      runOwnerSql(
        `select public.admin_bootstrap_v1(${literal(adminUser.id)},'local','local',${literal(claims.iss)},'local I06 test bootstrap');`,
      );
      ownsEnvironment = true;
    });

    afterAll(async () => {
      if (factorId && admin) {
        await admin.auth.mfa.unenroll({ factorId });
      }
      if (ownsEnvironment) {
        runOwnerSql(`delete from public.admin_principals where user_id=${literal(adminUser.id)};
          delete from public.admin_environment where environment='local';`);
      }
      if (adminUser) await deleteTestUser(service, adminUser.id);
      if (ordinaryUser) await deleteTestUser(service, ordinaryUser.id);
    });

    it("keeps writes dark and reports no recent TOTP for an AAL1 admin", async () => {
      const { data, error } = await admin.rpc(
        "admin_get_write_authority_v1",
        base,
      );
      expect(error).toBeNull();
      expect(adminWriteAuthoritySchema.parse(data)).toEqual({
        schemaVersion: "admin_write_authority_v1",
        actorUserId: adminUser.id,
        writesEnabled: false,
        recentTotp: false,
      });
      expect(
        (await ordinary.rpc("admin_get_write_authority_v1", base)).error?.code,
      ).toBe("42501");
      expect(
        (await service.rpc("admin_get_write_authority_v1", base)).error?.code,
      ).toBe("42501");
      expect(
        (
          await admin.rpc("admin_disable_ai_v1", {
            ...base,
            p_expected_control_revision: 0,
            p_reason: "dark write must be rejected",
            p_idempotency_key: crypto.randomUUID(),
          })
        ).error?.code,
      ).toBe("42501");
    });

    it("commits and canonically replays an emergency disable after cutover mode", () => {
      const operationKey = crypto.randomUUID();
      const claims = JSON.stringify({
        sub: adminUser.id,
        role: "authenticated",
        session_id: adminSessionId,
        iss: adminIssuer,
        is_anonymous: false,
      });
      const output = runOwnerSql(String.raw`
        begin;
        update public.admin_environment set control_plane_mode='jwt_v1' where id=true;
        update public.ai_feature_config set ai_polish_enabled=true where id=true;
        set local role authenticated;
        set local request.jwt.claims=${literal(claims)};
        select public.admin_disable_ai_v1(
          'local','local',0,'local emergency disable',${literal(operationKey)}
        );
        select public.admin_disable_ai_v1(
          'local','local',0,'local emergency disable',${literal(operationKey)}
        );
        reset role;
        select jsonb_build_object(
          'enabled',(select ai_polish_enabled from public.ai_feature_config where id=true),
          'revision',(select revision from public.admin_ai_control_state_v1 where id=true),
          'cycles',(select count(distinct closing_cycle_id) from public.admin_ai_control_state_v1),
          'operations',(select count(*) from public.admin_committed_operations where idempotency_key=${literal(operationKey)}),
          'audit',(select count(*) from public.admin_audit_events where operation='ai_disable' and reason='local emergency disable')
        );
        rollback;
      `).stdout;
      expect(output.match(/"schemaVersion": "admin_committed_operation_v1"/gu)).toHaveLength(2);
      expect(output).toContain('"aiEnabled": false');
      expect(output).toContain('"enabled": false');
      expect(output).toContain('"revision": 1');
      expect(output).toContain('"cycles": 1');
      expect(output).toContain('"operations": 1');
      expect(output).toContain('"audit": 1');
    });

    it("derives JCS hashes and creates immutable profile and price drafts", () => {
      const claims = JSON.stringify({
        sub: adminUser.id,
        role: "authenticated",
        session_id: adminSessionId,
        iss: adminIssuer,
        is_anonymous: false,
      });
      const profileKey = `admin.test.${crypto.randomUUID()}`;
      const output = runOwnerSql(String.raw`
        begin;
        update public.admin_environment set control_plane_mode='jwt_v1' where id=true;
        set local request.jwt.claims=${literal(claims)};
        select jsonb_build_object(
          'deepseek',public.admin_json_jcs_sha256_v1(
            '{"thinking":"disabled","structuredOutput":"json_object","providerSubjectField":"user_id"}'::jsonb),
          'mimo',public.admin_json_jcs_sha256_v1(
            '{"reasoningEffort":"none","structuredOutput":"prompt_only","sendProviderSubjectId":false}'::jsonb)
        );
        do $body$
        declare v_identity jsonb; v_version jsonb; v_price jsonb;
          v_profile_id uuid; v_profile_version_id uuid;
        begin
          v_identity:=public.admin_create_provider_profile_v1(
            'local','local','706513a5-462b-4bba-93b0-53e50661416e',
            '${profileKey}','Admin local profile','deepseek',
            'local authoring test','${crypto.randomUUID()}'
          );
          v_profile_id:=(v_identity#>>'{result,profileId}')::uuid;
          v_version:=public.admin_create_profile_version_v2(
            'local','local',v_profile_id,0,'deepseek_chat_v1','chat_completions_v1',
            'https://api.deepseek.com/chat/completions','AI_PROVIDER_KEY_DEEPSEEK_PRIMARY',
            'synthetic-admin-model','deepseek_chat_json_object_v1',
            'deepseek_automatic_context_cache_v1','deepseek-official-2026-08-23-v1',
            'admin.test.disclosure',
            '{"thinking":"disabled","structuredOutput":"json_object","providerSubjectField":"user_id"}'::jsonb,
            'local authoring test','${crypto.randomUUID()}'
          );
          v_profile_version_id:=(v_version#>>'{result,profileVersionId}')::uuid;
          v_price:=public.admin_create_price_version_v1(
            'local','local',v_profile_version_id,'default',0,'CNY','linear_token_v1',
            clock_timestamp(),null,null,null,'https://example.com/admin-price',
            clock_timestamp(),'${"9".repeat(64)}','{}'::jsonb,
            '{"input_standard":"100","input_cache_read":"10","output":"200"}'::jsonb,
            'local authoring test','${crypto.randomUUID()}'
          );
          raise notice 'AUTHORING_RESULT=%',jsonb_build_object(
            'profileId',v_profile_id,'profileVersionId',v_profile_version_id,
            'profileVersion',v_version#>>'{result,version}',
            'configSha256',v_version#>>'{result,configSha256}',
            'priceVersion',v_price#>>'{result,version}',
            'priceSealed',v_price#>>'{result,sealed}',
            'operations',(select count(*) from public.admin_committed_operations
              where actor_user_id='${adminUser.id}' and operation_kind in
                ('provider_profile_create','profile_version_create','price_version_create')),
            'audits',(select count(*) from public.admin_audit_events
              where actor='${adminUser.id}' and operation in
                ('provider_profile_create','profile_version_create','price_version_create'))
          );
        end $body$;
        rollback;
      `);
      expect(output.stdout).toContain(
        '"deepseek": "a79bbbaa5934d7f4890b2e97e13e7768f031e99625fe11446ba437feeffc8fa9"',
      );
      expect(output.stdout).toContain(
        '"mimo": "319316de510f767885fdb94d75d067a7383c11f513b908026a2ab4ec68c8a121"',
      );
      expect(output.stderr).toContain("AUTHORING_RESULT=");
      expect(output.stderr).toContain('"profileVersion": "1"');
      expect(output.stderr).toContain('"priceVersion": "1"');
      expect(output.stderr).toContain('"priceSealed": "false"');
      expect(output.stderr).toContain('"operations": 3');
      expect(output.stderr).toContain('"audits": 3');
    });

    it("exposes no table DML or internal helper to application roles", async () => {
      for (const client of [createAnonClient(), ordinary, admin, service]) {
        expect(
          (await client.from("admin_committed_operations").select("id")).error
            ?.code,
        ).toBe("42501");
        expect(
          (
            await client.rpc("admin_assert_write_actor_v1", {
              ...base,
              p_require_recent_totp: false,
            })
          ).error?.code,
        ).toBe("42501");
        expect(
          (
            await client.rpc("admin_lock_committed_operation_v1", {
              p_actor: adminUser.id,
              p_operation_kind: "test",
              p_idempotency_key: crypto.randomUUID(),
              p_typed_payload: {},
            })
          ).error?.code,
        ).toBe("42501");
      }
    });

    it("canonically replays the same payload and rejects a reused key", () => {
      const operationKey = crypto.randomUUID();
      const auditId = crypto.randomUUID();
      const output = runOwnerSql(String.raw`
        begin;
        insert into public.admin_audit_events(id,operation,actor,target_id,reason)
        values (${literal(auditId)},'test_operation',${literal(adminUser.id)},null,'transactional kernel test');
        select public.admin_lock_committed_operation_v1(
          ${literal(adminUser.id)},'test_operation',${literal(operationKey)},
          '{"b":2,"a":1}'::jsonb
        );
        select public.admin_commit_operation_v1(
          ${literal(adminUser.id)},'test_operation',${literal(operationKey)},
          '{"a":1,"b":2}'::jsonb,'{"value":"committed"}'::jsonb,${literal(auditId)}
        );
        select public.admin_lock_committed_operation_v1(
          ${literal(adminUser.id)},'test_operation',${literal(operationKey)},
          '{"a":1,"b":2}'::jsonb
        );
        rollback;
      `).stdout;
      expect(output).toContain('"found": false');
      expect(output).toContain('"schemaVersion": "admin_committed_operation_v1"');
      expect(output).toContain('"found": true');
      expect(output).toContain('"value": "committed"');

      const conflict = runOwnerSql(
        String.raw`
          begin;
          insert into public.admin_audit_events(id,operation,actor,target_id,reason)
          values (${literal(auditId)},'test_operation',${literal(adminUser.id)},null,'transactional kernel test');
          select public.admin_lock_committed_operation_v1(
            ${literal(adminUser.id)},'test_operation',${literal(operationKey)},'{"a":1}'::jsonb
          );
          select public.admin_commit_operation_v1(
            ${literal(adminUser.id)},'test_operation',${literal(operationKey)},
            '{"a":1}'::jsonb,'{"value":"committed"}'::jsonb,${literal(auditId)}
          );
          select public.admin_lock_committed_operation_v1(
            ${literal(adminUser.id)},'test_operation',${literal(operationKey)},'{"a":2}'::jsonb
          );
          rollback;
        `,
        { expectFailure: true },
      );
      expect(conflict.stderr).toContain("IDEMPOTENCY_CONFLICT");
    });

    it("uses an actual verified TOTP challenge and rejects stale factor evidence", async () => {
      const enrolled = await admin.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "local-i06-test",
      });
      expect(enrolled.error).toBeNull();
      if (!enrolled.data?.id || !enrolled.data.totp?.secret) {
        throw new Error("local TOTP enrollment returned no factor");
      }
      factorId = enrolled.data.id;
      const verified = await admin.auth.mfa.challengeAndVerify({
        factorId,
        code: totpCode(enrolled.data.totp.secret),
      });
      expect(verified.error).toBeNull();
      const token = verified.data?.access_token;
      if (!token) throw new Error("local TOTP verification returned no token");
      const claims = JSON.parse(
        Buffer.from(token.split(".")[1], "base64url").toString(),
      ) as { aal?: unknown; amr?: unknown };
      expect(claims.aal).toBe("aal2");
      expect(claims.amr).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: "totp" }),
        ]),
      );

      const current = await admin.rpc("admin_get_write_authority_v1", base);
      expect(current.error).toBeNull();
      expect(adminWriteAuthoritySchema.parse(current.data).recentTotp).toBe(
        true,
      );

      runOwnerSql(
        `update auth.mfa_factors set last_challenged_at=clock_timestamp()-interval '11 minutes' where id=${literal(factorId)} and user_id=${literal(adminUser.id)};`,
      );
      const stale = await admin.rpc("admin_get_write_authority_v1", base);
      expect(stale.error).toBeNull();
      expect(adminWriteAuthoritySchema.parse(stale.data).recentTotp).toBe(false);
    });
  },
);
