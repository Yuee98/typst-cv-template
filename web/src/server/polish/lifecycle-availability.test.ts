import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { polishAvailabilityResponseSchema } from "@/lib/polish/contract";
import {
  createPolishAvailabilityHandler,
  decodePolishAvailabilityDbResult,
  PolishAvailabilityReadError,
  projectPolishAvailability,
  readPolishAvailabilityV1,
  type PolishAvailabilityDbResult,
  type PolishAvailabilityDeps,
  type PolishAvailabilityLogEvent,
} from "./lifecycle-availability";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "availability-request-id";

const ENABLED = {
  enabled: true,
  configGeneration: "7",
  routingPolicyVersionId: "00000000-0000-4000-8000-000000000011",
  profileVersionId: "00000000-0000-4000-8000-000000000012",
  legalBundleVersion: "2026-08-23-multi-provider-v1",
  runtimeContractId: "deepseek-g2-runtime-v1",
  runtimeContractSha256: "a".repeat(64),
  displayDisclosureKey: "deepseek-official-v1",
  termsAccepted: true,
} as const;

const DISABLED = {
  enabled: false,
  configGeneration: null,
  routingPolicyVersionId: null,
  profileVersionId: null,
  legalBundleVersion: null,
  runtimeContractId: null,
  runtimeContractSha256: null,
  displayDisclosureKey: null,
  termsAccepted: false,
} as const;

function request(token = "valid-token"): Request {
  return new Request("https://test.local/api/polish/availability", {
    headers: { authorization: `Bearer ${token}` },
  });
}

function makeDeps(
  raw: unknown = ENABLED,
  overrides: Partial<PolishAvailabilityDeps> = {},
): {
  deps: PolishAvailabilityDeps;
  verifyAccessToken: ReturnType<typeof vi.fn>;
  readAvailability: ReturnType<typeof vi.fn>;
  logs: PolishAvailabilityLogEvent[];
} {
  const logs: PolishAvailabilityLogEvent[] = [];
  const verifyAccessToken = vi.fn(async () => USER_ID);
  const readAvailability = vi.fn(async () => raw);
  return {
    deps: {
      verifyAccessToken,
      readAvailability,
      now: () => 1_000,
      createRequestId: () => REQUEST_ID,
      logger: (event) => logs.push(event),
      ...overrides,
    },
    verifyAccessToken,
    readAvailability,
    logs,
  };
}

describe("availability DB codec", () => {
  it("accepts only the exact enabled and disabled nine-key unions", () => {
    expect(decodePolishAvailabilityDbResult(ENABLED)).toEqual(ENABLED);
    expect(decodePolishAvailabilityDbResult(DISABLED)).toEqual(DISABLED);

    for (const key of Object.keys(ENABLED)) {
      const missing = { ...ENABLED } as Record<string, unknown>;
      delete missing[key];
      expect(() => decodePolishAvailabilityDbResult(missing), key).toThrow();
    }
    expect(() =>
      decodePolishAvailabilityDbResult({ ...ENABLED, gatewayKind: "direct_deepseek" }),
    ).toThrow();
    expect(() => decodePolishAvailabilityDbResult({ ...DISABLED, reason: "disabled" })).toThrow();
  });

  it("rejects malformed identity, noncanonical bigint and partial runtime states", () => {
    for (const variant of [
      { configGeneration: 7 },
      { configGeneration: "07" },
      { configGeneration: "9223372036854775808" },
      { routingPolicyVersionId: "not-a-uuid" },
      { profileVersionId: "not-a-uuid" },
      { legalBundleVersion: "UPPERCASE" },
      { runtimeContractId: "contains space" },
      { runtimeContractSha256: "A".repeat(64) },
      { runtimeContractSha256: "a".repeat(63) },
      { displayDisclosureKey: "bad key" },
    ]) {
      expect(() =>
        decodePolishAvailabilityDbResult({ ...ENABLED, ...variant }),
      ).toThrow();
    }

    for (const variant of [
      { runtimeContractId: "runtime-v1" },
      { runtimeContractSha256: "a".repeat(64) },
      { configGeneration: "0" },
      { termsAccepted: true },
    ]) {
      expect(() =>
        decodePolishAvailabilityDbResult({ ...DISABLED, ...variant }),
      ).toThrow();
    }
  });
});

