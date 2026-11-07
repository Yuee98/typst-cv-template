/** The generated Next routes share one current database-driven runtime. */
import { randomUUID } from "node:crypto";
import { polishPostRequestSchema, polishSuccessResponseSchema } from "@/lib/polish/contract";
import { createServerAdminClient } from "@/server/supabase/admin-client";
import { createServerAuthClient } from "@/server/supabase/auth-client";
import { createAiDatabase } from "@/server/ai/database";
import { executePolish, parseQuota, type RuntimeDependencies } from "@/server/ai/runtime";
import { readAvailability } from "@/server/ai/availability";
import { createFakeRuntime } from "@/server/ai/fake";
import { AiError } from "@/server/ai/errors";
import { baseHeaders, errorResponse, readBoundedBody } from "@/server/ai/http";
const enabled = process.env.AI_POLISH_ENABLED === "true";
const fake = process.env.POLISH_FAKE_BACKEND === "true";
function compose() {
  if (!enabled) return null;
  if (fake !== (process.env.POLISH_FAKE_LLM === "true")) throw new Error("Fake inference requires the fake backend and fake LLM flags together");
  const adminEnvironment = process.env.ADMIN_ENVIRONMENT?.trim().toLowerCase();
  if (fake && (process.env.VERCEL_ENV?.trim() || (adminEnvironment && adminEnvironment !== "local"))) {
    throw new Error("Fake inference forbidden for hosted environments");
  }
  if (fake && process.env.NODE_ENV === "production" && process.env.CI !== "true") throw new Error("Fake inference forbidden in production");
  if (fake) return {
    runtime: createFakeRuntime(),
    verify: async (token: string) => token ? "10000000-0000-4000-8000-000000000002" : null
  };
  const secret = process.env.AI_USER_ID_HMAC_SECRET?.trim();
  if (!secret) throw new Error("AI_USER_ID_HMAC_SECRET required");
  const runtime: RuntimeDependencies = {
    db: createAiDatabase(createServerAdminClient()),
    secret
  };
  const auth = createServerAuthClient();
  return {
    runtime,
    verify: async (token: string) => {
      const {
        data,
        error
      } = await auth.auth.getUser(token);
      return error ? null : data.user?.id ?? null;
    }
  };
}
const composed = compose();
type HttpHandler = (request: Request) => Promise<Response>;
function handler(action: (request: Request, userId: string, deps: RuntimeDependencies, instance: string, requestId: string) => Promise<Response>): HttpHandler {
  return async request => {
    const requestId = randomUUID();
    if (!composed) return errorResponse(requestId, "UNAVAILABLE", "AI polish is unavailable.");
    try {
      const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization")?.trim() ?? "")?.[1];
      if (!token) throw new AiError("UNAUTHORIZED");
      const userId = await composed.verify(token);
      if (!userId) throw new AiError("UNAUTHORIZED");
      const context = await composed.runtime.db.context();
      if (!context.ready || !context.database_instance_id) throw new AiError("NOT_READY");
      if (!fake && (!process.env.ADMIN_ENVIRONMENT || context.environment?.toLowerCase() !== process.env.ADMIN_ENVIRONMENT)) throw new AiError("UNAVAILABLE", "ENVIRONMENT_MISMATCH");
      return await action(request, userId, composed.runtime, context.database_instance_id, requestId);
    } catch (error) {
      const failure = error instanceof AiError ? error : new AiError("INTERNAL_ERROR");
      return errorResponse(requestId, failure.code, "The request could not be completed.", {
        reason: failure.reason
      });
    }
  };
}
export const POST = handler(async (request, userId, deps, _instance, requestId) => {
  const body = await readBoundedBody(request);
  if (!body.ok) throw new AiError(body.code);
  let raw: unknown;
  try {
    raw = JSON.parse(body.text);
  } catch {
    throw new AiError("INVALID_REQUEST");
  }
  const parsed = polishPostRequestSchema.safeParse(raw);
  if (!parsed.success) throw new AiError("INVALID_REQUEST");
  const result = await executePolish(deps, userId, parsed.data, request.signal);
  return Response.json(polishSuccessResponseSchema.parse({
    requestId,
    ...result
  }), {
    headers: baseHeaders(requestId)
  });
});
export const GET = handler(async (_request, userId, deps, instance, requestId) => Response.json({
  requestId,
  quota: parseQuota(await deps.db.call("ai_quota", {
    contract_code: "cv_app_db_1",
    owner_auth_user_id: userId,
    database_instance_id: instance
  }))
}, {
  headers: baseHeaders(requestId)
}));
export const AVAILABILITY_GET = handler(async (_request, userId, deps, instance, requestId) => Response.json({
  requestId,
  availability: await readAvailability(deps.db, userId, instance, process.env, !fake)
}, {
  headers: baseHeaders(requestId)
}));
