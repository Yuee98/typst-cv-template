import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const INITIAL_LEGAL_BUNDLE_VERSION =
  "2026-08-23-multi-provider-v1";
export const INITIAL_LEGAL_BUNDLE_SHA256 =
  "fc26d1e1a016fda055fbe6a0b79b48d804fd7610e03bd5aa29389be37359ca18";
export const DEEPSEEK_LEGAL_MANIFEST_ID =
  "deepseek-official-2026-08-23-v1";
export const DEEPSEEK_LEGAL_MANIFEST_SHA256 =
  "0fa6702d0785a8ce959b0bd4cc31984578143ef269bf7b4df4d1672e6d1fa09b";
export const MIMO_LEGAL_MANIFEST_ID = "mimo-cn-2026-08-23-v1";
export const MIMO_LEGAL_MANIFEST_SHA256 =
  "f075f1e39e74a96ef2b536df8ba1e19c0840ce6d3be47d6deccd9c95da861c3f";

const DB_CONTAINER = "supabase_db_typst-cv-template";
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODE_ID = /^[a-z0-9][a-z0-9._-]{0,199}$/;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface OwnerSqlResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function runOwnerSql(
  sql: string,
  options: { expectFailure?: boolean } = {},
): OwnerSqlResult {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      DB_CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "--set",
      "ON_ERROR_STOP=1",
      "--no-psqlrc",
    ],
    { input: sql, encoding: "utf8", timeout: 60_000 },
  );
  const output = {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
  const failed = output.status !== 0;
  if (failed !== Boolean(options.expectFailure)) {
    throw new Error(
      `owner SQL ${options.expectFailure ? "succeeded unexpectedly" : "failed"}: ${output.stderr || output.stdout}`,
    );
  }
  return output;
}

export function startOwnerSql(sql: string): Promise<OwnerSqlResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        DB_CONTAINER,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "--set",
        "ON_ERROR_STOP=1",
        "--no-psqlrc",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status: status ?? -1, stdout, stderr });
    });
    child.stdin.end(sql);
  });
}

