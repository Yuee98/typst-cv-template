import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  polishAvailabilityResponseSchema,
  polishAvailabilitySchema,
  polishCanonicalUuidSchema,
  polishConfigGenerationSchema,
  polishRouteIdentifierSchema,
  type PolishAvailability,
  type PolishAvailabilityResponse,
  type PolishErrorCode,
} from "@/lib/polish/contract";
import { legalDisplayV2Schema } from "@/lib/legal/legal-display-v2";
import { verifyBearerUser } from "./auth";
import { resolveDisplayDisclosure } from "./adapter-registry";
import { baseHeaders, errorResponse } from "./lifecycle-http";

const dbAvailabilityEnabledSchema = z.strictObject({
  enabled: z.literal(true),
  configGeneration: polishConfigGenerationSchema,
  routingPolicyVersionId: polishCanonicalUuidSchema,
  profileVersionId: polishCanonicalUuidSchema,
  legalBundleVersion: polishRouteIdentifierSchema,
  runtimeContractId: polishRouteIdentifierSchema,
  displayDisclosureKey: polishRouteIdentifierSchema,
  termsAccepted: z.boolean(),
});

const dbAvailabilityDisabledSchema = z.strictObject({
  enabled: z.literal(false),
  configGeneration: z.null(),
  routingPolicyVersionId: z.null(),
  profileVersionId: z.null(),
  legalBundleVersion: z.null(),
  runtimeContractId: z.null(),
  displayDisclosureKey: z.null(),
  termsAccepted: z.literal(false),
});

const dbAvailabilitySchema = z.discriminatedUnion("enabled", [
  dbAvailabilityEnabledSchema,
  dbAvailabilityDisabledSchema,
]);

const dbAvailabilityV2EnabledSchema = dbAvailabilityEnabledSchema.extend({
  schemaVersion: z.literal("ai_polish_availability_v2"),
  legalDisplay: legalDisplayV2Schema.nullable(),
});

const dbAvailabilityV2DisabledSchema = dbAvailabilityDisabledSchema.extend({
  schemaVersion: z.literal("ai_polish_availability_v2"),
  legalDisplay: z.null(),
});

const dbAvailabilityAnyVersionSchema = z.union([
  dbAvailabilitySchema,
  dbAvailabilityV2EnabledSchema,
  dbAvailabilityV2DisabledSchema,
]);

export type PolishAvailabilityDbResult = z.infer<
  typeof dbAvailabilityAnyVersionSchema
>;

interface DisplayDisclosureProjection {
  readonly key: string;
  readonly providerName: string;
  readonly modelName: string;
}

type DisplayDisclosureResolver = (key: string) => DisplayDisclosureProjection;

export interface PolishAvailabilityLogEvent {
  readonly event: "polish.availability.served" | "polish.availability.denied";
  readonly requestId: string;
  readonly code?: PolishErrorCode;
  readonly enabled?: boolean;
  readonly latencyMs: number;
}

export interface PolishAvailabilityDeps {
  verifyAccessToken(token: string): Promise<string | null>;
  readAvailability(userId: string): Promise<unknown>;
  now?: () => number;
  createRequestId?: () => string;
  logger?: (event: PolishAvailabilityLogEvent) => void;
}

/** Fixed internal wrapper; raw PostgREST details stay in `cause` only. */
export class PolishAvailabilityReadError extends Error {
  constructor(cause: unknown) {
    super("AI polish availability read failed", { cause });
    this.name = "PolishAvailabilityReadError";
  }
}

/** Service-role RPC transport. Authentication happens before this function. */
export async function readPolishAvailabilityV1(
  client: Pick<SupabaseClient, "rpc">,
  userId: string,
): Promise<unknown> {
  const { data, error } = await client.rpc("get_ai_polish_availability_v1", {
    p_user_id: userId,
  });
  if (error) throw new PolishAvailabilityReadError(error);
  return data;
}

/** Successor reader; its DB result still projects legacy v1 profiles safely. */
export async function readPolishAvailabilityV2(
  client: Pick<SupabaseClient, "rpc">,
  userId: string,
): Promise<unknown> {
  const { data, error } = await client.rpc("get_ai_polish_availability_v2", {
    p_user_id: userId,
  });
  if (error) throw new PolishAvailabilityReadError(error);
  return data;
}

