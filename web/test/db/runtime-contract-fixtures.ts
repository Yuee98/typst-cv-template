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

export interface LifecycleEvidenceRoot {
  reviewedSourceCommitOid: string;
  reviewedSourceSha256: string;
  recheckedAt: string;
}

export interface LifecycleEvidenceRootInput {
  runtimeContractId: string;
  reviewedSourceCommitOid?: string;
  reviewedSourceSha256?: string;
  priceVersionIds?: readonly string[];
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

export function readLifecycleEvidenceRoot(
  input: LifecycleEvidenceRootInput,
): LifecycleEvidenceRoot {
  if (!CODE_ID.test(input.runtimeContractId)) {
    throw new Error("lifecycle evidence runtime contract id is invalid");
  }
  const reviewedSourceCommitOid =
    input.reviewedSourceCommitOid ??
    "sha1:0123456789abcdef0123456789abcdef01234567";
  if (!/^sha1:[0-9a-f]{40}$/u.test(reviewedSourceCommitOid)) {
    throw new Error("lifecycle reviewed source commit oid is invalid");
  }
  const reviewedSourceSha256 =
    input.reviewedSourceSha256 ?? sha256(reviewedSourceCommitOid);
  if (!LOWER_HEX_64.test(reviewedSourceSha256)) {
    throw new Error("lifecycle reviewed source hash is invalid");
  }
  const requestedPriceVersionIds = input.priceVersionIds ?? [];
  const priceVersionIds = [...new Set(requestedPriceVersionIds)];
  if (priceVersionIds.length !== requestedPriceVersionIds.length) {
    throw new Error("lifecycle evidence price version ids contain duplicates");
  }
  if (input.priceVersionIds !== undefined && priceVersionIds.length === 0) {
    throw new Error("lifecycle evidence price version ids are empty");
  }
  if (priceVersionIds.some((id) => !CANONICAL_UUID.test(id))) {
    throw new Error("lifecycle evidence price version id is invalid");
  }

  const priceJoin = priceVersionIds.length === 0
    ? ""
    : String.raw`
      join lateral (
        select pg_catalog.max(candidate.source_checked_at) as source_checked_at
        from public.ai_price_versions as candidate
        where candidate.id = any(array[${priceVersionIds
          .map((id) => `${sqlLiteral(id)}::uuid`)
          .join(", ")}])
        having count(*) = ${priceVersionIds.length}
      ) as price on true`;
  const recheckedAt = priceVersionIds.length === 0
    ? "root.created_at"
    : "greatest(root.created_at, price.source_checked_at)";

  // Docker/VM clocks can step backwards between owner sessions. Keep the
  // exact catalog-derived recheck time and wait boundedly for the DB clock to
  // catch up instead of forging an earlier timestamp or weakening the validator.
  const result = runOwnerSql(String.raw`
    \pset format unaligned
    \pset tuples_only on
    with evidence as materialized (
      select
        ${sqlLiteral(reviewedSourceCommitOid)}::text as reviewed_source_commit_oid,
        ${recheckedAt} as rechecked_at
      from public.ai_service_runtime_contract_versions as root${priceJoin}
      where root.runtime_contract_id = ${sqlLiteral(input.runtimeContractId)}
    ), waited as materialized (
      select pg_catalog.pg_sleep(
        case
          when evidence.rechecked_at > pg_catalog.clock_timestamp() then
            least(
              pg_catalog.date_part(
                'epoch',
                evidence.rechecked_at - pg_catalog.clock_timestamp()
              ) + 0.01,
              2.0
            )
          else 0
        end
      )
      from evidence
    )
    select pg_catalog.jsonb_build_object(
      'reviewedSourceCommitOid', evidence.reviewed_source_commit_oid,
      'reviewedSourceSha256', ${sqlLiteral(reviewedSourceSha256)},
      'recheckedAt', evidence.rechecked_at,
      'observedAt', pg_catalog.clock_timestamp(),
      'ready', evidence.rechecked_at <= pg_catalog.clock_timestamp()
    )::text
    from evidence
    cross join waited;
  `);
  const line = result.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .findLast((value) => value.startsWith("{"));
  if (line === undefined) {
    throw new Error(`lifecycle evidence root is missing: ${result.stdout}`);
  }

  const parsed = JSON.parse(line) as {
    observedAt?: unknown;
    ready?: unknown;
    recheckedAt?: unknown;
    reviewedSourceCommitOid?: unknown;
    reviewedSourceSha256?: unknown;
  };
  if (
    typeof parsed.reviewedSourceCommitOid !== "string" ||
    !/^sha1:[0-9a-f]{40}$/u.test(parsed.reviewedSourceCommitOid) ||
    typeof parsed.reviewedSourceSha256 !== "string" ||
    !LOWER_HEX_64.test(parsed.reviewedSourceSha256) ||
    typeof parsed.recheckedAt !== "string" ||
    Number.isNaN(Date.parse(parsed.recheckedAt)) ||
    typeof parsed.observedAt !== "string" ||
    Number.isNaN(Date.parse(parsed.observedAt)) ||
    parsed.ready !== true
  ) {
    throw new Error(`lifecycle evidence root is invalid: ${line}`);
  }

  return {
    reviewedSourceCommitOid: parsed.reviewedSourceCommitOid,
    reviewedSourceSha256: parsed.reviewedSourceSha256,
    recheckedAt: parsed.recheckedAt,
  };
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
      greatest(
        pg_catalog.clock_timestamp(),
        (
          select created_at
          from public.ai_price_versions
          where id = ${sqlLiteral(priceId)}::uuid
        )
      )
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
  reviewedSourceSha256: string;
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
  const runtimeTargetSha256 = sha256(runtimeTargetId);
  const reviewedSourceSha256 = sha256(`reviewed-source:${runtimeContractId}`);
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
    reviewedSourceSha256,
    runtimeTargetSha256,
    routeDescriptorSha256,
    runtimeTargetSetSha256,
  ]) {
    if (!LOWER_HEX_64.test(value)) {
      throw new Error("synthetic descriptor or audit hash is invalid");
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
      legal_bundle_version,
      bundle_contract_sha256,
      runtime_target_set_sha256
    ) values (
      ${sqlLiteral(runtimeContractId)},
      ${sqlLiteral(INITIAL_LEGAL_BUNDLE_VERSION)},
      ${sqlLiteral(INITIAL_LEGAL_BUNDLE_SHA256)},
      ${sqlLiteral(runtimeTargetSetSha256)}
    );

    insert into public.ai_service_runtime_contract_targets (
      runtime_contract_id,
      runtime_target_id,
      runtime_target_sha256,
      profile_key,
      legal_manifest_id,
      manifest_sha256,
      route_descriptor_id,
      route_descriptor_sha256
    ) values (
      ${sqlLiteral(runtimeContractId)},
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
    where runtime_contract_id = ${sqlLiteral(runtimeContractId)};
    commit;
  `);

  return {
    runtimeContractId,
    reviewedSourceSha256,
    runtimeTargetId,
    runtimeTargetSha256,
    profileKey,
    legalManifestId,
    manifestSha256,
    routeDescriptorId,
    routeDescriptorSha256,
  };
}

export interface SyntheticRuntimeTargetInput {
  profileKey: string;
  legalManifestId: string;
  manifestSha256: string;
}

export interface SyntheticRuntimeContractSet {
  runtimeContractId: string;
  reviewedSourceSha256: string;
  targets: ReadonlyArray<
    Omit<SyntheticRuntimeContract, "runtimeContractId" | "reviewedSourceSha256">
  >;
}

export function authorSyntheticRuntimeContractSet(
  inputs: ReadonlyArray<SyntheticRuntimeTargetInput>,
): SyntheticRuntimeContractSet {
  if (inputs.length === 0) {
    throw new Error("synthetic runtime contract set requires at least one target");
  }
  if (new Set(inputs.map(({ profileKey }) => profileKey)).size !== inputs.length) {
    throw new Error("synthetic runtime contract profile keys must be unique");
  }

  const suffix = crypto.randomUUID();
  const runtimeContractId = `test-runtime-contract-set.${suffix}`;
  const reviewedSourceSha256 = sha256(`reviewed-source:${runtimeContractId}`);
  const targets = inputs.map((input, index) => {
    const runtimeTargetId = `test-runtime-target-set.${index}.${suffix}`;
    const routeDescriptorId = `test-route-descriptor-set.${index}.${suffix}`;
    return {
      runtimeTargetId,
      runtimeTargetSha256: sha256(runtimeTargetId),
      profileKey: input.profileKey,
      legalManifestId: input.legalManifestId,
      manifestSha256: input.manifestSha256,
      routeDescriptorId,
      routeDescriptorSha256: sha256(routeDescriptorId),
    };
  });
  const runtimeTargetSetSha256 = sha256(
    [...targets]
      .sort((left, right) =>
        Buffer.from(left.runtimeTargetId).compare(Buffer.from(right.runtimeTargetId)),
      )
      .map(
        ({ runtimeTargetId, runtimeTargetSha256 }) =>
          `${Buffer.byteLength(runtimeTargetId, "utf8")}:${runtimeTargetId}:${runtimeTargetSha256}`,
      )
      .join("\n"),
  );

  for (const value of [
    runtimeContractId,
    ...targets.flatMap(
      ({ profileKey, legalManifestId, runtimeTargetId, routeDescriptorId }) => [
        profileKey,
        legalManifestId,
        runtimeTargetId,
        routeDescriptorId,
      ],
    ),
  ]) {
    if (!CODE_ID.test(value)) {
      throw new Error(`synthetic runtime code id is invalid: ${value}`);
    }
  }
  for (const value of [
    runtimeTargetSetSha256,
    reviewedSourceSha256,
    ...targets.flatMap(
      ({ manifestSha256, runtimeTargetSha256, routeDescriptorSha256 }) => [
        manifestSha256,
        runtimeTargetSha256,
        routeDescriptorSha256,
      ],
    ),
  ]) {
    if (!LOWER_HEX_64.test(value)) {
      throw new Error("synthetic descriptor or audit hash is invalid");
    }
  }

  const targetValues = targets
    .map(
      (target) => String.raw`(
        ${sqlLiteral(target.runtimeTargetId)},
        ${sqlLiteral(target.runtimeTargetSha256)},
        ${sqlLiteral(target.profileKey)},
        ${sqlLiteral(target.legalManifestId)},
        ${sqlLiteral(target.manifestSha256)},
        ${sqlLiteral(target.routeDescriptorId)},
        ${sqlLiteral(target.routeDescriptorSha256)}
      )`,
    )
    .join(",\n");
  const membershipValues = targets
    .map(
      (target) => String.raw`(
        ${sqlLiteral(runtimeContractId)},
        ${sqlLiteral(target.runtimeTargetId)},
        ${sqlLiteral(target.runtimeTargetSha256)},
        ${sqlLiteral(target.profileKey)},
        ${sqlLiteral(target.legalManifestId)},
        ${sqlLiteral(target.manifestSha256)},
        ${sqlLiteral(target.routeDescriptorId)},
        ${sqlLiteral(target.routeDescriptorSha256)}
      )`,
    )
    .join(",\n");

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
    ) values ${targetValues};

    insert into public.ai_service_runtime_contract_versions (
      runtime_contract_id,
      legal_bundle_version,
      bundle_contract_sha256,
      runtime_target_set_sha256
    ) values (
      ${sqlLiteral(runtimeContractId)},
      ${sqlLiteral(INITIAL_LEGAL_BUNDLE_VERSION)},
      ${sqlLiteral(INITIAL_LEGAL_BUNDLE_SHA256)},
      ${sqlLiteral(runtimeTargetSetSha256)}
    );

    insert into public.ai_service_runtime_contract_targets (
      runtime_contract_id,
      runtime_target_id,
      runtime_target_sha256,
      profile_key,
      legal_manifest_id,
      manifest_sha256,
      route_descriptor_id,
      route_descriptor_sha256
    ) values ${membershipValues};

    update public.ai_service_runtime_contract_versions
    set sealed_at = greatest(clock_timestamp(), created_at)
    where runtime_contract_id = ${sqlLiteral(runtimeContractId)};
    commit;
  `);

  return {
    runtimeContractId,
    reviewedSourceSha256,
    targets,
  };
}
