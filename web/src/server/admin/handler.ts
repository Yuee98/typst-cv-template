import "server-only";
import { z } from "zod";
import { ADMIN_ERROR_CODES, ADMIN_ERROR_STATUS, adminContextSchema, adminReadResponseSchema, adminSectionSchema, adminAnalyticsSchema, adminPageSchema, adminRecordSchema, adminMutationRequestSchema, adminCommittedOperationSchema, entityIdSchema, adminConfigurationSchema, adminRuleSchema, adminAdapterSchema, adminDocumentSchema, type AdminErrorCode, type AdminSection, type AdminConfiguration, type AdminConfigurationErrorReason } from "@/lib/admin/contract";
import { resolveAdminEnvironment, type AdminEnvironment } from "./environment";
import { createAdminRequestClient } from "./request-client";
import { ADAPTERS, MissingProviderCredentialError, validateExecutionConfiguration } from "@/server/ai/provider";
import { resolveEndpoint } from "@/server/ai/outbound";
type Client = ReturnType<typeof createAdminRequestClient>;
interface Dependencies {
  environment(): AdminEnvironment;
  client(environment: AdminEnvironment, token: string, signal?: AbortSignal): Pick<Client, "auth" | "rpc">;
  validateConfiguration?(configuration: Pick<AdminConfiguration, "adapter_id" | "endpoint_url" | "credential_ref" | "model_id">, signal: AbortSignal): Promise<void>;
}
export class AdminConfigurationValidationError extends Error {
  constructor(readonly reason: AdminConfigurationErrorReason) { super(reason); }
}
export async function validateAdminConfiguration(
  configuration: Pick<AdminConfiguration, "adapter_id" | "endpoint_url" | "credential_ref" | "model_id">,
  signal: AbortSignal,
  env: Readonly<Record<string, string | undefined>> = process.env,
  resolve: typeof resolveEndpoint = resolveEndpoint
): Promise<void> {
  try {
    validateExecutionConfiguration({
      adapter_id: configuration.adapter_id,
      execution_contract: ADAPTERS[configuration.adapter_id].executionContract,
      endpoint_url: configuration.endpoint_url,
      credential_ref: configuration.credential_ref,
      model_id: configuration.model_id
    }, env);
  } catch (error) {
    throw new AdminConfigurationValidationError(error instanceof MissingProviderCredentialError ? "CREDENTIAL_UNAVAILABLE" : "ENDPOINT_INVALID");
  }
  try {
    await resolve(configuration.endpoint_url, undefined, signal);
  } catch {
    throw new AdminConfigurationValidationError("ENDPOINT_UNREACHABLE");
  }
}
const defaults: Dependencies = {
  environment: () => resolveAdminEnvironment(process.env),
  client: createAdminRequestClient,
  validateConfiguration: validateAdminConfiguration
};
const headers = {
  "Cache-Control": "private, no-store",
  Vary: "Authorization"
};
function fail(code: AdminErrorCode, reason?: AdminConfigurationErrorReason) {
  return Response.json({
    error: {
      code,
      ...(reason ? { reason } : {})
    }
  }, {
    status: ADMIN_ERROR_STATUS[code],
    headers
  });
}
function rpcError(error: {
  code?: string;
  message?: string;
}): AdminErrorCode {
  const known = ADMIN_ERROR_CODES.find(code => code === error.message);
  if (known) return known;
  if (error.code === "42501") return "FORBIDDEN";
  if (["40001", "40P01", "23505"].includes(error.code ?? "")) return "CONFLICT";
  if (["22023", "22P02", "23514", "23503"].includes(error.code ?? "")) return "INVALID_REQUEST";
  return "UNAVAILABLE";
}
export const sectionKinds: Record<AdminSection, readonly string[]> = {
  configurations: ["configurations", "adapters", "legal_documents"],
  rules: ["rules"],
  controls: [],
  usage: ["requests", "analytics"],
  users: ["accounts", "members", "allowed_users"],
  audit: ["configurations", "prices", "rules", "rule_members", "runtime_control", "allowed_users", "documents", "acceptances", "members"]
};
async function authenticated(request: Request, deps: Dependencies) {
  const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!bearer || bearer[1].length > 16384) return null;
  const environment = deps.environment();
  const client = deps.client(environment, bearer[1], request.signal);
  const {
    data,
    error
  } = await client.auth.getUser(bearer[1]);
  return error || !data.user || request.signal.aborted ? null : {
    client,
    environment
  };
}
async function readBody(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json" || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {
        done,
        value
      } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", {
    fatal: true
  }).decode(bytes)) as unknown;
}
export async function handleAdminGet(request: Request, deps: Dependencies = defaults): Promise<Response> {
  try {
    const auth = await authenticated(request, deps);
    if (!auth) return fail("UNAUTHORIZED");
    const query = new URL(request.url).searchParams;
    if (new Set(query.keys()).size !== [...query.keys()].length) return fail("INVALID_REQUEST");
    const parsedSection = adminSectionSchema.safeParse(query.get("section") ?? "controls");
    if (!parsedSection.success) return fail("INVALID_REQUEST");
    const section = parsedSection.data;
    const instance = query.get("database_instance_id");
    if (instance !== null && !z.uuid().safeParse(instance).success) return fail("INVALID_REQUEST");
    const input: Record<string, string | number> = {
      section,
      contract_code: "cv_app_db_2",
      expected_environment: auth.environment.name.toUpperCase(),
      ...(instance ? {
        database_instance_id: instance
      } : {})
    };
    const allowed = new Set(["section", "database_instance_id"]);
    const kind = query.get("kind") ?? sectionKinds[section][0];
    if (section !== "controls") {
      allowed.add("kind");
      if (!sectionKinds[section].includes(kind)) return fail("INVALID_REQUEST");
      input.kind = kind;
      const id = query.get("id");
      allowed.add("id");
      if (id !== null) {
        if (!entityIdSchema.safeParse(id).success) return fail("INVALID_REQUEST");
        input.id = id;
      }
      if (section === "usage" && kind === "analytics") {
        allowed.add("days");
        const days = query.get("days") ?? "7";
        if (!/^(?:[1-9]|[1-8][0-9]|90)$/.test(days)) return fail("INVALID_REQUEST");
        input.days = Number(days);
      } else if (id === null) {
        allowed.add("limit");
        allowed.add("after");
        const limit = query.get("limit") ?? "25",
          after = query.get("after");
        if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100 || after !== null && (!after || after.length > 500)) return fail("INVALID_REQUEST");
        input.limit = Number(limit);
        if (after !== null) input.after = after;
      }
      if (section === "audit") {
        allowed.add("entity_id");
        const entity = query.get("entity_id");
        if (entity !== null) {
          if (!entityIdSchema.safeParse(entity).success) return fail("INVALID_REQUEST");
          input.entity_id = entity;
        }
      }
    }
    if ([...query.keys()].some(key => !allowed.has(key))) return fail("INVALID_REQUEST");
    const {
      data,
      error
    } = await auth.client.rpc("admin_read", {
      p_input: input
    });
    if (error) return fail(rpcError(error));
    const envelope = adminReadResponseSchema.parse(data);
    if (envelope.context.environment.toLowerCase() !== auth.environment.name || instance !== null && envelope.context.database_instance_id !== instance) return fail("CLIENT_UPDATE_REQUIRED");
    let payload: unknown;
    if (section === "controls") payload = z.null().parse(envelope.data);else if (section === "usage" && kind === "analytics") payload = adminAnalyticsSchema.parse(envelope.data);else {
      const recordSchema = section === "configurations" ? kind === "adapters" ? adminAdapterSchema : kind === "legal_documents" ? adminDocumentSchema : adminConfigurationSchema : section === "rules" ? adminRuleSchema : adminRecordSchema;
      if (query.has("id")) payload = recordSchema.parse(envelope.data);else {
        const page = adminPageSchema.parse(envelope.data);
        payload = {
          ...page,
          records: page.records.map(record => recordSchema.parse(record))
        };
      }
    }
    return Response.json({
      context: envelope.context,
      data: payload
    }, {
      headers
    });
  } catch {
    return fail("UNAVAILABLE");
  }
}
export async function handleAdminPost(request: Request, deps: Dependencies = defaults): Promise<Response> {
  try {
    if (new URL(request.url).search) return fail("INVALID_REQUEST");
    const auth = await authenticated(request, deps);
    if (!auth) return fail("UNAUTHORIZED");
    const mutation = adminMutationRequestSchema.safeParse(await readBody(request));
    if (!mutation.success) return fail("INVALID_REQUEST");
    const preflight = await auth.client.rpc("admin_context");
    if (preflight.error) return fail(rpcError(preflight.error));
    const current = adminContextSchema.parse(preflight.data);
    if (current.environment.toLowerCase() !== auth.environment.name || current.database_instance_id !== mutation.data.database_instance_id) return fail("CLIENT_UPDATE_REQUIRED");
    if (mutation.data.operation === "admin_configuration_save") {
      try {
        await (deps.validateConfiguration ?? defaults.validateConfiguration!)(mutation.data, request.signal);
      } catch (error) {
        return fail("INVALID_REQUEST", error instanceof AdminConfigurationValidationError ? error.reason : undefined);
      }
    }
    if (request.signal.aborted) return fail("UNAUTHORIZED");
    const {
      operation,
      ...p_input
    } = mutation.data;
    const {
      data,
      error
    } = await auth.client.rpc(operation, {
      p_input: z.json().parse(p_input)
    });
    if (error) return fail(rpcError(error));
    const receipt = adminCommittedOperationSchema.parse(data);
    if (receipt.operation !== operation.slice("admin_".length)) return fail("UNAVAILABLE");
    return Response.json(receipt, {
      headers
    });
  } catch (error) {
    return fail(error instanceof SyntaxError ? "INVALID_REQUEST" : "UNAVAILABLE");
  }
}
export const GET = (request: Request) => handleAdminGet(request);
export const POST = (request: Request) => handleAdminPost(request);
