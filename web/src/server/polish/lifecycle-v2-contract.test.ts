import { describe, expect, it } from "vitest";

import fixture from "../../../test/fixtures/ai-runtime-execution-contract-v1.json";
import {
  EMPTY_RUNTIME_TARGET_RESOLVER_V1,
  PolishLifecycleV2ContractError,
  observeRouteIdentifierV1,
  parseAttemptCompleteRpcResultV2,
  parseAttemptStartRpcResultV2,
  parseExecutionSnapshotV1,
  parseExpectedRouteV1,
  parseFinalizeRpcResultV2,
  parseReserveRpcResultV2,
  parseRouteSnapshotV1,
  sameRouteSnapshotV1,
  type RouteSnapshotV1,
  type RuntimeExecutionTargetV1,
  type RuntimeTargetResolverV1,
} from "./lifecycle-v2-contract";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("test fixture must be an object");
  }
  return value as JsonRecord;
}

function cloneRecord(value: unknown): JsonRecord {
  return structuredClone(record(value));
}

function contractCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof PolishLifecycleV2ContractError) return error.code;
    throw error;
  }
  throw new Error("expected contract rejection");
}

const deepseekRaw = fixture.executionSnapshot.successes[0].value;
const deepseekRecord = record(deepseekRaw);
const deepseekReservationId = deepseekRecord.reservationId as string;
const deepseekRoute = parseRouteSnapshotV1(deepseekRecord.routeSnapshot);

function parseSuccess(
  value: unknown,
  options: {
    reservationId?: string;
    reserveRoute?: RouteSnapshotV1;
    resolver?: RuntimeTargetResolverV1;
  } = {},
) {
  return parseExecutionSnapshotV1(value, {
    reservationId: options.reservationId ?? deepseekReservationId,
    reserveRoute: options.reserveRoute ?? deepseekRoute,
    runtimeTargetResolver: options.resolver ?? (() => true),
  });
}

function materializeSecretInput(vector: {
  inputEncoding: string;
  input: unknown;
}): unknown {
  if (vector.inputEncoding === "json_value") return vector.input;
  expect(vector.inputEncoding).toBe("utf16_code_units_hex");
  expect(Array.isArray(vector.input)).toBe(true);
  return String.fromCharCode(
    ...(vector.input as unknown[]).map((unit) => Number.parseInt(String(unit), 16)),
  );
}

function expectExactObjectContract(
  parser: (value: unknown) => unknown,
  valid: JsonRecord,
): void {
  expect(parser(valid)).toBeDefined();
  expect(() => parser({ ...valid, unexpected: true })).toThrow(
    PolishLifecycleV2ContractError,
  );
  for (const key of Object.keys(valid)) {
    const missing = structuredClone(valid);
    delete missing[key];
    expect(() => parser(missing), `missing ${key}`).toThrow(
      PolishLifecycleV2ContractError,
    );
    expect(() => parser({ ...valid, [key]: null }), `null ${key}`).toThrow(
      PolishLifecycleV2ContractError,
    );
  }
}

