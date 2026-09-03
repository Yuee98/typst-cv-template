import "server-only";
import {
  ADMIN_ERROR_STATUS,
  adminContextSchema,
  adminPageSchema,
  adminRecordSectionSchema,
  adminValidationReportSchema,
  adminValidationRequestSchema,
  adminMutationRequestSchema,
  adminCommittedOperationSchema,
  type AdminErrorCode,
  type AdminMutationRequest,
} from "@/lib/admin/contract";
import { resolveAdminEnvironment, type AdminEnvironment } from "./environment";
import { createAdminRequestClient } from "./request-client";
import { produceAdminValidationReport } from "./validation-service";

type Client = ReturnType<typeof createAdminRequestClient>;
interface Dependencies {
  environment(): AdminEnvironment;
  client(
    environment: AdminEnvironment,
    token: string,
  ): Pick<Client, "auth" | "rpc">;
  produceValidation?: typeof produceAdminValidationReport;
}
const defaults: Dependencies = {
  environment: () => resolveAdminEnvironment(process.env),
  client: createAdminRequestClient,
  produceValidation: produceAdminValidationReport,
};
const headers = { "Cache-Control": "private, no-store", Vary: "Authorization" };
function fail(code: AdminErrorCode) {
  return Response.json(
    { error: { code } },
    { status: ADMIN_ERROR_STATUS[code], headers },
  );
}
function rpcError(error: { code?: string; message?: string }): AdminErrorCode {
  // Only fixed protocol names; no upstream error prose leaves the server.
  if (error.message === "ENVIRONMENT_MISMATCH") return "ENVIRONMENT_MISMATCH";
  if (error.message === "STEP_UP_REQUIRED") return "STEP_UP_REQUIRED";
  if (error.message === "IDEMPOTENCY_CONFLICT" || error.message === "CONFLICT" || error.code === "40001") return "CONFLICT";
  if (error.message === "NOT_READY" || error.message?.endsWith("_NOT_READY") || error.message === "VALIDATION_REPORT_MISMATCH") return "NOT_READY";
  if (error.code === "42501") return "FORBIDDEN";
  if (error.code === "22023" || error.code === "22P02")
    return "INVALID_REQUEST";
  if (error.code === "P0002") return "NOT_FOUND";
  return "UNAVAILABLE";
}

const mutationRpc: Record<AdminMutationRequest["operation"], { rpc: string; kind: string }> = {
  disable_ai: { rpc: "admin_disable_ai_v1", kind: "ai_disable" },
  pointer_set: { rpc: "admin_set_ai_routing_pointer_v1", kind: "ai_pointer_set" },
  pointer_clear: { rpc: "admin_clear_ai_routing_pointer_v1", kind: "ai_pointer_clear" },
  reopen: { rpc: "admin_reopen_ai_v1", kind: "ai_reopen" },
  membership_set: { rpc: "admin_set_membership_v1", kind: "admin_membership_set" },
  provider_defaults_update: { rpc: "admin_update_provider_defaults_v1", kind: "provider_defaults_update" },
  provider_profile_create: { rpc: "admin_create_provider_profile_v1", kind: "provider_profile_create" },
  profile_version_create: { rpc: "admin_create_profile_version_v2", kind: "profile_version_create" },
  price_version_create: { rpc: "admin_create_price_version_v1", kind: "price_version_create" },
  global_daily_limit_set: { rpc: "admin_set_global_daily_limit_v1", kind: "global_daily_limit_set" },
  price_seal: { rpc: "admin_seal_price_for_activation_v1", kind: "price_seal" },
  profile_version_transition: { rpc: "admin_transition_profile_version_v1", kind: "profile_version_transition" },
  routing_policy_create: { rpc: "admin_create_routing_policy_v1", kind: "routing_policy_create" },
  routing_policy_transition: { rpc: "admin_transition_routing_policy_v1", kind: "routing_policy_transition" },
  price_close: { rpc: "admin_close_price_version_v1", kind: "price_close" },
  profile_version_retire: { rpc: "admin_retire_profile_version_v1", kind: "profile_version_retire" },
  provider_profile_retire: { rpc: "admin_retire_provider_profile_v1", kind: "provider_profile_retire" },
};

