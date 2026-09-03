import "server-only";
import {
  ADMIN_ERROR_STATUS,
  adminContextSchema,
  adminPageSchema,
  adminRecordSectionSchema,
  adminValidationReportSchema,
  adminValidationRequestSchema,
  type AdminErrorCode,
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
  if (error.code === "42501") return "FORBIDDEN";
  if (error.code === "22023" || error.code === "22P02")
    return "INVALID_REQUEST";
  if (error.code === "P0002") return "NOT_FOUND";
  return "UNAVAILABLE";
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
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > 4_096)
      return fail("INVALID_REQUEST");
    const parsed = adminValidationRequestSchema.safeParse(JSON.parse(body));
    if (!parsed.success) return fail("INVALID_REQUEST");
    const env = deps.environment();
    const client = deps.client(env, bearer[1]);
    const { data: auth, error: authError } = await client.auth.getUser(
      bearer[1],
    );
    if (authError || !auth.user) return fail("UNAUTHORIZED");
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
    } = parsed.data;
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
