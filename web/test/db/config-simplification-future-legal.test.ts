import { createHash, createHmac } from "node:crypto";

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
import {
  DEEPSEEK_LEGAL_MANIFEST_ID,
  DEEPSEEK_LEGAL_MANIFEST_SHA256,
  INITIAL_LEGAL_BUNDLE_VERSION,
  runOwnerSql,
} from "./runtime-contract-fixtures";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function totpCode(secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.replaceAll("=", "").toUpperCase()) {
    bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return (
    (((digest[offset] & 0x7f) << 24) |
      (digest[offset + 1] << 16) |
      (digest[offset + 2] << 8) |
      digest[offset + 3]) %
    1_000_000
  ).toString().padStart(6, "0");
}

describe.skipIf(!RUN_DB_TESTS)(
  "CFG-005 future legal-bundle candidate preparation",
  () => {
    let service: SupabaseClient;
    let adminUser: TestUser;
    let factorId: string | null = null;
    let jwtClaims: string;
    let futureBundleVersion: string;
    let futureBundleContractSha256: string;
    let prepared: ConfigSimplificationV2Fixture;
    let forwardCandidate: ConfigSimplificationV2Fixture;
    let rollbackCandidate: ConfigSimplificationV2Fixture;
    let forwardReportId: string;
    let rollbackReportId: string;

    beforeAll(async () => {
      service = createServiceClient();
      adminUser = await createTestUser(service, "cfg005-future-legal");
      const admin = await signInAsUser(adminUser);
      const token = (await admin.auth.getSession()).data.session!.access_token;
      const issuer = (JSON.parse(
        Buffer.from(token.split(".")[1], "base64url").toString(),
      ) as { iss: string }).iss;
      runOwnerSql(
        `select public.admin_bootstrap_v1(${sql(adminUser.id)},'local','local',${sql(issuer)},'CFG-005 future legal bootstrap');`,
      );
      const enrolled = await admin.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "cfg005-future-legal",
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
      jwtClaims = Buffer.from(
        verified.data!.access_token!.split(".")[1],
        "base64url",
      ).toString();

      futureBundleVersion = `test.future-legal.${crypto.randomUUID()}`;
      futureBundleContractSha256 = sha256(`contract:${futureBundleVersion}`);
      const manifestSetSha256 = sha256(
        `${Buffer.byteLength(DEEPSEEK_LEGAL_MANIFEST_ID, "utf8")}:${DEEPSEEK_LEGAL_MANIFEST_ID}:${DEEPSEEK_LEGAL_MANIFEST_SHA256}`,
      );
      runOwnerSql(String.raw`
        begin;
        insert into public.ai_legal_bundle_versions(
          legal_bundle_version,bundle_contract_sha256,manifest_set_sha256
        ) values (
          '${futureBundleVersion}','${futureBundleContractSha256}','${manifestSetSha256}'
        );
        insert into public.ai_legal_bundle_manifests(
          legal_bundle_version,legal_manifest_id,manifest_sha256
        ) values (
          '${futureBundleVersion}','${DEEPSEEK_LEGAL_MANIFEST_ID}','${DEEPSEEK_LEGAL_MANIFEST_SHA256}'
        );
        update public.ai_legal_bundle_versions set sealed_at=clock_timestamp()
          where legal_bundle_version='${futureBundleVersion}';
        commit;
      `);
      prepared = createConfigSimplificationV2Fixture({
        prepareOnly: true,
        legalBundleVersion: futureBundleVersion,
        bundleContractSha256: futureBundleContractSha256,
      });
      forwardCandidate = createConfigSimplificationV2Fixture({
        legalBundleVersion: futureBundleVersion,
        bundleContractSha256: futureBundleContractSha256,
      });
      rollbackCandidate = createConfigSimplificationV2Fixture({
        legalBundleVersion: futureBundleVersion,
        bundleContractSha256: futureBundleContractSha256,
      });
      const recordReport = async (target: ConfigSimplificationV2Fixture) => {
        const report = await service.rpc("record_admin_config_validation_report_v2", {
          p_runtime_contract_id: target.runtimeContractId,
          p_runtime_target_id: target.runtimeTargetId,
          p_observed_code_capability_sha256: target.codeCapabilitySha256,
          p_endpoint_policy_valid: true,
          p_credential_binding_valid: true,
          p_credential_configured: true,
          p_compiled_capability_valid: true,
        });
        expect(report.error).toBeNull();
        expect(report.data).toMatchObject({ passed: true });
        return (report.data as { reportId: string }).reportId;
      };
      forwardReportId = await recordReport(forwardCandidate);
      rollbackReportId = await recordReport(rollbackCandidate);
    });

    afterAll(async () => {
      if (factorId) {
        const admin = await signInAsUser(adminUser);
        await admin.auth.mfa.unenroll({ factorId });
      }
      if (adminUser) {
        runOwnerSql(
          `delete from public.admin_principals where user_id=${sql(adminUser.id)};\n` +
            "delete from public.admin_environment where id=true;",
        );
        await deleteTestUser(service, adminUser.id);
      }
    });

    it("migrates the current bundle after preparing forward and rollback candidates", () => {
      const forwardPolicyKey = `test.future-legal.forward.${crypto.randomUUID()}`;
      const rollbackPolicyKey = `test.future-legal.rollback.${crypto.randomUUID()}`;
      const baselineResult = runOwnerSql(String.raw`
        select json_build_object(
          'authorityEpoch',coalesce((
            select max(authority_epoch) from public.admin_runtime_authority_receipts_v3
            where environment='local' and project_ref='local' and authority_scope='jwt_v1'
          ),0),
          'currentV2Revision',(select revision from public.ai_current_legal_bundle_v2 where singleton)
        )::text;
      `);
      expect(baselineResult.status, baselineResult.stderr).toBe(0);
      const baselineLine = baselineResult.stdout
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .findLast((value) => value.startsWith("{") && value.endsWith("}"));
      const baseline = JSON.parse(baselineLine!) as {
        authorityEpoch: number;
        currentV2Revision: number;
      };
      const rulesFor = (target: ConfigSimplificationV2Fixture) => JSON.stringify({
        schemaVersion: "routing_rules_v1",
        defaultRoute: {
          profileVersionId: target.profileVersionId,
          priceVersionId: target.priceVersionId,
        },
        windows: [],
      });
      const forwardRules = rulesFor(forwardCandidate);
      const rollbackRules = rulesFor(rollbackCandidate);
      const result = runOwnerSql(String.raw`
        begin;
        create temporary table cfg005_state (
          policy_version_id uuid,
          closing_cycle_id uuid,
          control_revision bigint,
          config_generation bigint,
          readback_report_id uuid
        ) on commit drop;
        grant select, insert, update on table cfg005_state to authenticated, service_role;
        select public.admin_cutover_authority_v3('{}'::uuid[],0,0,'CFG-005 close before future candidate preparation');
        set local role authenticated;
        set local request.jwt.claims=${sql(jwtClaims)};
        do $assert$
        declare sealed jsonb; promoted jsonb; created jsonb; transitioned jsonb; forward_policy_id uuid; rollback_policy_id uuid;
        begin
          if public.current_ai_terms_version() <> '${INITIAL_LEGAL_BUNDLE_VERSION}' then
            raise exception 'test must keep the original bundle current';
          end if;
          sealed:=public.admin_seal_price_for_activation_v2(
            'local','local','${prepared.priceVersionId}','${prepared.runtimeContractId}',
            'seal successor price while original legal bundle is current',extensions.gen_random_uuid()
          );
          if sealed#>>'{result,sealed}' <> 'true' then
            raise exception 'successor price was not sealed';
          end if;
          promoted:=public.admin_transition_profile_version_v2(
            'local','local','${forwardCandidate.profileVersionId}','validated','${forwardReportId}',
            'validate forward successor profile while original legal bundle is current',extensions.gen_random_uuid()
          );
          if promoted#>>'{result,status}' <> 'validated' then
            raise exception 'forward successor profile did not validate';
          end if;
          created:=public.admin_create_routing_policy_v2(
            'local','local','${forwardPolicyKey}',0,'${forwardRules}'::jsonb,
            '${forwardCandidate.profileVersionId}','${futureBundleVersion}','${forwardCandidate.runtimeContractId}',
            array['${forwardReportId}'::uuid],'author forward successor policy while original legal bundle is current',extensions.gen_random_uuid()
          );
          forward_policy_id:=(created#>>'{result,policyVersionId}')::uuid;
          transitioned:=public.admin_transition_routing_policy_v2(
            'local','local',forward_policy_id,'validated',array['${forwardReportId}'::uuid],
            'validate forward successor policy while original legal bundle is current',extensions.gen_random_uuid()
          );
          if transitioned#>>'{result,status}' <> 'validated' then
            raise exception 'forward successor policy did not validate';
          end if;
          insert into pg_temp.cfg005_state(policy_version_id) values(forward_policy_id);
          promoted:=public.admin_transition_profile_version_v2(
            'local','local','${rollbackCandidate.profileVersionId}','validated','${rollbackReportId}',
            'validate rollback successor profile while original legal bundle is current',extensions.gen_random_uuid()
          );
          if promoted#>>'{result,status}' <> 'validated' then
            raise exception 'rollback successor profile did not validate';
          end if;
          created:=public.admin_create_routing_policy_v2(
            'local','local','${rollbackPolicyKey}',0,'${rollbackRules}'::jsonb,
            '${rollbackCandidate.profileVersionId}','${futureBundleVersion}','${rollbackCandidate.runtimeContractId}',
            array['${rollbackReportId}'::uuid],'author rollback successor policy while original legal bundle is current',extensions.gen_random_uuid()
          );
          rollback_policy_id:=(created#>>'{result,policyVersionId}')::uuid;
          transitioned:=public.admin_transition_routing_policy_v2(
            'local','local',rollback_policy_id,'validated',array['${rollbackReportId}'::uuid],
            'validate rollback successor policy while original legal bundle is current',extensions.gen_random_uuid()
          );
          if transitioned#>>'{result,status}' <> 'validated' then
            raise exception 'rollback successor policy did not validate';
          end if;
          begin
            perform public.admin_transition_routing_policy_v2(
              'local','local',forward_policy_id,'canary',array['${forwardReportId}'::uuid],
              'premature forward canary must fail',extensions.gen_random_uuid()
            );
            raise exception 'forward policy became canary before its bundle was current';
          exception when check_violation then null;
          end;
        end;
        $assert$;
        reset role;
        -- This block models the reviewed DB-owner migration.  It retains the
        -- exact public function identity and ACLs, updates both current legal
        -- predicates while the feature remains closed and pointer-free, then
        -- stamps a successor authority receipt from the canonical manifest.
        create or replace function public.current_ai_terms_version()
        returns text
        language sql
        stable
        set search_path = ''
        as $current_terms$
          select '${futureBundleVersion}'::text;
        $current_terms$;
        revoke execute on function public.current_ai_terms_version() from public;
        grant execute on function public.current_ai_terms_version() to authenticated, service_role;
        do $migration$
        declare
          v_config public.ai_feature_config%rowtype;
          v_control public.admin_ai_control_state_v1%rowtype;
          v_current public.ai_current_legal_bundle_v2%rowtype;
          v_manifest jsonb;
          v_manifest_sha256 text;
          v_authority_epoch bigint;
          v_previous_current_revision bigint;
        begin
          select * into v_config from public.ai_feature_config where id=true for update;
          select * into v_control from public.admin_ai_control_state_v1 where id=true for update;
          if v_config.ai_polish_enabled or v_config.active_routing_policy_version_id is not null
             or v_control.closing_cycle_id is null or v_control.reopened_at is not null then
            raise exception 'legal migration requires an AI-off closed control state with no pointer';
          end if;
          select revision into v_previous_current_revision
          from public.ai_current_legal_bundle_v2 where singleton for update;
          if v_previous_current_revision is null then
            raise exception 'v2 current legal identity is missing';
          end if;
          update public.ai_current_legal_bundle_v2
          set legal_bundle_version='${futureBundleVersion}', revision=revision+1,
              updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
          where singleton
          returning * into v_current;
          if v_current.legal_bundle_version <> '${futureBundleVersion}'
             or v_current.revision <> v_previous_current_revision+1 then
            raise exception 'v2 current legal identity did not advance exactly once';
          end if;
          update public.admin_runtime_authority_expected_v3 as expected
          set definition_sha256=encode(extensions.digest(
            replace(replace(pg_catalog.pg_get_functiondef(
              'public.current_ai_terms_version()'::regprocedure
            ),chr(13)||chr(10),chr(10)),chr(13),chr(10)),'sha256'
          ),'hex')
          where expected.signature='public.current_ai_terms_version()';
          if not found then raise exception 'current terms authority entry is missing'; end if;
          if exists (
               select 1
               from pg_catalog.pg_proc as proc
               cross join lateral pg_catalog.aclexplode(
                 coalesce(proc.proacl,pg_catalog.acldefault('f',proc.proowner))
               ) as acl
               where proc.oid='public.current_ai_terms_version()'::regprocedure
                 and acl.grantee=0 and acl.privilege_type='EXECUTE'
             )
             or not pg_catalog.has_function_privilege('authenticated','public.current_ai_terms_version()','EXECUTE')
             or not pg_catalog.has_function_privilege('service_role','public.current_ai_terms_version()','EXECUTE') then
            raise exception 'current terms migration changed the approved execute ACL';
          end if;
          v_manifest:=public.admin_current_runtime_authority_manifest_v3();
          v_manifest_sha256:=encode(extensions.digest(convert_to(v_manifest::text,'UTF8'),'sha256'),'hex');
          select coalesce(max(authority_epoch),0)+1 into v_authority_epoch
          from public.admin_runtime_authority_receipts_v3
          where environment='local' and project_ref='local' and authority_scope='jwt_v1';
          insert into public.admin_runtime_authority_receipts_v3(
            environment,project_ref,authority_scope,authority_epoch,
            authority_manifest,authority_manifest_sha256
          ) values ('local','local','jwt_v1',v_authority_epoch,v_manifest,v_manifest_sha256);
          insert into public.admin_audit_events(operation,actor,reason)
          values ('legal_bundle_current_migration','db_operator','CFG-005 switch current legal bundle under closed gate');
          update pg_temp.cfg005_state
          set closing_cycle_id=v_control.closing_cycle_id,
              control_revision=v_control.revision,
              config_generation=v_config.config_generation;
        end;
        $migration$;
        set local role authenticated;
        set local request.jwt.claims=${sql(jwtClaims)};
        do $activate$
        declare promoted jsonb; transitioned jsonb; pointer jsonb; v_state record;
        begin
          select * into v_state from pg_temp.cfg005_state;
          if v_state.policy_version_id is null then raise exception 'forward candidate policy was not retained'; end if;
          promoted:=public.admin_transition_profile_version_v2(
            'local','local','${forwardCandidate.profileVersionId}','active','${forwardReportId}',
            'activate forward successor profile after legal migration',extensions.gen_random_uuid()
          );
          if promoted#>>'{result,status}' <> 'active' then raise exception 'forward profile did not activate'; end if;
          transitioned:=public.admin_transition_routing_policy_v2(
            'local','local',v_state.policy_version_id,'active',array['${forwardReportId}'::uuid],
            'activate forward successor policy after legal migration',extensions.gen_random_uuid()
          );
          if transitioned#>>'{result,status}' <> 'active' then raise exception 'forward policy did not activate'; end if;
          pointer:=public.admin_set_ai_routing_pointer_v2(
            'local','local',v_state.policy_version_id,array['${forwardReportId}'::uuid],
            v_state.control_revision,null,v_state.config_generation,
            'point to forward successor after legal migration',extensions.gen_random_uuid()
          );
          if pointer#>>'{result,activePolicyVersionId}' <> v_state.policy_version_id::text then
            raise exception 'forward pointer was not published';
          end if;
          update pg_temp.cfg005_state
          set closing_cycle_id=(pointer#>>'{result,closingCycleId}')::uuid,
              control_revision=(pointer#>>'{result,controlRevision}')::bigint,
              config_generation=(pointer#>>'{result,configGeneration}')::bigint;
        end;
        $activate$;
        reset role;
        set local role service_role;
        set local request.jwt.claims='{"role":"service_role"}';
        do $readback$
        declare v_state record; v_readback jsonb;
        begin
          select * into v_state from pg_temp.cfg005_state;
          v_readback:=public.record_admin_runtime_readback_v3(
            'local','local',v_state.policy_version_id,array['${forwardReportId}'::uuid],
            v_state.closing_cycle_id,v_state.control_revision,v_state.config_generation
          );
          if v_readback->>'schemaVersion' <> 'admin_runtime_readback_v3' then
            raise exception 'service readback did not produce V3 evidence';
          end if;
          update pg_temp.cfg005_state set readback_report_id=(v_readback->>'reportId')::uuid;
        end;
        $readback$;
        reset role;
        set local role authenticated;
        set local request.jwt.claims=${sql(jwtClaims)};
        do $reopen$
        declare v_state record; reopened jsonb;
        begin
          select * into v_state from pg_temp.cfg005_state;
          reopened:=public.admin_reopen_ai_v2(
            'local','local',v_state.readback_report_id,v_state.closing_cycle_id,
            v_state.control_revision,v_state.policy_version_id,v_state.config_generation,
            'reopen forward successor after service readback',extensions.gen_random_uuid()
          );
          if reopened#>>'{result,aiEnabled}' <> 'true' then raise exception 'AI did not reopen'; end if;
        end;
        $reopen$;
        reset role;
        select json_build_object(
          'currentBundle',public.current_ai_terms_version(),
          'currentV2Bundle',(select legal_bundle_version from public.ai_current_legal_bundle_v2 where singleton),
          'currentV2Revision',(select revision from public.ai_current_legal_bundle_v2 where singleton),
          'preparedPriceSealed',(select components_sealed_at is not null from public.ai_price_versions where id='${prepared.priceVersionId}'),
          'candidateBundleSealed',(select sealed_at is not null from public.ai_legal_bundle_versions where legal_bundle_version='${futureBundleVersion}'),
          'aiEnabled',(select ai_polish_enabled from public.ai_feature_config where id=true),
          'authorityEpoch',(select max(authority_epoch) from public.admin_runtime_authority_receipts_v3 where environment='local' and project_ref='local' and authority_scope='jwt_v1')
        )::text;
        rollback;
      `);
      expect(result.status, result.stderr).toBe(0);
      const line = result.stdout
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .findLast((value) => value.startsWith("{") && value.endsWith("}"));
      expect(JSON.parse(line!)).toEqual({
        currentBundle: futureBundleVersion,
        currentV2Bundle: futureBundleVersion,
        currentV2Revision: baseline.currentV2Revision + 1,
        preparedPriceSealed: true,
        candidateBundleSealed: true,
        aiEnabled: true,
        authorityEpoch: baseline.authorityEpoch + 2,
      });
    });
  },
);