describe("availability disclosure projection", () => {
  it("never resolves a disclosure for the disabled branch", () => {
    const resolver = vi.fn();
    expect(projectPolishAvailability(DISABLED, resolver)).toEqual({
      enabled: false,
      configGeneration: null,
      routingPolicyVersionId: null,
      profileVersionId: null,
      legalBundleVersion: null,
      runtimeContractId: null,
      runtimeContractSha256: null,
      displayDisclosure: null,
      termsAccepted: false,
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("maps DeepSeek and MiMo keys only through the code registry", () => {
    expect(projectPolishAvailability(ENABLED).displayDisclosure).toEqual({
      key: "deepseek-official-v1",
      providerName: "DeepSeek",
      modelName: "DeepSeek V4 Flash",
    });
    const mimo = decodePolishAvailabilityDbResult({
      ...ENABLED,
      displayDisclosureKey: "mimo-cn-v1",
    });
    expect(projectPolishAvailability(mimo).displayDisclosure).toEqual({
      key: "mimo-cn-v1",
      providerName: "MiMo",
      modelName: "MiMo V2.5 Pro",
    });
  });

  it("fails closed for an unknown key or a mismatched registry result", () => {
    const unknown = decodePolishAvailabilityDbResult({
      ...ENABLED,
      displayDisclosureKey: "unregistered-provider-v1",
    });
    expect(() => projectPolishAvailability(unknown)).toThrow(/unknown display disclosure/);
    expect(() =>
      projectPolishAvailability(ENABLED, () => ({
        key: "mimo-cn-v1",
        providerName: "MiMo",
        modelName: "MiMo V2.5 Pro",
      })),
    ).toThrow(/mismatched key/);
  });
});

describe("availability service-role RPC wrapper", () => {
  it("calls the exact RPC once with only the verified user id", async () => {
    const rpc = vi.fn(async () => ({ data: ENABLED, error: null }));
    const client = { rpc } as unknown as Pick<SupabaseClient, "rpc">;
    await expect(readPolishAvailabilityV1(client, USER_ID)).resolves.toEqual(ENABLED);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("get_ai_polish_availability_v1", {
      p_user_id: USER_ID,
    });
  });

  it("keeps raw PostgREST detail only in the internal cause", async () => {
    const cause = { message: "sensitive SQL function and schema detail" };
    const rpc = vi.fn(async () => ({ data: null, error: cause }));
    const client = { rpc } as unknown as Pick<SupabaseClient, "rpc">;
    const error = await readPolishAvailabilityV1(client, USER_ID).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PolishAvailabilityReadError);
    expect(error).toMatchObject({
      message: "AI polish availability read failed",
      cause,
    });
  });
});

describe("GET /api/polish/availability", () => {
  it("is login-only and makes no DB call for missing, malformed or invalid bearer tokens", async () => {
    for (const candidate of [
      new Request("https://test.local/api/polish/availability"),
      new Request("https://test.local/api/polish/availability", {
        headers: { authorization: "Basic abc" },
      }),
    ]) {
      const mocks = makeDeps();
      const response = await createPolishAvailabilityHandler(mocks.deps)(candidate);
      expect(response.status).toBe(401);
      expect(mocks.verifyAccessToken).not.toHaveBeenCalled();
      expect(mocks.readAvailability).not.toHaveBeenCalled();
    }

    const mocks = makeDeps(ENABLED, {
      verifyAccessToken: vi.fn(async () => null),
    });
    const response = await createPolishAvailabilityHandler(mocks.deps)(request());
    expect(response.status).toBe(401);
    expect(mocks.readAvailability).not.toHaveBeenCalled();
  });

  it("maps authentication infrastructure failures to fixed 500 before DB", async () => {
    const mocks = makeDeps(ENABLED, {
      verifyAccessToken: vi.fn(async () => {
        throw new Error("raw auth service detail");
      }),
    });
    const response = await createPolishAvailabilityHandler(mocks.deps)(request());
    expect(response.status).toBe(500);
    expect(mocks.readAvailability).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain("raw auth service detail");
  });

  it("serves an unaccepted exact candidate without a compile-time terms gate", async () => {
    const mocks = makeDeps({ ...ENABLED, termsAccepted: false });
    const response = await createPolishAvailabilityHandler(mocks.deps)(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
    const body = await response.json();
    expect(polishAvailabilityResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      requestId: REQUEST_ID,
      availability: {
        enabled: true,
        termsAccepted: false,
        displayDisclosure: { providerName: "DeepSeek" },
      },
    });
    expect(mocks.verifyAccessToken).toHaveBeenCalledWith("valid-token");
    expect(mocks.readAvailability).toHaveBeenCalledWith(USER_ID);
    expect(mocks.logs).toEqual([
      {
        event: "polish.availability.served",
        requestId: REQUEST_ID,
        enabled: true,
        latencyMs: 0,
      },
    ]);
  });

  it("serves the exact disabled union rather than an AI_DISABLED error", async () => {
    const mocks = makeDeps(DISABLED);
    const response = await createPolishAvailabilityHandler(mocks.deps)(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      requestId: REQUEST_ID,
      availability: {
        enabled: false,
        configGeneration: null,
        routingPolicyVersionId: null,
        profileVersionId: null,
        legalBundleVersion: null,
        runtimeContractId: null,
        runtimeContractSha256: null,
        displayDisclosure: null,
        termsAccepted: false,
      },
    });
  });

  it("maps malformed DB data, unknown disclosure and RPC rejection to one safe 500", async () => {
    for (const raw of [
      { ...ENABLED, endpointAlias: "secret" },
      { ...ENABLED, runtimeContractSha256: null },
      { ...ENABLED, displayDisclosureKey: "unregistered-provider-v1" },
    ]) {
      const mocks = makeDeps(raw);
      const response = await createPolishAvailabilityHandler(mocks.deps)(request());
      expect(response.status).toBe(500);
      const serialized = JSON.stringify(await response.json());
      expect(serialized).toContain("Failed to read AI polish availability.");
      expect(serialized).not.toContain("endpointAlias");
      expect(serialized).not.toContain("unregistered-provider-v1");
    }

    const logs: PolishAvailabilityLogEvent[] = [];
    const rawDetail = "sensitive DB schema detail";
    const mocks = makeDeps(ENABLED, {
      readAvailability: vi.fn(async () => {
        throw new Error(rawDetail);
      }),
      logger: (event) => logs.push(event),
    });
    const response = await createPolishAvailabilityHandler(mocks.deps)(request());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain(rawDetail);
    expect(JSON.stringify(logs)).not.toContain(rawDetail);
    expect(logs).toEqual([
      {
        event: "polish.availability.denied",
        requestId: REQUEST_ID,
        code: "INTERNAL_ERROR",
        latencyMs: 0,
      },
    ]);
  });

  it("treats logger failure as non-authoritative", async () => {
    const mocks = makeDeps(ENABLED, {
      logger: () => {
        throw new Error("logger unavailable");
      },
    });
    const response = await createPolishAvailabilityHandler(mocks.deps)(request());
    expect(response.status).toBe(200);
  });

  it("uses the authenticated user only once per request", async () => {
    const mocks = makeDeps();
    const handler = createPolishAvailabilityHandler(mocks.deps);
    await handler(request());
    expect(mocks.verifyAccessToken).toHaveBeenCalledOnce();
    expect(mocks.readAvailability).toHaveBeenCalledOnce();
  });
});

describe("compile-time fixtures", () => {
  it("the enabled DB fixture satisfies the inferred strict union", () => {
    const parsed = decodePolishAvailabilityDbResult(ENABLED) satisfies PolishAvailabilityDbResult;
    expect(parsed.enabled).toBe(true);
  });
});
