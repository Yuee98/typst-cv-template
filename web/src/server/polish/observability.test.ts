import { describe, expect, it } from "vitest";

import {
  PolishObservabilityProjectionError,
  createPolishObservabilityProjectorV1,
  projectPolishAttemptObservabilityEventV1,
  projectPolishRequestObservabilityEventV1,
} from "./observability";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_1_ID = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_2_ID = "33333333-3333-4333-8333-333333333333";
const PROFILE_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const POLICY_VERSION_ID = "55555555-5555-4555-8555-555555555555";
const PRICE_VERSION_ID = "66666666-6666-4666-8666-666666666666";
const TAG = `hmac-sha256:${"a".repeat(64)}`;

function profile() {
  return {
    profileKey: "deepseek.official.deepseek-v4-flash.chat.v1",
    profileVersionId: PROFILE_VERSION_ID,
    gatewayKind: "direct_deepseek",
    modelId: "deepseek-v4-flash",
  };
}

function policy() {
  return {
    configGeneration: "42",
    routingPolicyVersionId: POLICY_VERSION_ID,
    priceVersionId: PRICE_VERSION_ID,
    legalBundleVersion: "2026-08-23-multi-provider-v1",
    runtimeContractId: "ai-polish-runtime-v1",
    runtimeContractSha256: "b".repeat(64),
  };
}

function observedUsage() {
  return {
    availability: "observed",
    complete: true,
    cacheWrite: "reported",
    inputTotalTokens: "12",
    inputCacheReadTokens: "5",
    inputCacheWriteTokens: "3",
    inputStandardTokens: "7",
    outputTokens: "8",
    reasoningTokens: "2",
  };
}

function matchedCost() {
  return {
    currency: "CNY",
    estimatedNanos: "123",
    providerReportedNanos: "123",
    reconciliation: "matched",
  };
}

function attemptFact(attemptNo = 1) {
  return {
    requestId: REQUEST_ID,
    attemptId: attemptNo === 1 ? ATTEMPT_1_ID : ATTEMPT_2_ID,
    attemptNo,
    profile: profile(),
    policy: policy(),
    upstream: {
      status: "succeeded",
      transmitted: true,
      httpStatus: 200,
      gatewayRequestTag: TAG,
      providerRequestTag: TAG,
    },
    usage: observedUsage(),
    cost: matchedCost(),
  };
}

function requestFact() {
  return {
    requestId: REQUEST_ID,
    attemptCount: 2,
    retryCount: 1,
    retry: "succeeded",
    outcome: "succeeded",
    profile: profile(),
    policy: policy(),
    upstream: {
      transmittedAttemptCount: 2,
      successfulAttemptCount: 1,
      latestHttpStatus: 200,
    },
    usage: observedUsage(),
    cost: matchedCost(),
  };
}

describe("polish observability projections", () => {
  it("projects immutable, content-free attempt events with tagged upstream correlation only", () => {
    const event = projectPolishAttemptObservabilityEventV1(attemptFact());

    expect(event).toEqual({
      schemaVersion: "polish_observability_event_v1",
      event: "ai_polish_attempt",
      aggregation: "attempt",
      requestId: REQUEST_ID,
      attemptId: ATTEMPT_1_ID,
      attemptNo: 1,
      retry: false,
      success: true,
      profile: profile(),
      policy: policy(),
      upstream: {
        status: "succeeded",
        transmitted: true,
        httpStatus: 200,
        gatewayRequestTag: TAG,
        providerRequestTag: TAG,
      },
      usage: observedUsage(),
      cost: matchedCost(),
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.profile)).toBe(true);
    expect(Object.isFrozen(event.upstream)).toBe(true);
    expect(JSON.stringify(event)).not.toContain("provider-req-123");
    expect(JSON.stringify(event)).not.toContain("resume body");
  });

  it("keeps a retry attempt separate from the request aggregate, preserving the old request id", () => {
    const retryAttempt = projectPolishAttemptObservabilityEventV1(attemptFact(2));
    const request = projectPolishRequestObservabilityEventV1(requestFact());

    expect(retryAttempt).toMatchObject({
      aggregation: "attempt",
      requestId: REQUEST_ID,
      attemptNo: 2,
      retry: true,
    });
    expect(request).toMatchObject({
      aggregation: "request",
      requestId: REQUEST_ID,
      attemptCount: 2,
      retryCount: 1,
      retry: "succeeded",
      success: true,
    });
    expect(Object.hasOwn(request, "attempts")).toBe(false);
  });

  it("supports unavailable usage and incomplete cost without inventing token or cost facts", () => {
    const event = projectPolishAttemptObservabilityEventV1({
      ...attemptFact(),
      upstream: {
        status: "failed_upstream",
        transmitted: true,
        httpStatus: 503,
        gatewayRequestTag: null,
        providerRequestTag: null,
      },
      usage: {
        availability: "unavailable",
        complete: false,
        cacheWrite: "unavailable",
        inputTotalTokens: null,
        inputCacheReadTokens: null,
        inputCacheWriteTokens: null,
        inputStandardTokens: null,
        outputTokens: null,
        reasoningTokens: null,
      },
      cost: {
        currency: "CNY",
        estimatedNanos: null,
        providerReportedNanos: "77",
        reconciliation: "incomplete_usage",
      },
    });

    expect(event).toMatchObject({
      success: false,
      usage: { availability: "unavailable", complete: false, cacheWrite: "unavailable" },
      cost: { reconciliation: "incomplete_usage", estimatedNanos: null },
    });
  });

  it("fails closed for raw correlation ids, content-shaped fields, unknown routes, and invalid reconciliation", () => {
    const rawProviderId = {
      ...attemptFact(),
      upstream: { ...attemptFact().upstream, providerRequestTag: "provider-req-123" },
    };
    const contentField = { ...attemptFact(), selectedContext: "resume body" };
    const unknownRoute = {
      ...attemptFact(),
      upstream: { ...attemptFact().upstream, status: "redirected" },
    };
    const falseMatch = {
      ...attemptFact(),
      cost: { ...matchedCost(), providerReportedNanos: "124" },
    };

    for (const fact of [rawProviderId, contentField, unknownRoute, falseMatch]) {
      expect(() => projectPolishAttemptObservabilityEventV1(fact)).toThrow(
        PolishObservabilityProjectionError,
      );
    }
  });

  it("requires cache-write and token conservation invariants", () => {
    const missingReportedWrite = {
      ...attemptFact(),
      usage: { ...observedUsage(), inputCacheWriteTokens: null },
    };
    const nonConservingTokens = {
      ...attemptFact(),
      usage: { ...observedUsage(), inputStandardTokens: "8" },
    };

    for (const fact of [missingReportedWrite, nonConservingTokens]) {
      expect(() => projectPolishAttemptObservabilityEventV1(fact)).toThrow(
        PolishObservabilityProjectionError,
      );
    }
  });

  it("offers a backend-neutral composition seam without swallowing sink behavior", () => {
    const emitted: unknown[] = [];
    const projector = createPolishObservabilityProjectorV1((event) => emitted.push(event));

    const attempt = projector.emitAttempt(attemptFact());
    const request = projector.emitRequest(requestFact());

    expect(emitted).toEqual([attempt, request]);
    expect(Object.isFrozen(projector)).toBe(true);
    expect(() => createPolishObservabilityProjectorV1(undefined as never)).toThrow(
      PolishObservabilityProjectionError,
    );
  });
});
