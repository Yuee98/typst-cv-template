import "server-only";
import { z } from "zod";
import { ADMIN_ERROR_CODES, ADMIN_ERROR_STATUS, adminContextSchema, adminControlStateSchema, adminAnalyticsSchema, adminPageSchema, adminRecordSchema, adminRecordSectionSchema, adminValidationReportSchema, adminValidationRequestSchema, adminRuntimeReadbackRequestSchema, adminRuntimeReadbackSchema, adminMutationRequestSchema, adminCommittedOperationSchema, externalIdSchema, type AdminErrorCode } from "@/lib/admin/contract";
import { resolveAdminEnvironment, type AdminEnvironment } from "./environment";
import { createAdminRequestClient } from "./request-client";
import { produceAdminValidationReport } from "./validation-service";
import { produceAdminRuntimeReadback } from "./readback-service";
type Client = ReturnType<typeof createAdminRequestClient>;
interface Dependencies {
  environment(): AdminEnvironment;
  client(environment: AdminEnvironment, token: string): Pick<Client, "auth" | "rpc">;
  produceValidation?: typeof produceAdminValidationReport;
  produceReadback?: typeof produceAdminRuntimeReadback;
}
const defaults: Dependencies = {
  environment: () => resolveAdminEnvironment(process.env),
  client: createAdminRequestClient,
  produceValidation: produceAdminValidationReport,
  produceReadback: produceAdminRuntimeReadback
};
const headers = {
  "Cache-Control": "private, no-store",
  Vary: "Authorization"
};
function fail(code: AdminErrorCode) {
  return Response.json({
    error: {
      code
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
const kinds = {
  users: "users",
  providers: "providers",
  profiles: "profile_versions",
  prices: "price_versions",
  policies: "policy_versions",
  audit: "events"
} as const;
async function authenticated(request: Request, deps: Dependencies) {
  const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!bearer || bearer[1].length > 16384) return null;
  const environment = deps.environment();
  const client = deps.client(environment, bearer[1]);
  const {
    data,
    error
  } = await client.auth.getUser(bearer[1]);
  return error || !data.user ? null : {
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
    const section = query.get("section") ?? "overview";
    if (["overview", "controls"].includes(section)) {
      if ([...query.keys()].some(key => key !== "section")) return fail("INVALID_REQUEST");
      const {
        data,
        error
      } = await auth.client.rpc("admin_context");
      if (error) return fail(rpcError(error));
      const context = adminContextSchema.parse(data);
      if (context.environment.toLowerCase() !== auth.environment.name) return fail("CLIENT_UPDATE_REQUIRED");
      return Response.json(section === "controls" ? adminControlStateSchema.parse(context.control) : context, {
        headers
      });
    }
    if (section === "analytics") {
      if ([...query.keys()].some(key => !["section", "days"].includes(key))) return fail("INVALID_REQUEST");
      const days = query.get("days") ?? "7";
      if (!/^(?:[1-9]|[12][0-9]|3[01])$/.test(days)) return fail("INVALID_REQUEST");
      const {
        data,
        error
      } = await auth.client.rpc("admin_analytics", {
        p_days: Number(days)
      });
      if (error) return fail(rpcError(error));
      return Response.json(adminAnalyticsSchema.parse(data), {
        headers
      });
    }
    const parsed = adminRecordSectionSchema.safeParse(section);
    if (!parsed.success) return fail("INVALID_REQUEST");
    const id = query.get("id");
    const kind = query.get("kind");
    if (kind !== null && !(["profiles", "policies"].includes(section) && ["identities", "versions"].includes(kind) || section === "users" && ["accounts", "members"].includes(kind))) return fail("INVALID_REQUEST");
    const recordKind = section === "profiles" ? id?.startsWith("prf_") || kind === "identities" ? "profiles" : "profile_versions" : section === "policies" ? id?.startsWith("pol_") || kind === "identities" ? "policies" : "policy_versions" : section === "users" && (kind === "members" || id?.startsWith("adm_")) ? "members" : kinds[parsed.data];
    const after = query.get("after");
    const limit = query.get("limit") ?? "25";
    if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100 || after !== null && after.length > 200 || [...query.keys()].some(key => !["section", "id", "after", "limit", "kind"].includes(key))) return fail("INVALID_REQUEST");
    if (id && !externalIdSchema.safeParse(id).success) return fail("INVALID_REQUEST");
    const {
      data,
      error
    } = id ? await auth.client.rpc("admin_record", {
      p_kind: recordKind,
      p_external_id: id
    }) : await auth.client.rpc("admin_records", {
      p_kind: recordKind,
      p_limit: Number(limit),
      p_after: after ?? undefined
    });
    if (error) return fail(rpcError(error));
    return Response.json(id ? adminRecordSchema.parse(data) : adminPageSchema.parse(data), {
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
    const raw = await readBody(request);
    const mutation = adminMutationRequestSchema.safeParse(raw);
    if (mutation.success) {
      const preflight = await auth.client.rpc("admin_context");
      if (preflight.error) return fail(rpcError(preflight.error));
      const current = adminContextSchema.parse(preflight.data);
      if (current.environment.toLowerCase() !== auth.environment.name || current.database_instance_id !== mutation.data.database_instance_id) return fail("CLIENT_UPDATE_REQUIRED");
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
      const result = adminCommittedOperationSchema.parse(data);
      if (result.operation !== operation.slice("admin_".length)) return fail("UNAVAILABLE");
      return Response.json(result, {
        headers
      });
    }
    const validation = adminValidationRequestSchema.safeParse(raw);
    const readback = adminRuntimeReadbackRequestSchema.safeParse(raw);
    if (!validation.success && !readback.success) return fail("INVALID_REQUEST");
    const input = validation.success ? validation.data : readback.success ? readback.data : null;
    if (!input) return fail("INVALID_REQUEST");
    const {
      data,
      error
    } = await auth.client.rpc("admin_context");
    if (error) return fail(rpcError(error));
    const context = adminContextSchema.parse(data);
    if (context.database_instance_id !== input.database_instance_id || context.contract_code !== input.contract_code || context.environment.toLowerCase() !== auth.environment.name) return fail("CLIENT_UPDATE_REQUIRED");
    if (validation.success) {
      const result = await (deps.produceValidation ?? defaults.produceValidation!)({
        target_kind: validation.data.target_kind,
        target_id: validation.data.target_id,
        database_instance_id: input.database_instance_id
      });
      return Response.json(adminValidationReportSchema.parse(result), {
        headers
      });
    }
    const result = await (deps.produceReadback ?? defaults.produceReadback!)({
      database_instance_id: input.database_instance_id
    });
    return Response.json(adminRuntimeReadbackSchema.parse(result), {
      headers
    });
  } catch (error) {
    return fail(error instanceof SyntaxError ? "INVALID_REQUEST" : "UNAVAILABLE");
  }
}
export const GET = (request: Request) => handleAdminGet(request);
export const POST = (request: Request) => handleAdminPost(request);