function mutationArgs(
  request: AdminMutationRequest,
  environment: AdminEnvironment,
) {
  const base = { p_environment: environment.name, p_project_ref: environment.projectRef };
  switch (request.operation) {
    case "disable_ai": return { ...base, p_expected_control_revision: request.expectedControlRevision, p_reason: request.reason, p_idempotency_key: request.idempotencyKey };
    case "pointer_set": return { ...base, p_policy_version_id: request.policyVersionId, p_validation_report_ids: request.validationReportIds, p_expected_control_revision: request.expectedControlRevision, p_expected_policy_version_id: request.expectedPolicyVersionId, p_expected_config_generation: request.expectedConfigGeneration, p_reason: request.reason, p_idempotency_key: request.idempotencyKey };
    case "pointer_clear": return { ...base, p_validation_report_ids: request.validationReportIds, p_expected_control_revision: request.expectedControlRevision, p_expected_policy_version_id: request.expectedPolicyVersionId, p_expected_config_generation: request.expectedConfigGeneration, p_reason: request.reason, p_idempotency_key: request.idempotencyKey };
    case "reopen": return { ...base, p_readback_report_id: request.readbackReportId, p_expected_closing_cycle_id: request.expectedClosingCycleId, p_expected_control_revision: request.expectedControlRevision, p_expected_policy_version_id: request.expectedPolicyVersionId, p_expected_config_generation: request.expectedConfigGeneration, p_reason: request.reason, p_idempotency_key: request.idempotencyKey };
    case "membership_set": return { ...base, p_target_user_id: request.targetUserId, p_enabled: request.enabled, p_expected_revision: request.expectedRevision, p_reason: request.reason, p_idempotency_key: request.idempotencyKey };
    case "provider_defaults_update": return { ...base, p_provider_id: request.providerId, p_display_name: request.displayName, p_default_adapter_id: request.defaultAdapterId, p_default_endpoint_url: request.defaultEndpointUrl, p_default_credential_env_name: request.defaultCredentialEnvName, p_default_model_id: request.defaultModelId, p_archived: request.archived, p_expected_revision: request.expectedRevision, p_reason: request.reason, p_idempotency_key: request.idempotencyKey };
    case "provider_profile_create": return { ...base, p_provider_id: request.providerId, p_profile_key: request.profileKey, p_display_name: request.displayName, p_model_vendor: request.modelVendor, p_reason: request.reason, p_idempotency_key: request.idempotencyKey };
    case "profile_version_create": return { ...base, p_profile_id: request.profileId, p_expected_latest_version: request.expectedLatestVersion, p_adapter_id: request.adapterId, p_wire_api_kind: request.wireApiKind, p_endpoint_url: request.endpointUrl, p_credential_env_name: request.credentialEnvName, p_model_id: request.modelId, p_capability_contract_id: request.capabilityContractId, p_cache_policy_id: request.cachePolicyId, p_legal_manifest_id: request.legalManifestId, p_display_disclosure_key: request.displayDisclosureKey, p_config: request.config, p_reason: request.reason, p_idempotency_key: request.idempotencyKey };
    case "price_version_create": return { ...base, p_profile_version_id: request.profileVersionId, p_pricing_lane: request.pricingLane, p_expected_latest_version: request.expectedLatestVersion, p_currency: request.currency, p_calculator_kind: request.calculatorKind, p_valid_from: request.validFrom, p_valid_to: request.validTo, p_provider_effective_from: request.providerEffectiveFrom, p_provider_effective_to: request.providerEffectiveTo, p_source_url: request.sourceUrl, p_source_checked_at: request.sourceCheckedAt, p_source_snapshot_sha256: request.sourceSnapshotSha256, p_parameters: request.parameters, p_components: request.components, p_reason: request.reason, p_idempotency_key: request.idempotencyKey };
    case "global_daily_limit_set": return { ...base, p_global_daily_limit: request.globalDailyLimit, p_expected_global_daily_limit: request.expectedGlobalDailyLimit, p_expected_control_revision: request.expectedControlRevision, p_reason: request.reason, p_idempotency_key: request.idempotencyKey };
    case "price_seal": return { ...base, p_price_version_id: request.priceVersionId, p_runtime_contract_id: request.runtimeContractId, p_reviewed_deployment_id: request.reviewedDeploymentId, p_reason: request.reason, p_idempotency_key: request.idempotencyKey };
    case "profile_version_transition": return { ...base, p_profile_version_id: request.profileVersionId, p_to_status: request.toStatus, p_validation_report_id: request.validationReportId, p_reason: request.reason, p_idempotency_key: request.idempotencyKey };
    case "routing_policy_create": return { ...base, p_policy_key: request.policyKey, p_expected_latest_version: request.expectedLatestVersion, p_rules: request.rules, p_default_profile_version_id: request.defaultProfileVersionId, p_legal_bundle_version: request.legalBundleVersion, p_runtime_contract_id: request.runtimeContractId, p_validation_report_ids: request.validationReportIds, p_reason: request.reason, p_idempotency_key: request.idempotencyKey };
    case "routing_policy_transition": return { ...base, p_policy_version_id: request.policyVersionId, p_to_status: request.toStatus, p_validation_report_ids: request.validationReportIds, p_reason: request.reason, p_idempotency_key: request.idempotencyKey };
    case "price_close": return { ...base, p_price_version_id: request.priceVersionId, p_valid_to: request.validTo, p_successor_price_version_id: request.successorPriceVersionId, p_validation_report_id: request.validationReportId, p_reason: request.reason, p_idempotency_key: request.idempotencyKey };
    case "profile_version_retire": return { ...base, p_profile_version_id: request.profileVersionId, p_validation_report_id: request.validationReportId, p_reason: request.reason, p_idempotency_key: request.idempotencyKey };
    case "provider_profile_retire": return { ...base, p_profile_id: request.profileId, p_validation_report_id: request.validationReportId, p_reason: request.reason, p_idempotency_key: request.idempotencyKey };
  }
}