describe("RT-009 strict V2 execution contract", () => {
  it("accepts every frozen execution success and exposes the complete runtime target", () => {
    for (const entry of fixture.executionSnapshot.successes) {
      const value = record(entry.value);
      const route = parseRouteSnapshotV1(value.routeSnapshot);
      let captured: RuntimeExecutionTargetV1 | undefined;
      const parsed = parseExecutionSnapshotV1(value, {
        reservationId: value.reservationId as string,
        reserveRoute: route,
        runtimeTargetResolver: (target) => {
          captured = target;
          return true;
        },
      });
      expect(parsed).toEqual(value);
      expect(captured).toMatchObject({
        schemaVersion: "runtime_execution_target_v1",
        runtimeContractId: route.runtimeContractId,
        runtimeContractSha256: route.runtimeContractSha256,
        legalBundleVersion: route.legalBundleVersion,
        profileVersionId: route.profileVersionId,
      });
      expect(captured?.routeDescriptor).toMatchObject({
        gatewayKind: route.gatewayKind,
        modelId: route.modelId,
        wireApiKind: route.wireApiKind,
        displayDisclosureKey: route.displayDisclosureKey,
      });
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(captured?.routeDescriptor)).toBe(true);
    }
  });

  it("parses the exact safe execution failures without consulting runtime authority", () => {
    for (const value of fixture.executionSnapshot.errors) {
      let resolverCalls = 0;
      const parsed = parseExecutionSnapshotV1(value, {
        reservationId: deepseekReservationId,
        reserveRoute: deepseekRoute,
        runtimeTargetResolver: () => {
          resolverCalls += 1;
          return true;
        },
      });
      expect(parsed).toEqual(value);
      expect(resolverCalls).toBe(0);
    }
  });

  it("keeps the initial runtime resolver empty and fail-closed", () => {
    expect(
      contractCode(() =>
        parseExecutionSnapshotV1(deepseekRaw, {
          reservationId: deepseekReservationId,
          reserveRoute: deepseekRoute,
          runtimeTargetResolver: EMPTY_RUNTIME_TARGET_RESOLVER_V1,
        }),
      ),
    ).toBe("RUNTIME_TARGET_UNAVAILABLE");
  });

  it("rejects every missing, extra, null, and malformed nested execution field", () => {
    const success = cloneRecord(deepseekRaw);
    expect(() => parseSuccess({ ...success, unexpected: true })).toThrow(
      PolishLifecycleV2ContractError,
    );
    for (const key of Object.keys(success)) {
      const missing = structuredClone(success);
      delete missing[key];
      expect(() => parseSuccess(missing), `missing execution ${key}`).toThrow(
        PolishLifecycleV2ContractError,
      );
      expect(
        () => parseSuccess({ ...success, [key]: null }),
        `null execution ${key}`,
      ).toThrow(PolishLifecycleV2ContractError);
    }

    for (const nestedKey of [
      "routeSnapshot",
      "profileExecutionConfig",
      "priceSnapshot",
    ] as const) {
      const nested = record(success[nestedKey]);
      expect(() =>
        parseSuccess({
          ...success,
          [nestedKey]: { ...nested, unexpected: true },
        }),
      ).toThrow(PolishLifecycleV2ContractError);
      for (const key of Object.keys(nested)) {
        const missingNested = structuredClone(nested);
        delete missingNested[key];
        expect(
          () => parseSuccess({ ...success, [nestedKey]: missingNested }),
          `missing ${nestedKey}.${key}`,
        ).toThrow(PolishLifecycleV2ContractError);
        expect(
          () =>
            parseSuccess({
              ...success,
              [nestedKey]: { ...nested, [key]: null },
            }),
          `null ${nestedKey}.${key}`,
        ).toThrow(PolishLifecycleV2ContractError);
      }
    }
  });

  it("rejects identity encodings and every cross-object authority drift before runtime resolution", () => {
    const mutations: JsonRecord[] = [];

    mutations.push({
      ...cloneRecord(deepseekRaw),
      reservationId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    });

    const leadingGeneration = cloneRecord(deepseekRaw);
    record(leadingGeneration.routeSnapshot).configGeneration = "01";
    mutations.push(leadingGeneration);

    const overflowGeneration = cloneRecord(deepseekRaw);
    record(overflowGeneration.routeSnapshot).configGeneration = "9223372036854775808";
    mutations.push(overflowGeneration);

    const uppercaseHash = cloneRecord(deepseekRaw);
    record(uppercaseHash.routeSnapshot).runtimeContractSha256 = "A".repeat(64);
    mutations.push(uppercaseHash);

    const routePriceDrift = cloneRecord(deepseekRaw);
    record(routePriceDrift.routeSnapshot).priceVersionId =
      "99999999-9999-4999-8999-999999999999";
    mutations.push(routePriceDrift);

    const routeModelDrift = cloneRecord(deepseekRaw);
    record(routeModelDrift.routeSnapshot).modelId = "deepseek-other";
    mutations.push(routeModelDrift);

    const profileDrift = cloneRecord(deepseekRaw);
    record(profileDrift.profileExecutionConfig).endpointAlias = "mimo_cn_official";
    mutations.push(profileDrift);

    const calculatorDrift = cloneRecord(deepseekRaw);
    record(calculatorDrift.priceSnapshot).calculatorKind = "openai_gpt56_v1";
    mutations.push(calculatorDrift);

    const legalDrift = cloneRecord(deepseekRaw);
    record(legalDrift.routeSnapshot).legalBundleVersion = "unknown.bundle.v1";
    mutations.push(legalDrift);

    for (const mutation of mutations) {
      let resolverCalls = 0;
      expect(() =>
        parseSuccess(mutation, {
          resolver: () => {
            resolverCalls += 1;
            return true;
          },
        }),
      ).toThrow(PolishLifecycleV2ContractError);
      expect(resolverCalls).toBe(0);
    }

    expect(
      contractCode(() =>
        parseSuccess(deepseekRaw, {
          reservationId: "99999999-9999-4999-8999-999999999999",
        }),
      ),
    ).toBe("EXECUTION_AUTHORITY_MISMATCH");

    const alternateReserve = {
      ...deepseekRoute,
      routingPolicyVersionId: "99999999-9999-4999-8999-999999999999",
    };
    expect(
      contractCode(() =>
        parseSuccess(deepseekRaw, { reserveRoute: alternateReserve }),
      ),
    ).toBe("EXECUTION_AUTHORITY_MISMATCH");
  });

  it("strictly parses expected-route assertions and compares all twelve route fields", () => {
    const expected = {
      schemaVersion: "expected_route_v1",
      configGeneration: deepseekRoute.configGeneration,
      profileVersionId: deepseekRoute.profileVersionId,
      legalBundleVersion: deepseekRoute.legalBundleVersion,
      runtimeContractId: deepseekRoute.runtimeContractId,
      runtimeContractSha256: deepseekRoute.runtimeContractSha256,
    };
    expect(parseExpectedRouteV1(expected)).toEqual(expected);
    expect(() => parseExpectedRouteV1({ ...expected, extra: true })).toThrow(
      PolishLifecycleV2ContractError,
    );
    for (const key of Object.keys(expected)) {
      const missing = { ...expected } as JsonRecord;
      delete missing[key];
      expect(() => parseExpectedRouteV1(missing)).toThrow(
        PolishLifecycleV2ContractError,
      );
    }

    expect(sameRouteSnapshotV1(deepseekRoute, { ...deepseekRoute })).toBe(true);
    for (const key of Object.keys(deepseekRoute) as (keyof RouteSnapshotV1)[]) {
      expect(
        sameRouteSnapshotV1(deepseekRoute, {
          ...deepseekRoute,
          [key]: `${deepseekRoute[key]}-drift`,
        }),
        key,
      ).toBe(false);
    }
  });

  it("rejects malformed execution failure shapes and unknown reasons", () => {
    const failure = cloneRecord(fixture.executionSnapshot.errors[0]);
    expect(() =>
      parseExecutionSnapshotV1({ ...failure, extra: true }, {
        reservationId: deepseekReservationId,
        reserveRoute: deepseekRoute,
        runtimeTargetResolver: () => true,
      }),
    ).toThrow(PolishLifecycleV2ContractError);
    for (const key of Object.keys(failure)) {
      const missing = structuredClone(failure);
      delete missing[key];
      expect(() =>
        parseExecutionSnapshotV1(missing, {
          reservationId: deepseekReservationId,
          reserveRoute: deepseekRoute,
          runtimeTargetResolver: () => true,
        }),
      ).toThrow(PolishLifecycleV2ContractError);
    }
    expect(() =>
      parseExecutionSnapshotV1({ ...failure, reason: "WRONG_USER" }, {
        reservationId: deepseekReservationId,
        reserveRoute: deepseekRoute,
        runtimeTargetResolver: () => true,
      }),
    ).toThrow(PolishLifecycleV2ContractError);
  });
});

