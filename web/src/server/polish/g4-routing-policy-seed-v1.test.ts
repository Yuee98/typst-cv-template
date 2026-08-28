import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import fixture from "../../../test/fixtures/routing-rules-v1.json";
import { G4_ROUTING_POLICY_SEED_V1 } from "./g4-routing-policy-seed-v1";
import { selectRoutingRouteV1, validateRoutingRulesV1 } from "./routing-rules-v1";

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, JsonValue>)[key])}`).join(",")}}`;
}

function sha256(value: JsonValue): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

function expectDeeplyFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeeplyFrozen(child);
}

describe("CFG-003 G4 daily routing policy seed", () => {
  it("is a deeply frozen literal graph with exact JCS digests", () => {
    expectDeeplyFrozen(G4_ROUTING_POLICY_SEED_V1);
    for (const policy of Object.values(G4_ROUTING_POLICY_SEED_V1.policies)) {
      expect(sha256(policy.jcsInput)).toBe(policy.configSha256);
    }
  });

  it("uses daily windows while preserving G2 as a distinct historical policy", () => {
    const { g4, rollback } = G4_ROUTING_POLICY_SEED_V1.policies;
    expect(validateRoutingRulesV1(g4.rules)).toEqual(fixture.validRules.g4InitialProvider);
    expect(validateRoutingRulesV1(rollback.rules).windows.map((window) => window.route)).toEqual([
      fixture.routes.deepseekPeak,
      fixture.routes.deepseekPeak,
    ]);
    expect(fixture.validRules.g2DeepseekOnly.windows[0].weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(g4.rules.windows.flatMap((window) => window.weekdays)).toEqual([1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5, 6, 7]);
  });

  it.each(Array.from({ length: 7 }, (_, index) => index))(
    "uses the same half-open boundaries on ISO weekday %i",
    (offset) => {
      const day = String(24 + offset).padStart(2, "0");
      const expected = [
        ["00:59:59", fixture.routes.deepseekOffpeak],
        ["01:00:00", fixture.routes.mimoDefault],
        ["03:59:59", fixture.routes.mimoDefault],
        ["04:00:00", fixture.routes.deepseekOffpeak],
        ["05:59:59", fixture.routes.deepseekOffpeak],
        ["06:00:00", fixture.routes.mimoDefault],
        ["09:59:59", fixture.routes.mimoDefault],
        ["10:00:00", fixture.routes.deepseekOffpeak],
      ] as const;

      for (const [clock, route] of expected) {
        expect(
          selectRoutingRouteV1(
            G4_ROUTING_POLICY_SEED_V1.policies.g4.rules,
            new Date(`2026-08-${day}T${clock}.000Z`),
            "Asia/Shanghai",
          ),
        ).toEqual(route);
      }
    },
  );

  it("preserves off-peak routing across the UTC date rollover", () => {
    const rules = G4_ROUTING_POLICY_SEED_V1.policies.g4.rules;
    expect(selectRoutingRouteV1(rules, new Date("2026-08-23T15:59:59.000Z"), "Asia/Shanghai")).toEqual(fixture.routes.deepseekOffpeak);
    expect(selectRoutingRouteV1(rules, new Date("2026-08-23T16:00:00.000Z"), "Asia/Shanghai")).toEqual(fixture.routes.deepseekOffpeak);
  });
});