async function readBoundedUtf8Body(request: Request, maxBytes: number) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be errored or closed.
    }
    return null;
  }
}

export async function handleAdminGet(
  request: Request,
  deps: Dependencies = defaults,
): Promise<Response> {
  const bearer = /^Bearer ([^\s]+)$/i.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!bearer || bearer[1].length > 16_384) return fail("UNAUTHORIZED");
  try {
    const env = deps.environment();
    const client = deps.client(env, bearer[1]);
    const { data: auth, error: authError } = await client.auth.getUser(
      bearer[1],
    );
    if (authError || !auth.user) return fail("UNAUTHORIZED");
    const query = new URL(request.url).searchParams;
    const allowedKeys = ["section", "limit", "after", "search", "id"];
    if (
      [...query.keys()].some(
        (key) => !allowedKeys.includes(key) || query.getAll(key).length !== 1,
      )
    ) {
      return fail("INVALID_REQUEST");
    }
    const section = query.get("section") ?? "overview";
    const base = { p_environment: env.name, p_project_ref: env.projectRef };
    if (section === "overview") {
      if ([...query.keys()].some((key) => key !== "section"))
        return fail("INVALID_REQUEST");
      const { data, error } = await client.rpc("admin_get_context_v1", base);
      if (error) return fail(rpcError(error));
      return Response.json(adminContextSchema.parse(data), { headers });
    }
    if (!adminRecordSectionSchema.safeParse(section).success)
      return fail("INVALID_REQUEST");
    const id = query.get("id");
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const limitText = query.get("limit") ?? "25";
    const after = query.get("after");
    const search = query.get("search");
    if (
      !/^[1-9][0-9]{0,2}$/.test(limitText) ||
      Number(limitText) > 100 ||
      (after !== null && !uuid.test(after)) ||
      (search !== null && search.length > 100) ||
      (id !== null &&
        (!uuid.test(id) ||
          [...query.keys()].some((key) => !["section", "id"].includes(key))))
    ) {
      return fail("INVALID_REQUEST");
    }
    const { data, error } = id
      ? await client.rpc("admin_get_record_v1", {
          ...base,
          p_section: section,
          p_id: id,
        })
      : await client.rpc("admin_list_records_v1", {
          ...base,
          p_section: section,
          p_limit: Number(limitText),
          p_after: after,
          p_search: search,
        });
    if (error) return fail(rpcError(error));
    const page = adminPageSchema.parse(data);
    if (page.section !== section) return fail("UNAVAILABLE");
    return Response.json(page, { headers });
  } catch {
    return fail("UNAVAILABLE");
  }
}

