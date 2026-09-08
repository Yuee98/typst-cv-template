import { createHmac } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createConfigSimplificationV2Fixture,
  type ConfigSimplificationV2Fixture,
} from "./config-simplification-fixtures";
import {
  createServiceClient,
  createTestUser,
  deleteTestUser,
  RUN_DB_TESTS,
  signInAsUser,
  type TestUser,
} from "./helpers";
import { runOwnerSql } from "./runtime-contract-fixtures";

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

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
  "CFG-005 successor lifecycle audit reads (real DB)",
  () => {
    let service: SupabaseClient;
    let admin: SupabaseClient;
    let adminUser: TestUser;
    let ordinaryUser: TestUser;
    let adminClaims: string;
    let ordinaryClaims: string;
    let factorId: string | null = null;
    let sealFixture: ConfigSimplificationV2Fixture;
    let fixture: ConfigSimplificationV2Fixture;
    let reportId: string;
    let ownsEnvironment = false;

    async function recordReport(): Promise<string> {
      const report = await service.rpc(
        "record_admin_config_validation_report_v2",
        {
          p_runtime_contract_id: fixture.runtimeContractId,
          p_runtime_target_id: fixture.runtimeTargetId,
          p_observed_code_capability_sha256: fixture.codeCapabilitySha256,
          p_endpoint_policy_valid: true,
          p_credential_binding_valid: true,
          p_credential_configured: true,
          p_compiled_capability_valid: true,
        },
      );
      expect(report.error).toBeNull();
      expect(report.data).toMatchObject({
        schemaVersion: "admin_config_validation_report_v2",
        passed: true,
      });
      return (report.data as { reportId: string }).reportId;
    }

    beforeAll(async () => {
      service = createServiceClient();
      adminUser = await createTestUser(service, "config-simplification-audit");
      ordinaryUser = await createTestUser(
        service,
        "config-simplification-audit-ordinary",
      );
      admin = await signInAsUser(adminUser);
      const ordinary = await signInAsUser(ordinaryUser);
      const initialToken = (await admin.auth.getSession()).data.session!
        .access_token;
      const initialClaims = JSON.parse(
        Buffer.from(initialToken.split(".")[1], "base64url").toString(),
      ) as { iss: string };
      ordinaryClaims = Buffer.from(
        (await ordinary.auth.getSession()).data.session!.access_token.split(".")[1],
        "base64url",
      ).toString();
      const environments = runOwnerSql(
        "select count(*) from public.admin_environment;",
      ).stdout.match(/\n\s*(\d+)\s*\n/u)?.[1];
      expect(environments).toBe("0");
      runOwnerSql(
        `select public.admin_bootstrap_v1(${sql(adminUser.id)},'local','local',${sql(initialClaims.iss)},'CFG-005 audit read bootstrap');`,
      );
      ownsEnvironment = true;

      const enrolled = await admin.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "config-simplification-audit",
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
      if (!verified.data?.access_token) {
        throw new Error("local TOTP verification returned no access token");
      }
      adminClaims = Buffer.from(
        verified.data.access_token.split(".")[1],
        "base64url",
      ).toString();

      sealFixture = createConfigSimplificationV2Fixture({ prepareOnly: true });
      fixture = createConfigSimplificationV2Fixture();
      reportId = await recordReport();
    });

    afterAll(async () => {
      if (factorId && admin) await admin.auth.mfa.unenroll({ factorId });
      if (ownsEnvironment) {
        runOwnerSql(
          `delete from public.admin_principals where user_id=${sql(adminUser.id)};\n` +
            "delete from public.admin_environment where id=true;",
        );
      }
      if (adminUser) await deleteTestUser(service, adminUser.id);
      if (ordinaryUser) await deleteTestUser(service, ordinaryUser.id);
    });

    it("resolves returned successor lifecycle IDs only for the authorized administrator", () => {
      const policyKey = `test.config-simplification.audit.${crypto.randomUUID()}`;
      const rules = JSON.stringify({
        schemaVersion: "routing_rules_v1",
        defaultRoute: {
          profileVersionId: fixture.profileVersionId,
          priceVersionId: fixture.priceVersionId,
        },
        windows: [],
      });
      const result = runOwnerSql(String.raw`
        begin;
        select public.admin_cutover_authority_v3(
          '{}'::uuid[],0,0,'CFG-005 audit read authority cutover'
        );
        set local role authenticated;
        set local request.jwt.claims=${sql(adminClaims)};
        create temporary table audit_ids(
          event_type text primary key,
          lifecycle_audit_id uuid not null,
          runtime_contract_id text not null,
          validation_report_ids uuid[] not null
        ) on commit drop;

        with response as (
          select public.admin_seal_price_for_activation_v2(
            'local','local','${sealFixture.priceVersionId}',
            '${sealFixture.runtimeContractId}',
            'seal prepared price for protected audit read',extensions.gen_random_uuid()
          ) as result
        ) insert into audit_ids(event_type,lifecycle_audit_id,runtime_contract_id,validation_report_ids)
          select 'price_seal',(result#>>'{result,lifecycleAuditId}')::uuid,
            '${sealFixture.runtimeContractId}','{}'::uuid[] from response;

        with response as (
          select public.admin_transition_profile_version_v2(
            'local','local','${fixture.profileVersionId}','validated',
            '${reportId}','validate profile for protected audit read',extensions.gen_random_uuid()
          ) as result
        ) insert into audit_ids(event_type,lifecycle_audit_id,runtime_contract_id,validation_report_ids)
          select 'profile_version_transition',(result#>>'{result,lifecycleAuditId}')::uuid,
            '${fixture.runtimeContractId}',array['${reportId}'::uuid] from response;

        select public.admin_transition_profile_version_v2(
          'local','local','${fixture.profileVersionId}','canary',
          '${reportId}','canary profile for protected audit read',extensions.gen_random_uuid()
        );
        with response as (
          select public.admin_create_routing_policy_v2(
            'local','local','${policyKey}',0,'${rules}'::jsonb,
            '${fixture.profileVersionId}','${fixture.legalBundleVersion}',
            '${fixture.runtimeContractId}',array['${reportId}'::uuid],
            'create policy for protected audit read',extensions.gen_random_uuid()
          ) as result
        ) insert into audit_ids(event_type,lifecycle_audit_id,runtime_contract_id,validation_report_ids)
          select 'policy_create',(result#>>'{result,lifecycleAuditId}')::uuid,
            '${fixture.runtimeContractId}',array['${reportId}'::uuid] from response;

        do $admin_assert$
        declare expected record; page jsonb; item jsonb;
        begin
          for expected in select * from audit_ids order by event_type loop
            page:=public.admin_get_record_v1(
              'local','local','audit',expected.lifecycle_audit_id
            );
            item:=page->'items'->0;
            if jsonb_array_length(page->'items')<>1
               or item->>'eventSchemaVersion'<>'config_lifecycle_event_v2'
               or item->>'source'<>'config_lifecycle'
               or item->>'sourceId'<>expected.lifecycle_audit_id::text
               or item->>'operationId' is null
               or item->>'correlationAuditId' is null
               or item->>'runtimeContractId'<>expected.runtime_contract_id
               or item->'validationReportIds' is distinct from to_jsonb(expected.validation_report_ids)
               or (expected.event_type='price_seal' and (
                 item->>'codeCapabilityId'<>'${sealFixture.codeCapabilityId}'
                 or item->>'codeCapabilitySha256'<>'${sealFixture.codeCapabilitySha256}'
               ))
               or (expected.event_type='profile_version_transition'
                 and item->'change' is distinct from jsonb_build_object(
                   'fromStatus','draft','toStatus','validated'
                 ))
               or item ? 'metadata' then
              raise exception 'authorized successor audit projection did not preserve safe identity and correlation';
            end if;
          end loop;
        end;
        $admin_assert$;

        set local request.jwt.claims=${sql(ordinaryClaims)};
        do $ordinary_assert$
        declare v_id uuid;
        begin
          select lifecycle_audit_id into v_id from audit_ids limit 1;
          begin
            perform public.admin_get_record_v1('local','local','audit',v_id);
            raise exception 'ordinary user read a protected audit event';
          exception when insufficient_privilege then
            null;
          end;
        end;
        $ordinary_assert$;
        reset role;
        select jsonb_build_object(
          'resolved',(select count(*) from audit_ids),
          'events',(select jsonb_agg(event_type order by event_type) from audit_ids)
        )::text;
        rollback;
      `);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/"resolved"\s*:\s*3/u);
      expect(result.stdout).toContain('"price_seal"');
      expect(result.stdout).toContain('"profile_version_transition"');
      expect(result.stdout).toContain('"policy_create"');
    });
  },
);