export function decodePolishAvailabilityDbResult(raw: unknown): PolishAvailabilityDbResult {
  return dbAvailabilityAnyVersionSchema.parse(raw);
}

/**
 * Map the DB-owned disclosure key to code-owned public display text. The DB
 * never supplies provider/model names and disabled results never hit the
 * registry.
 */
export function projectPolishAvailability(
  availability: PolishAvailabilityDbResult,
  resolveDisclosure: DisplayDisclosureResolver = resolveDisplayDisclosure,
): PolishAvailability {
  if (!availability.enabled) {
    return polishAvailabilitySchema.parse({
      enabled: false,
      configGeneration: null,
      routingPolicyVersionId: null,
      profileVersionId: null,
      legalBundleVersion: null,
      runtimeContractId: null,
      displayDisclosure: null,
      termsAccepted: false,
    });
  }

  if ("schemaVersion" in availability && availability.legalDisplay !== null) {
    const display = availability.legalDisplay;
    if (
      display.legalBundleVersion !== availability.legalBundleVersion ||
      display.displayDisclosureKey !== availability.displayDisclosureKey
    ) {
      throw new Error("legal display identity does not match availability");
    }
    return polishAvailabilitySchema.parse({
      enabled: true,
      configGeneration: availability.configGeneration,
      routingPolicyVersionId: availability.routingPolicyVersionId,
      profileVersionId: availability.profileVersionId,
      legalBundleVersion: availability.legalBundleVersion,
      runtimeContractId: availability.runtimeContractId,
      displayDisclosure: {
        key: display.displayDisclosureKey,
        providerName: display.en.providerLabel,
        modelName: display.en.modelLabel,
        legalDisplay: display,
      },
      termsAccepted: availability.termsAccepted,
    });
  }

  const disclosure = resolveDisclosure(availability.displayDisclosureKey);
  if (disclosure.key !== availability.displayDisclosureKey) {
    throw new Error("display disclosure registry returned a mismatched key");
  }
  return polishAvailabilitySchema.parse({
    enabled: true,
    configGeneration: availability.configGeneration,
    routingPolicyVersionId: availability.routingPolicyVersionId,
    profileVersionId: availability.profileVersionId,
    legalBundleVersion: availability.legalBundleVersion,
    runtimeContractId: availability.runtimeContractId,
    displayDisclosure: {
      key: disclosure.key,
      providerName: disclosure.providerName,
      modelName: disclosure.modelName,
    },
    termsAccepted: availability.termsAccepted,
  });
}

export async function handlePolishAvailabilityGet(
  request: Request,
  deps: PolishAvailabilityDeps,
): Promise<Response> {
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? (() => undefined);
  const requestId = deps.createRequestId?.() ?? randomUUID();
  const startedAt = now();
  const safeLog = (event: PolishAvailabilityLogEvent): void => {
    try {
      log(event);
    } catch {
      // Observability is non-authoritative and must not change the response.
    }
  };

  const deny = (code: PolishErrorCode, message: string): Response => {
    safeLog({
      event: "polish.availability.denied",
      requestId,
      code,
      latencyMs: now() - startedAt,
    });
    return errorResponse(requestId, code, message);
  };

  // Login only. Exact-bundle acceptance is computed inside the DB route
  // snapshot and returned as termsAccepted; this route never uses the static
  // current-terms helper as transmission authority.
  const auth = await verifyBearerUser(request.headers.get("authorization"), deps);
  if (!auth.ok) return deny(auth.error.code, auth.error.message);

  try {
    const decoded = decodePolishAvailabilityDbResult(
      await deps.readAvailability(auth.userId),
    );
    const availability = projectPolishAvailability(decoded);
    const body: PolishAvailabilityResponse = polishAvailabilityResponseSchema.parse({
      requestId,
      availability,
    });
    safeLog({
      event: "polish.availability.served",
      requestId,
      enabled: availability.enabled,
      latencyMs: now() - startedAt,
    });
    return Response.json(body, { status: 200, headers: baseHeaders(requestId) });
  } catch {
    return deny("INTERNAL_ERROR", "Failed to read AI polish availability.");
  }
}

export function createPolishAvailabilityHandler(
  deps: PolishAvailabilityDeps,
): (request: Request) => Promise<Response> {
  return (request) => handlePolishAvailabilityGet(request, deps);
}
