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

const CONTEXT = { p_environment: "local", p_project_ref: "local" } as const;

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

function readJsonLine(stdout: string): Record<string, unknown> {
  const line = stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .findLast((value) => value.startsWith("{") && value.endsWith("}"));
  if (!line) throw new Error(`owner SQL returned no JSON assertion: ${stdout}`);
  return JSON.parse(line) as Record<string, unknown>;
}

describe.skipIf(!RUN_DB_TESTS)(
  "CFG-005 configuration lifecycle publication (real DB)",
  () => {
    let service: SupabaseClient;
    let admin: SupabaseClient;
    let adminUser: TestUser;
    let factorId: string | null = null;
    let jwtClaims: string;
    let sealFixture: ConfigSimplificationV2Fixture;
    let fixture: ConfigSimplificationV2Fixture;
    let wrongFixture: ConfigSimplificationV2Fixture;
    let reportId: string;
    let wrongReportId: string;
    let ownsEnvironment = false;

    async function recordReport(
      target: ConfigSimplificationV2Fixture,
    ): Promise<string> {
      const report = await service.rpc(
        "record_admin_config_validation_report_v2",
        {
          p_runtime_contract_id: target.runtimeContractId,
          p_runtime_target_id: target.runtimeTargetId,
          p_observed_code_capability_sha256: target.codeCapabilitySha256,
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
        runtimeTargetId: target.runtimeTargetId,
      });
      return (report.data as { reportId: string }).reportId;
    }

    beforeAll(async () => {
      service = createServiceClient();
      adminUser = await createTestUser(service, "config-simplification-publication");
      admin = await signInAsUser(adminUser);

      const initialToken = (await admin.auth.getSession()).data.session!
        .access_token;
      const initialClaims = JSON.parse(
        Buffer.from(initialToken.split(".")[1], "base64url").toString(),
      ) as { iss: string };
      const environments = runOwnerSql(
        "select count(*) from public.admin_environment;",
      ).stdout.match(/\n\s*(\d+)\s*\n/u)?.[1];
      expect(environments).toBe("0");
      runOwnerSql(
        `select public.admin_bootstrap_v1(${sql(adminUser.id)},'local','local',${sql(initialClaims.iss)},'CFG-005 publication test bootstrap');`,
      );
      ownsEnvironment = true;

      const enrolled = await admin.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "config-simplification-publication",
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
      jwtClaims = Buffer.from(
        verified.data.access_token.split(".")[1],
        "base64url",
      ).toString();

      sealFixture = createConfigSimplificationV2Fixture({ prepareOnly: true });
      fixture = createConfigSimplificationV2Fixture();
      wrongFixture = createConfigSimplificationV2Fixture();
      reportId = await recordReport(fixture);
      wrongReportId = await recordReport(wrongFixture);
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
    });

    it("publishes and retires V2 configuration with real validation evidence", () => {
      const policyKey = `test.config-simplification.publication.${crypto.randomUUID()}`;
      const promotionKey = crypto.randomUUID();
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
          '{}'::uuid[],0,0,'CFG-005 publication authority cutover'
        );
        set local role authenticated;
        set local request.jwt.claims=${sql(jwtClaims)};
        do $assert$
        declare
          sealed jsonb; promoted jsonb; replay jsonb; canary jsonb; created jsonb;
          transitioned jsonb; closed jsonb; retired_version jsonb; retired_profile jsonb;
          policy_id uuid;
        begin
          sealed:=public.admin_seal_price_for_activation_v2(
            'local','local','${sealFixture.priceVersionId}',
            '${sealFixture.runtimeContractId}',
            'seal prepared V2 price before target binding',extensions.gen_random_uuid()
          );
          if sealed#>>'{result,sealed}' <> 'true' then
            raise exception 'price seal did not persist';
          end if;

          begin
            perform public.admin_transition_profile_version_v2(
              'local','local','${fixture.profileVersionId}','validated',
              '${wrongReportId}','wrong report must be rejected',extensions.gen_random_uuid()
            );
            raise exception 'wrong report unexpectedly promoted profile';
          exception when check_violation then
            if sqlerrm <> 'VALIDATION_REPORT_MISMATCH' then raise; end if;
          end;

          promoted:=public.admin_transition_profile_version_v2(
            'local','local','${fixture.profileVersionId}','validated',
            '${reportId}','validate profile with V2 report','${promotionKey}'
          );
          replay:=public.admin_transition_profile_version_v2(
            'local','local','${fixture.profileVersionId}','validated',
            '${reportId}','validate profile with V2 report','${promotionKey}'
          );
          if promoted is distinct from replay
             or promoted#>>'{result,status}' <> 'validated'
             or promoted#>>'{result,validationReportId}' <> '${reportId}' then
            raise exception 'profile promotion replay did not preserve the committed result';
          end if;
          canary:=public.admin_transition_profile_version_v2(
            'local','local','${fixture.profileVersionId}','canary',
            '${reportId}','canary profile with V2 report',extensions.gen_random_uuid()
          );
          if canary#>>'{result,status}' <> 'canary' then
            raise exception 'profile canary transition did not persist';
          end if;

          created:=public.admin_create_routing_policy_v2(
            'local','local','${policyKey}',0,
            '${rules}'::jsonb,'${fixture.profileVersionId}',
            '${fixture.legalBundleVersion}','${fixture.runtimeContractId}',
            array['${reportId}'::uuid],'create V2 publication policy',extensions.gen_random_uuid()
          );
          policy_id:=(created#>>'{result,policyVersionId}')::uuid;
          if created#>>'{result,status}' <> 'draft' then
            raise exception 'policy create did not return a draft';
          end if;
          transitioned:=public.admin_transition_routing_policy_v2(
            'local','local',policy_id,'validated',array['${reportId}'::uuid],
            'validate V2 publication policy',extensions.gen_random_uuid()
          );
          if transitioned#>>'{result,status}' <> 'validated' then
            raise exception 'policy validation did not persist';
          end if;
          transitioned:=public.admin_transition_routing_policy_v2(
            'local','local',policy_id,'canary',array['${reportId}'::uuid],
            'canary V2 publication policy',extensions.gen_random_uuid()
          );
          if transitioned#>>'{result,status}' <> 'canary' then
            raise exception 'policy canary did not persist';
          end if;
          transitioned:=public.admin_transition_routing_policy_v2(
            'local','local',policy_id,'retired',array['${reportId}'::uuid],
            'retire V2 publication policy',extensions.gen_random_uuid()
          );
          if transitioned#>>'{result,status}' <> 'retired' then
            raise exception 'policy retirement did not persist';
          end if;

          closed:=public.admin_close_price_version_v2(
            'local','local','${fixture.priceVersionId}',clock_timestamp(),null,
            '${reportId}','close retired V2 price',extensions.gen_random_uuid()
          );
          if closed#>>'{result,validTo}' is null then
            raise exception 'price closure did not persist';
          end if;
          retired_version:=public.admin_retire_profile_version_v2(
            'local','local','${fixture.profileVersionId}','${reportId}',
            'retire V2 profile version',extensions.gen_random_uuid()
          );
          if retired_version#>>'{result,status}' <> 'retired' then
            raise exception 'profile version retirement did not persist';
          end if;
          retired_profile:=public.admin_retire_provider_profile_v2(
            'local','local','${fixture.profileId}','${reportId}',
            'retire V2 profile identity',extensions.gen_random_uuid()
          );
          if retired_profile#>>'{result,retired}' <> 'true' then
            raise exception 'profile identity retirement did not persist';
          end if;
        end;
        $assert$;
        reset role;
        select json_build_object(
          'policyStatus',(select status from public.ai_routing_policy_versions where policy_key='${policyKey}'),
          'sealPriceSealed',(select components_sealed_at is not null from public.ai_price_versions where id='${sealFixture.priceVersionId}'),
          'sealTargetCount',(select count(*) from public.ai_runtime_target_bindings_v2 where runtime_contract_id='${sealFixture.runtimeContractId}'),
          'priceClosed',(select valid_to is not null from public.ai_price_versions where id='${fixture.priceVersionId}'),
          'versionRetired',(select status='retired' and retired_at is not null from public.ai_provider_profile_versions where id='${fixture.profileVersionId}'),
          'profileRetired',(select retired_at is not null from public.ai_provider_profiles where id='${fixture.profileId}')
        )::text;
        rollback;
      `);

      expect(result.status, result.stderr).toBe(0);
      expect(readJsonLine(result.stdout)).toEqual({
        policyStatus: "retired",
        sealPriceSealed: true,
        sealTargetCount: 0,
        priceClosed: true,
        versionRetired: true,
        profileRetired: true,
      });
    });
  },
);
