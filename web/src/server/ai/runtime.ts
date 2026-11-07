import { createHmac } from "node:crypto";
import { z } from "zod";
import { polishQuotaSchema, type PolishPostRequest, type PolishQuota } from "@/lib/polish/contract";
import { type AiDatabase } from "./database";
import { AiError } from "./errors";
import { prepareProvider, providerProfileSchema, type ProviderProfile, type InferenceProvider } from "./provider";
import { priceSchema, calculateCost, usageForDatabase } from "./accounting";
import { buildPolishPromptBlocks, POLISH_PROMPT_VERSION } from "./prompt";
import { validatePolishOutput, POLISH_VALIDATOR_VERSION } from "./validate";
import type { PolishInferenceResult } from "./inference";
import { classifyProviderRetry, type ProviderRetryErrorMetadata } from "./provider-error";
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{12}$`));
const state = z.enum(["RESERVED", "RUNNING", "HELD", "FINALIZED"]);
const reservation = z.strictObject({
  request_id: id("req"),
  state,
  replayed: z.boolean(),
  quota: z.unknown()
});
export const snapshotSchema = z.strictObject({
  request_id: id("req"),
  state,
  selected_option_id: id("opt"),
  policy_version_id: id("plv"),
  profile_id: id("prf"),
  profile_version_id: id("pfv"),
  price_version_id: id("pcv"),
  provider_id: id("prv"),
  recipient_code: z.string(),
  ...providerProfileSchema.shape,
  price: priceSchema,
  disclosure_id: id("lds"),
  content_digest: z.string().regex(/^[0-9a-f]{64}$/),
  cancel_sequence: z.string(),
  attempts: z.array(z.unknown())
});
const startSchema = z.strictObject({
  attempt_id: id("att"),
  attempt_no: z.union([z.literal(1), z.literal(2)]),
  state: z.string(),
  may_transmit: z.boolean()
});
const finalSchema = z.strictObject({
  request_id: id("req"),
  state,
  outcome: z.string().nullable(),
  charged: z.boolean().nullable(),
  quota: z.unknown()
});
export function parseQuota(raw: unknown): PolishQuota {
  const decimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/).refine(value => Number.isSafeInteger(Number(value)), "Quota exceeds the safe integer range");
  const value = z.object({
    limit: decimal,
    remaining: decimal,
    reset_at: z.string()
  }).parse(raw);
  return polishQuotaSchema.parse({
    limit: Number(value.limit),
    remaining: Number(value.remaining),
    resetAt: new Date(value.reset_at).toISOString()
  });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}`;
  return JSON.stringify(value);
}
export interface RuntimeDependencies {
  db: AiDatabase;
  secret: string;
  env?: Readonly<Record<string, string | undefined>>;
  prepare?: (profile: ProviderProfile, onTransmit: () => void) => InferenceProvider;
}
/** Fingerprints cover content and the exact user-selected configuration; only the HMAC is stored. */
export async function executePolish(deps: RuntimeDependencies, userId: string, request: PolishPostRequest, signal: AbortSignal) {
  const route = request.expectedRoute;
  const common = {
    contract_code: "cv_app_db_1",
    owner_auth_user_id: userId,
    database_instance_id: route.databaseInstanceId
  };
  const fingerprint = createHmac("sha256", deps.secret).update("cv_app_db_1:request:").update(canonical(request)).digest("hex");
  const reserved = reservation.parse(await deps.db.call("ai_reserve", {
    ...common,
    contract_code: route.contract,
    client_request_key: request.clientRequestId,
    request_fingerprint: fingerprint,
    selected_option_id: route.selectedOptionId,
    expected_generation: route.configGeneration,
    expected_policy_version_id: route.policyVersionId,
    expected_profile_version_id: route.profileVersionId,
    disclosure_id: route.disclosureId,
    content_digest: route.contentDigest
  }));
  // Replaying a reservation never grants a second transmission, including response-loss cases.
  if (reserved.replayed) throw new AiError("CONFLICT", reserved.state === "FINALIZED" ? "ALREADY_FINALIZED" : "REQUEST_IN_PROGRESS");
  const input = {
    ...common,
    request_id: reserved.request_id
  };
  let cancellation: Promise<unknown> | null = null;
  const cancel = () => {
    cancellation ??= deps.db.call("ai_cancel", input);
    void cancellation.catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, {
    once: true
  });
  const deadline = Date.now() + 90000;
  let resultItems: Array<{
    id: string;
    polished: string;
  }> | null = null;
  try {
    if (signal.aborted) {
      cancel();
      await cancellation;
      const final = finalSchema.parse(await deps.db.call("ai_finalize", input));
      throw new AiError("UNAVAILABLE", final.outcome ?? "CANCELED");
    }
    const snapshot = snapshotSchema.parse(await deps.db.call("ai_execution_snapshot", input));
    const profile = providerProfileSchema.parse(Object.fromEntries(Object.keys(providerProfileSchema.shape).map(key => [key, snapshot[key as keyof typeof snapshot]])));
    let didTransmit = false;
    let provider: InferenceProvider;
    try {
      provider = deps.prepare ? deps.prepare(profile, () => {
        didTransmit = true;
      }) : prepareProvider(profile, deps.env, async (...args: Parameters<typeof fetch>) => {
        didTransmit = true;
        return fetch(...args);
      });
    } catch {
      await deps.db.call("ai_finalize", input);
      throw new AiError("UNAVAILABLE", "EXECUTION_CONFIG_UNAVAILABLE");
    }
    let feedback: string | undefined;
    for (let attemptNo = 1; attemptNo <= 2; attemptNo++) {
      if (signal.aborted) {
        cancel();
        await cancellation;
        break;
      }
      if (Date.now() >= deadline) break;
      let admission: z.infer<typeof startSchema>;
      try {
        admission = startSchema.parse(await deps.db.call("ai_attempt_start", {
          ...input,
          attempt_no: attemptNo
        }));
      } catch (error) {
        await deps.db.call("ai_finalize", input).catch(() => undefined);
        throw error;
      }
      if (!admission.may_transmit) throw new AiError("CONFLICT", "REQUEST_IN_PROGRESS");
      didTransmit = false;
      let response: PolishInferenceResult | null = null;
      let terminal = "UNKNOWN";
      let retry = false;
      let delay = 0;
      let billable: boolean | null = null;
      try {
        const prompt = buildPolishPromptBlocks({
          language: request.language,
          sectionId: request.sectionId,
          granularity: request.granularity,
          items: request.items,
          contextLevel: request.context.level,
          references: request.context.references,
          stylePreset: request.stylePreset,
          styleInstruction: request.styleInstruction,
          retryFeedback: feedback
        });
        const subject = createHmac("sha256", deps.secret).update(`cv_app_db_1:provider:${profile.provider_code}:${userId}`).digest("hex");
        response = await provider.complete({
          schemaVersion: "polish_inference_request",
          prompt,
          outputContract: {
            kind: "json_object",
            schemaName: "polish_items_v1",
            schema: {}
          },
          maxOutputTokens: computeBudget(request.items),
          providerSubjectId: subject,
          promptVersion: POLISH_PROMPT_VERSION,
          validatorVersion: POLISH_VALIDATOR_VERSION,
          language: request.language,
          targets: request.items
        }, {
          signal,
          timeoutMs: Math.max(1, Math.min(40000, deadline - Date.now()))
        });
        const validation = validatePolishOutput(response, {
          items: request.items,
          language: request.language
        });
        billable = true;
        if (validation.ok) {
          terminal = "SUCCEEDED";
          resultItems = validation.items;
        } else {
          terminal = validation.classification === "upstream" ? "FAILED_UPSTREAM" : "INVALID_OUTPUT";
          retry = true;
          feedback = validation.reason;
        }
      } catch (error) {
        if (signal.aborted) {
          terminal = "CANCELED";
          retry = false;
        } else {
          const meta = error !== null && typeof error === "object" ? error as ProviderRetryErrorMetadata : {};
          // A transport without a response can have completed remotely; never resend it.
          if (meta.upstreamStatus === undefined && didTransmit) terminal = "UNKNOWN";else {
            terminal = meta.code === "UPSTREAM_TIMEOUT" ? "TIMED_OUT" : "FAILED_UPSTREAM";
            const decision = classifyProviderRetry(meta);
            retry = decision.retryable;
            delay = decision.retryAfterMs;
            billable = didTransmit ? null : false;
          }
        }
      }
      const cost = response ? calculateCost(response.usage, snapshot.price) : {
        estimated: null,
        known: null,
        reasons: ["USAGE_UNAVAILABLE"]
      };
      // No provider call is retried if this write is uncertain or fails.
      await deps.db.call("ai_attempt_complete", {
        ...input,
        attempt_id: admission.attempt_id,
        state: terminal,
        transmitted: didTransmit,
        provider_billable: billable,
        retry_allowed: retry && attemptNo === 1 && !signal.aborted,
        usage: usageForDatabase(response?.usage ?? null),
        estimated_cost_nanos: cost.estimated,
        known_estimated_cost_nanos: cost.known,
        provider_reported_cost_nanos: response?.providerReportedCost?.currency === snapshot.price.currency ? response.providerReportedCost.nanos : null,
        incomplete_reasons: cost.reasons
      });
      if (terminal === "UNKNOWN" || terminal === "SUCCEEDED" || !retry || attemptNo === 2 || signal.aborted) break;
      if (delay > 0) {
        if (Date.now() + delay >= deadline) break;
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, delay);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, {
            once: true
          });
        });
      }
    }
    if (cancellation) await cancellation;
    const final = finalSchema.parse(await deps.db.call("ai_finalize", input));
    if (final.state !== "FINALIZED") throw new AiError("UNAVAILABLE", "HELD");
    if (final.outcome !== "SUCCEEDED" || !resultItems) throw new AiError("UNAVAILABLE", final.outcome ?? "FAILED_UPSTREAM");
    return {
      items: resultItems,
      quota: parseQuota(final.quota)
    };
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
import { computePolishMaxOutputTokens as computeBudget } from "@/lib/polish/contract";