describe("RT-009 CTRL-010 route observation production helper", () => {
  it("matches every derivation vector and separates gateway/provider domains", () => {
    for (const vector of fixture.routeObservation.derivationVectors) {
      expect(
        observeRouteIdentifierV1(
          vector.rawId,
          vector.fieldKind,
          vector.secretInput,
        ),
        vector.name,
      ).toEqual({ kind: "tagged", value: vector.expectedTag });
    }
    const [gateway, provider] = fixture.routeObservation.derivationVectors;
    expect(gateway.rawId).toBe(provider.rawId);
    expect(gateway.expectedTag).not.toBe(provider.expectedTag);
  });

  it("matches every absent/drop vector without consulting the field or secret", () => {
    for (const vector of fixture.routeObservation.dropVectors) {
      const observed = observeRouteIdentifierV1(
        vector.input,
        "intentionally_invalid_field",
        null,
      );
      expect(observed.kind, vector.name).toBe(vector.expectedKind);
      if (observed.kind === "dropped") {
        expect(observed.reason, vector.name).toBe(vector.expectedReason);
      }
    }
  });

  it("matches all twenty-five scalar edge trims without normalizing the secret", () => {
    const edge = fixture.routeObservation.edgeTrimVectors;
    for (const testCase of edge.cases) {
      const scalar = String.fromCodePoint(
        Number.parseInt(testCase.scalarCodePointHex, 16),
      );
      expect(
        observeRouteIdentifierV1(
          edge.rawId,
          edge.fieldKind,
          `${scalar}${edge.secretCore}${scalar}`,
        ),
        testCase.name,
      ).toEqual({ kind: "tagged", value: edge.expectedTag });
    }
  });

  it("returns the exact safe secret error codes, including unpaired surrogates", () => {
    for (const vector of fixture.routeObservation.secretErrorVectors) {
      expect(
        contractCode(() =>
          observeRouteIdentifierV1(
            "routeVector_123",
            "gateway_request_id",
            materializeSecretInput(vector),
          ),
        ),
        vector.name,
      ).toBe(vector.expectedCode);
    }
  });
});