export function sealPriceAsDatabaseOwner(priceId: string): void {
  if (!CANONICAL_UUID.test(priceId)) {
    throw new Error("test price id is not a canonical UUID");
  }
  runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    begin;
    select public.seal_ai_price_components_v1(
      array[${sqlLiteral(priceId)}::uuid],
      clock_timestamp()
    );
    commit;
  `);
}

export type RoutingPolicyPromotionStatus = "validated" | "canary" | "active";

export function transitionPolicyAsDatabaseOwner(
  policyId: string,
  toStatus: RoutingPolicyPromotionStatus,
  options: { expectFailure?: boolean } = {},
): OwnerSqlResult {
  if (!CANONICAL_UUID.test(policyId)) {
    throw new Error("test policy id is not a canonical UUID");
  }
  return runOwnerSql(
    String.raw`
      \set ON_ERROR_STOP on
      begin;
      select public.transition_ai_routing_policy_v1(
        ${sqlLiteral(policyId)}::uuid,
        ${sqlLiteral(toStatus)}::text
      );
      commit;
    `,
    options,
  );
}

export interface SyntheticRuntimeContract {
  runtimeContractId: string;
  runtimeContractSha256: string;
  runtimeTargetId: string;
  runtimeTargetSha256: string;
  profileKey: string;
  legalManifestId: string;
  manifestSha256: string;
  routeDescriptorId: string;
  routeDescriptorSha256: string;
}

export function authorSyntheticRuntimeContract(options: {
  profileKey?: string;
  legalManifestId?: string;
  manifestSha256?: string;
} = {}): SyntheticRuntimeContract {
  const suffix = crypto.randomUUID();
  const profileKey = options.profileKey ?? `test.runtime.profile.${suffix}`;
  const legalManifestId =
    options.legalManifestId ?? DEEPSEEK_LEGAL_MANIFEST_ID;
  const manifestSha256 =
    options.manifestSha256 ?? DEEPSEEK_LEGAL_MANIFEST_SHA256;
  const runtimeContractId = `test-runtime-contract.${suffix}`;
  const runtimeTargetId = `test-runtime-target.${suffix}`;
  const routeDescriptorId = `test-route-descriptor.${suffix}`;
  const runtimeContractSha256 = sha256(runtimeContractId);
  const runtimeTargetSha256 = sha256(runtimeTargetId);
  const routeDescriptorSha256 = sha256(routeDescriptorId);
  const runtimeTargetSetSha256 = sha256(
    `${Buffer.byteLength(runtimeTargetId, "utf8")}:${runtimeTargetId}:${runtimeTargetSha256}`,
  );

  for (const value of [
    profileKey,
    legalManifestId,
    runtimeContractId,
    runtimeTargetId,
    routeDescriptorId,
  ]) {
    if (!CODE_ID.test(value)) {
      throw new Error(`synthetic runtime code id is invalid: ${value}`);
    }
  }
  for (const value of [
    manifestSha256,
    runtimeContractSha256,
    runtimeTargetSha256,
    routeDescriptorSha256,
    runtimeTargetSetSha256,
  ]) {
    if (!LOWER_HEX_64.test(value)) {
      throw new Error("synthetic runtime hash is invalid");
    }
  }

  runOwnerSql(String.raw`
    \set ON_ERROR_STOP on
    begin;
    insert into public.ai_service_runtime_target_versions (
      runtime_target_id,
      runtime_target_sha256,
      profile_key,
      legal_manifest_id,
      manifest_sha256,
      route_descriptor_id,
      route_descriptor_sha256
    ) values (
      ${sqlLiteral(runtimeTargetId)},
      ${sqlLiteral(runtimeTargetSha256)},
      ${sqlLiteral(profileKey)},
      ${sqlLiteral(legalManifestId)},
      ${sqlLiteral(manifestSha256)},
      ${sqlLiteral(routeDescriptorId)},
      ${sqlLiteral(routeDescriptorSha256)}
    );

    insert into public.ai_service_runtime_contract_versions (
      runtime_contract_id,
      runtime_contract_sha256,
      reviewed_source_commit_oid,
      legal_bundle_version,
      bundle_contract_sha256,
      runtime_target_set_sha256
    ) values (
      ${sqlLiteral(runtimeContractId)},
      ${sqlLiteral(runtimeContractSha256)},
      'sha1:0123456789abcdef0123456789abcdef01234567',
      ${sqlLiteral(INITIAL_LEGAL_BUNDLE_VERSION)},
      ${sqlLiteral(INITIAL_LEGAL_BUNDLE_SHA256)},
      ${sqlLiteral(runtimeTargetSetSha256)}
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
      ${sqlLiteral(runtimeContractId)},
      ${sqlLiteral(runtimeContractSha256)},
      ${sqlLiteral(runtimeTargetId)},
      ${sqlLiteral(runtimeTargetSha256)},
      ${sqlLiteral(profileKey)},
      ${sqlLiteral(legalManifestId)},
      ${sqlLiteral(manifestSha256)},
      ${sqlLiteral(routeDescriptorId)},
      ${sqlLiteral(routeDescriptorSha256)}
    );

    update public.ai_service_runtime_contract_versions
    set sealed_at = greatest(clock_timestamp(), created_at)
    where runtime_contract_id = ${sqlLiteral(runtimeContractId)}
      and runtime_contract_sha256 = ${sqlLiteral(runtimeContractSha256)};
    commit;
  `);

  return {
    runtimeContractId,
    runtimeContractSha256,
    runtimeTargetId,
    runtimeTargetSha256,
    profileKey,
    legalManifestId,
    manifestSha256,
    routeDescriptorId,
    routeDescriptorSha256,
  };
}