export const GET = (request: Request) => handleAdminGet(request);

export async function handleAdminPost(
  request: Request,
  deps: Dependencies = defaults,
): Promise<Response> {
  const bearer = /^Bearer ([^\s]+)$/i.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!bearer || bearer[1].length > 16_384) return fail("UNAUTHORIZED");
  if (new URL(request.url).search !== "") return fail("INVALID_REQUEST");
  const contentLength = request.headers.get("content-length");
  if (
    request.headers.get("content-type")?.split(";", 1)[0].trim() !==
      "application/json" ||
    (contentLength !== null &&
      (!/^[0-9]{1,7}$/.test(contentLength) || Number(contentLength) > 4_096))
  ) {
    return fail("INVALID_REQUEST");
  }
  try {
    const env = deps.environment();
    const client = deps.client(env, bearer[1]);
    const { data: auth, error: authError } = await client.auth.getUser(
      bearer[1],
    );
    if (authError || !auth.user) return fail("UNAUTHORIZED");
    const body = await readBoundedUtf8Body(request, 4_096);
    if (body === null) return fail("INVALID_REQUEST");
    const raw: unknown = JSON.parse(body);
    const mutation = adminMutationRequestSchema.safeParse(raw);
    const validation = adminValidationRequestSchema.safeParse(raw);
    if (!mutation.success && !validation.success) return fail("INVALID_REQUEST");
    if (mutation.success) {
      const descriptor = mutationRpc[mutation.data.operation];
      const { data, error } = await client.rpc(
        descriptor.rpc,
        mutationArgs(mutation.data, env),
      );
      if (error) return fail(rpcError(error));
      const result = adminCommittedOperationSchema.safeParse(data);
      if (!result.success || result.data.operationKind !== descriptor.kind)
        return fail("UNAVAILABLE");
      return Response.json(result.data, { headers });
    }
    if (!validation.success) return fail("INVALID_REQUEST");
    const { data: context, error: contextError } = await client.rpc(
      "admin_get_context_v1",
      { p_environment: env.name, p_project_ref: env.projectRef },
    );
    if (contextError) return fail(rpcError(contextError));
    adminContextSchema.parse(context);
    const {
      reviewedDeploymentId,
      runtimeContractId,
      runtimeTargetId,
    } = validation.data;
    const validationInput = {
      reviewedDeploymentId,
      runtimeContractId,
      runtimeTargetId,
    };
    const report = await (deps.produceValidation ?? defaults.produceValidation!)(
      validationInput,
    );
    return Response.json(adminValidationReportSchema.parse(report), {
      headers,
    });
  } catch (error) {
    if (error instanceof SyntaxError) return fail("INVALID_REQUEST");
    return fail("UNAVAILABLE");
  }
}

export const POST = (request: Request) => handleAdminPost(request);