describe("RT-009 exact RPC result codecs", () => {
  const reserveSuccess = {
    allowed: true,
    reservationId: deepseekReservationId,
    limit: 20,
    remaining: 19,
    resetAt: "2026-08-26T00:00:00+00:00",
    routeSnapshot: deepseekRecord.routeSnapshot,
  };
  const reserveBasic = {
    allowed: false,
    reason: "AI_ROUTE_CHANGED",
    message: "Refresh availability.",
  };
  const reserveQuota = {
    allowed: false,
    reason: "QUOTA_EXCEEDED",
    message: "Quota exhausted.",
    remaining: 0,
    resetAt: "2026-08-26T00:00:00+00:00",
  };
  const reserveRate = {
    allowed: false,
    reason: "RATE_LIMITED",
    message: "Slow down.",
    retryAfterSeconds: 30,
  };
  const attemptStart = {
    ok: true,
    attemptId: "44444444-4444-4444-8444-444444444444",
    attemptNo: 1,
    alreadyStarted: false,
    status: "started",
    routeSnapshot: deepseekRecord.routeSnapshot,
  };
  const attemptComplete = {
    ok: true,
    alreadyCompleted: false,
    status: "succeeded",
    usageComplete: true,
  };
  const finalize = {
    ok: true,
    alreadyFinalized: false,
    status: "succeeded",
    quotaCharged: true,
    quota: {
      limit: 20,
      remaining: 19,
      resetAt: "2026-08-26T00:00:00+00:00",
    },
  };

  it("accepts each exact success and reserve denial union", () => {
    expect(parseReserveRpcResultV2(reserveSuccess)).toEqual(reserveSuccess);
    expect(parseReserveRpcResultV2(reserveBasic)).toEqual(reserveBasic);
    expect(parseReserveRpcResultV2(reserveQuota)).toEqual(reserveQuota);
    expect(parseReserveRpcResultV2(reserveRate)).toEqual(reserveRate);
    expect(parseAttemptStartRpcResultV2(attemptStart)).toEqual(attemptStart);
    expect(parseAttemptCompleteRpcResultV2(attemptComplete)).toEqual(
      attemptComplete,
    );
    expect(parseFinalizeRpcResultV2(finalize)).toEqual(finalize);
  });

  it("requires every success field, rejects extras/nulls, and freezes unknown enums", () => {
    expectExactObjectContract(
      parseReserveRpcResultV2,
      reserveSuccess as JsonRecord,
    );
    expectExactObjectContract(
      parseAttemptStartRpcResultV2,
      attemptStart as JsonRecord,
    );
    expectExactObjectContract(
      parseAttemptCompleteRpcResultV2,
      attemptComplete as JsonRecord,
    );
    expectExactObjectContract(parseFinalizeRpcResultV2, finalize as JsonRecord);

    expect(() =>
      parseReserveRpcResultV2({ ...reserveBasic, reason: "NEW_REASON" }),
    ).toThrow(PolishLifecycleV2ContractError);
    expect(() =>
      parseAttemptStartRpcResultV2({ ...attemptStart, status: "queued" }),
    ).toThrow(PolishLifecycleV2ContractError);
    expect(() =>
      parseAttemptCompleteRpcResultV2({
        ...attemptComplete,
        status: "unknown",
      }),
    ).toThrow(PolishLifecycleV2ContractError);
    expect(() =>
      parseFinalizeRpcResultV2({ ...finalize, status: "new_status" }),
    ).toThrow(PolishLifecycleV2ContractError);
  });

  it("strictly validates every denial/failure shape and vocabulary", () => {
    for (const denial of [reserveBasic, reserveQuota, reserveRate]) {
      expectExactObjectContract(
        parseReserveRpcResultV2,
        denial as JsonRecord,
      );
    }
    for (const [parser, failure] of [
      [parseAttemptStartRpcResultV2, { ok: false, reason: "AI_DISABLED" }],
      [
        parseAttemptCompleteRpcResultV2,
        { ok: false, reason: "ATTEMPT_COMPLETION_CONFLICT" },
      ],
      [parseFinalizeRpcResultV2, { ok: false, reason: "ATTEMPT_IN_PROGRESS" }],
    ] as const) {
      expectExactObjectContract(parser, failure);
      expect(() => parser({ ok: false, reason: "UNKNOWN_REASON" })).toThrow(
        PolishLifecycleV2ContractError,
      );
    }
  });

  it("rejects noncanonical UUID/hash/bigint and bounded-number neighbors", () => {
    expect(() =>
      parseReserveRpcResultV2({
        ...reserveSuccess,
        reservationId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      }),
    ).toThrow(PolishLifecycleV2ContractError);
    expect(() =>
      parseReserveRpcResultV2({ ...reserveSuccess, remaining: -1 }),
    ).toThrow(PolishLifecycleV2ContractError);
    expect(() =>
      parseReserveRpcResultV2({ ...reserveSuccess, limit: 2_147_483_648 }),
    ).toThrow(PolishLifecycleV2ContractError);
    expect(() =>
      parseAttemptStartRpcResultV2({ ...attemptStart, attemptNo: 3 }),
    ).toThrow(PolishLifecycleV2ContractError);
    expect(() =>
      parseFinalizeRpcResultV2({
        ...finalize,
        quota: { ...finalize.quota, resetAt: "not-a-time" },
      }),
    ).toThrow(PolishLifecycleV2ContractError);
  });
});
