import { describe, expect, it } from "vitest";
import fixture from "../fixtures/profile-execution-v2.json";
import { RUN_DB_TESTS } from "./helpers";
import { runOwnerSql } from "./runtime-contract-fixtures";

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const versionId = "62d55bd7-3988-4f12-b1e7-7c10e6f16ec7";
function insertVersion(override: Record<string, unknown> = {}) {
  const values = {
    id: versionId, version: 999999, status: "draft", validated_at: null, activated_at: null, retired_at: null,
    execution_schema_version: fixture.deepseek.schemaVersion, endpoint_url: fixture.deepseek.endpointUrl,
    credential_env_name: fixture.deepseek.credentialEnvName, endpoint_alias: null, credential_alias: null,
    model_id: fixture.deepseek.modelId, ...override,
  };
  return `insert into public.ai_provider_profile_versions
    select (jsonb_populate_record(null::public.ai_provider_profile_versions,
      to_jsonb(v)||${literal(JSON.stringify(values))}::jsonb)).*
    from public.ai_provider_profile_versions v join public.ai_provider_profiles p on p.id=v.profile_id
    where p.profile_key='deepseek.official.deepseek-v4-flash.chat.v1' order by v.version limit 1;`;
}

describe.skipIf(!RUN_DB_TESTS)("v2 catalog and immutable connection schema", () => {
  it("represents successor endpoint/env/model independently of old config hash and mutable defaults", () => {
    const result = runOwnerSql(`begin;
      create temp table before_profile as select to_jsonb(v) as row from public.ai_provider_profile_versions v;
      create temp table before_control as select to_jsonb(f) as row from public.ai_feature_config f;
      ${insertVersion()}
      update public.ai_providers set default_model_id='future-default',default_endpoint_url='https://api.deepseek.com/new-path'
        where id=${literal(fixture.deepseek.providerId)};
      do $$ begin
        if not exists(select 1 from public.ai_provider_profile_versions where id=${literal(versionId)}
          and model_id='synthetic-compatible-model' and endpoint_url=${literal(fixture.deepseek.endpointUrl)}
          and credential_env_name=${literal(fixture.deepseek.credentialEnvName)}) then raise exception 'frozen successor changed'; end if;
        if exists(select row from before_profile except select to_jsonb(v) from public.ai_provider_profile_versions v) then raise exception 'legacy row changed'; end if;
        if exists(select row from before_control except select to_jsonb(f) from public.ai_feature_config f) then raise exception 'control changed'; end if;
      end $$;
      rollback;`);
    expect(result.status).toBe(0);
  });

  it.each([
    { endpoint_url: null }, { credential_env_name: null }, { credential_env_name: "SUPABASE_SERVICE_ROLE_KEY" },
    { credential_alias: "deepseek_api_key" }, { endpoint_alias: "deepseek_official" },
    { execution_schema_version: "profile_execution_config_v1" }, { execution_schema_version: "future" },
    { endpoint_url: "http://localhost/private" }, { endpoint_url: "https://127.0.0.1/private" },
    { endpoint_url: "https://api.deepseek.com/chat/completions?token=x" },
    { adapter_kind: "unregistered" }, { wire_api_kind: "responses_v1" },
  ])("rejects incoherent branch %j", override => {
    const failure = runOwnerSql(`begin; ${insertVersion(override)} rollback;`, { expectFailure: true });
    expect(failure.stderr).toMatch(/constraint|mismatch/);
  });

  it("prevents legacy backfill, successor connection edits and recipient reassignment", () => {
    for (const statement of [
      `update public.ai_provider_profile_versions set endpoint_url='https://api.deepseek.com/new-path' where id=${literal(versionId)};`,
      `update public.ai_provider_profiles set provider_id=${literal(fixture.mimo.providerId)} where provider_id=${literal(fixture.deepseek.providerId)};`,
      `update public.ai_providers set recipient_key='another-recipient' where id=${literal(fixture.deepseek.providerId)};`,
      `update public.ai_provider_profile_versions set credential_env_name='AI_PROVIDER_KEY_NEW' where execution_schema_version='profile_execution_config_v1';`,
    ]) expect(runOwnerSql(`begin; ${insertVersion()} ${statement} rollback;`, { expectFailure: true }).stderr).toContain("immutable");
  });

  it("does not grant catalog control to application roles", () => {
    const result = runOwnerSql(`do $$ begin
      if exists(select 1 from (values ('anon'),('authenticated'),('service_role')) as roles(name)
        cross join (values ('public.ai_providers'),('public.ai_adapter_catalog')) as tables(name)
        where has_table_privilege(roles.name,tables.name,'INSERT,UPDATE,DELETE')) then
        raise exception 'catalog DML leaked';
      end if;
    end $$;`);
    expect(result.status).toBe(0);
  });
});
