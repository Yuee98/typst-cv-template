import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUN_DB_TESTS } from "./helpers";
import {
  authorSyntheticRuntimeContract,
  runOwnerSql,
} from "./runtime-contract-fixtures";

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

function ownerJson<T>(sql: string): T {
  const result = runOwnerSql(String.raw`
    \pset format unaligned
    \pset tuples_only on
    ${sql}
  `);
  const line = result.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .findLast((value) =>
      value === "null" || value.startsWith("{") || value.startsWith("["),
    );
  if (!line) throw new Error(`owner query returned no JSON: ${result.stdout}`);
  return JSON.parse(line) as T;
}

describe.skipIf(!RUN_DB_TESTS)("durable runtime deployment admission", () => {
  let target: {
    runtimeContractId: string;
    runtimeTargetId: string;
    runtimeTargetSha256: string;
    profileVersionId: string;
    priceVersionId: string;
    providerId: string;
    legalBundleVersion: string;
    legalManifestId: string;
    displayDisclosureKey: string;
    codeCapabilityId: string;
    codeCapabilitySha256: string;
  };
  let appendCapability: { id: string; sha256: string };
  let ownsEnvironment = false;
  const fixtures: Array<{
    id: string;
    build: string;
    revision: string;
    hash: string;
    admissionRevision?: string;
  }> = [];

  beforeAll(() => {
    const { count: environmentCount } = ownerJson<{ count: number }>(
      "select jsonb_build_object('count',count(*)) from public.admin_environment;",
    );
    if (environmentCount === 0) {
      runOwnerSql(String.raw`
        insert into public.admin_environment(
          id,environment,project_ref,auth_issuer,control_plane_mode,revision
        ) values (
          true,'local','local','http://127.0.0.1:54321/auth/v1','legacy',0
        );
      `);
      ownsEnvironment = true;
    }
    const runtime = authorSyntheticRuntimeContract({
      profileKey: "deepseek.official.deepseek-v4-flash.chat.v1",
    });
    runOwnerSql(String.raw`
      begin;
      set local session_replication_role = replica;
      insert into public.ai_runtime_target_bindings_v2(
        runtime_contract_id,runtime_target_id,runtime_target_sha256,
        route_descriptor_id,route_descriptor_sha256,profile_version_id,
        price_version_id,provider_id,recipient_key,code_capability_id,
        code_capability_sha256,gateway_kind,adapter_kind,wire_api_kind,
        endpoint_url,credential_env_name,model_id,capability_contract_id,
        cache_policy_id,calculator_kind,legal_bundle_version,legal_manifest_id,
        legal_manifest_sha256,display_disclosure_key,external_evidence_ids
      )
      select membership.runtime_contract_id,membership.runtime_target_id,
        membership.runtime_target_sha256,membership.route_descriptor_id,
        membership.route_descriptor_sha256,version.id,price.id,provider.id,
        provider.recipient_key,capability.code_capability_id,
        capability.descriptor_sha256,profile.gateway_kind,version.adapter_kind,
        version.wire_api_kind,'https://api.deepseek.com/chat/completions',
        'AI_PROVIDER_KEY_DEEPSEEK_PRIMARY',version.model_id,
        version.capability_contract_id,version.cache_policy_id,
        price.calculator_kind,contract.legal_bundle_version,
        membership.legal_manifest_id,membership.manifest_sha256,
        version.display_disclosure_key,array['evidence.admission-runtime']
      from public.ai_service_runtime_contract_targets membership
      join public.ai_service_runtime_contract_versions contract
        on contract.runtime_contract_id=membership.runtime_contract_id
      join public.ai_provider_profiles profile
        on profile.profile_key=membership.profile_key
      join public.ai_provider_profile_versions version
        on version.profile_id=profile.id
      join public.ai_providers provider on provider.id=profile.provider_id
      join public.ai_price_versions price on price.profile_version_id=version.id
      join public.ai_runtime_code_capabilities_v2 capability
        on capability.code_capability_id=
          'runtime-capability.deepseek-chat-v1.2026-09-04'
      where membership.runtime_contract_id=${quote(runtime.runtimeContractId)}
      order by version.version,price.version limit 1;
      commit;
    `);
    target = ownerJson<typeof target>(String.raw`
      select jsonb_build_object(
        'runtimeContractId',runtime_contract_id,
        'runtimeTargetId',runtime_target_id,
        'runtimeTargetSha256',runtime_target_sha256,
        'profileVersionId',profile_version_id,
        'priceVersionId',price_version_id,
        'providerId',provider_id,
        'legalBundleVersion',legal_bundle_version,
        'legalManifestId',legal_manifest_id,
        'displayDisclosureKey',display_disclosure_key,
        'codeCapabilityId',code_capability_id,
        'codeCapabilitySha256',code_capability_sha256)
      from public.ai_runtime_target_bindings_v2
      where runtime_contract_id=${quote(runtime.runtimeContractId)}
        and runtime_target_id=${quote(runtime.runtimeTargetId)};
    `);
    if (!target) throw new Error("no runtime target fixture exists");
    appendCapability = ownerJson<typeof appendCapability>(String.raw`
      select jsonb_build_object('id',code_capability_id,'sha256',descriptor_sha256)
      from public.ai_runtime_code_capabilities_v2
      where code_capability_id <> ${quote(target.codeCapabilityId)}
      order by code_capability_id limit 1;
    `);
    if (!appendCapability) throw new Error("no second capability fixture exists");
    const source = ownerJson<{ environment: string; projectRef: string }>(
      "select jsonb_build_object('environment',environment,'projectRef',project_ref) from public.admin_environment where id=true;",
    );
    if (!source) throw new Error("admin environment is not bootstrapped");

    for (const suffix of ["a", "b"]) {
      const id = crypto.randomUUID();
      const build = `admission-${suffix}-${id.replaceAll("-", "")}`;
      const revision = `manifest-${suffix}-${id.replaceAll("-", "")}`;
      const hash = suffix === "a" ? "a".repeat(64) : "b".repeat(64);
      fixtures.push({ id, build, revision, hash });
      ownerJson<{ id: string }>(String.raw`
        select jsonb_build_object('id',public.admin_import_reviewed_deployment_v1(
          ${quote(id)}::uuid,${quote(source.environment)},${quote(source.projectRef)},
          ${quote(build)},${quote(revision)},${quote(hash)},
          array[${quote(target.codeCapabilityId)}]::text[],
          array['evidence.admission-${suffix}']::text[],
          'sha1:0123456789abcdef0123456789abcdef01234567',
          ${quote("c".repeat(64))},clock_timestamp()+interval '1 hour'
        ));
      `);
    }
  });

  afterAll(() => {
    if (ownsEnvironment) {
      runOwnerSql("delete from public.admin_environment where id=true;");
    }
  });

  it("admits A and B independently and selects only the exact identity", () => {
    const source = ownerJson<{ environment: string; projectRef: string }>(
      "select jsonb_build_object('environment',environment,'projectRef',project_ref) from public.admin_environment where id=true;",
    );
    for (const fixture of fixtures) {
      const result = ownerJson<{ admissionRevision: string }>(String.raw`
        select public.admin_admit_runtime_deployment_v1(
          ${quote(fixture.id)}::uuid,${quote(source.environment)},
          ${quote(source.projectRef)},${quote(fixture.build)},
          ${quote(fixture.revision)},${quote(fixture.hash)},
          array[${quote(target.runtimeTargetId)}]::text[],
          'integration admission identity test'
        );
      `);
      fixture.admissionRevision = result.admissionRevision;
    }
    const exact = ownerJson<{ targets: Array<Record<string, unknown>> }>(String.raw`
      select public.get_admin_admitted_runtime_deployment_v1(
        ${quote(source.environment)},${quote(source.projectRef)},
        ${quote(fixtures[0].build)},${quote(fixtures[0].revision)},
        ${quote(fixtures[0].hash)}
      );
    `);
    expect(exact.targets[0]).toEqual({
      runtimeContractId: target.runtimeContractId,
      runtimeTargetId: target.runtimeTargetId,
      runtimeTargetSha256: target.runtimeTargetSha256,
      profileVersionId: target.profileVersionId,
      priceVersionId: target.priceVersionId,
      providerId: target.providerId,
      legalBundleVersion: target.legalBundleVersion,
      legalManifestId: target.legalManifestId,
      displayDisclosureKey: target.displayDisclosureKey,
      codeCapabilityId: target.codeCapabilityId,
      codeCapabilitySha256: target.codeCapabilitySha256,
    });
    for (const crossed of [
      { ...fixtures[0], hash: fixtures[1].hash },
      { ...fixtures[0], revision: fixtures[1].revision },
      { ...fixtures[0], build: fixtures[1].build },
    ]) {
      const result = ownerJson<null>(String.raw`
        select coalesce(public.get_admin_admitted_runtime_deployment_v1(
          ${quote(source.environment)},${quote(source.projectRef)},
          ${quote(crossed.build)},${quote(crossed.revision)},${quote(crossed.hash)}
        ),'null'::jsonb);
      `);
      expect(result).toBeNull();
    }
  });

  it("rejects a reviewed hash collision for the same build and revision", () => {
    const source = ownerJson<{ environment: string; projectRef: string }>(
      "select jsonb_build_object('environment',environment,'projectRef',project_ref) from public.admin_environment where id=true;",
    );
    const collisionId = crypto.randomUUID();
    const result = runOwnerSql(String.raw`
      select public.admin_import_reviewed_deployment_v1(
        ${quote(collisionId)}::uuid,${quote(source.environment)},
        ${quote(source.projectRef)},${quote(fixtures[0].build)},
        ${quote(fixtures[0].revision)},${quote(fixtures[1].hash)},
        array[${quote(target.codeCapabilityId)}]::text[],
        array['evidence.admission-collision']::text[],
        'sha1:0123456789abcdef0123456789abcdef01234567',
        ${quote("c".repeat(64))},clock_timestamp()+interval '1 hour'
      );
    `, { expectFailure: true });
    expect(`${result.stdout}${result.stderr}`).toMatch(/duplicate|unique/i);
  });

  it("revokes admission and rejects re-admission of the revoked identity", () => {
    const source = ownerJson<{ environment: string; projectRef: string }>(
      "select jsonb_build_object('environment',environment,'projectRef',project_ref) from public.admin_environment where id=true;",
    );
    const revoked = ownerJson<{ admissionRevision: string }>(String.raw`
      select public.admin_revoke_runtime_deployment_v1(
        ${quote(source.environment)},${quote(source.projectRef)},
        ${quote(fixtures[0].build)},${quote(fixtures[0].revision)},
        ${quote(fixtures[0].admissionRevision ?? "0")}::bigint,
        'revoke integration admission'
      );
    `);
    expect(revoked.admissionRevision).toBe(fixtures[0].admissionRevision);
    const readback = ownerJson<null>(String.raw`
      select coalesce(public.get_admin_admitted_runtime_deployment_v1(
        ${quote(source.environment)},${quote(source.projectRef)},
        ${quote(fixtures[0].build)},${quote(fixtures[0].revision)},
        ${quote(fixtures[0].hash)}
      ),'null'::jsonb);
    `);
    expect(readback).toBeNull();
    const readmit = runOwnerSql(String.raw`
      select public.admin_admit_runtime_deployment_v1(
        ${quote(fixtures[0].id)}::uuid,${quote(source.environment)},
        ${quote(source.projectRef)},${quote(fixtures[0].build)},
        ${quote(fixtures[0].revision)},${quote(fixtures[0].hash)},
        array[${quote(target.runtimeTargetId)}]::text[],'must remain revoked'
      );
    `, { expectFailure: true });
    expect(`${readmit.stdout}${readmit.stderr}`).toMatch(/already.admitted/i);
  });

  it("rejects a reviewed capability append at deferred commit", () => {
    const result = runOwnerSql(String.raw`
      begin;
      insert into public.admin_reviewed_deployment_capabilities_v1(
        reviewed_deployment_id,code_capability_id,code_capability_sha256
        ) values (${quote(fixtures[1].id)},${quote(appendCapability.id)},${quote(appendCapability.sha256)});
      commit;
    `, { expectFailure: true });
    expect(`${result.stdout}${result.stderr}`).toMatch(/immutable|owner managed|capabilit/i);
  });
});
