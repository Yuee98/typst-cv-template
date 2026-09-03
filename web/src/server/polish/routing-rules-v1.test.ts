import { describe, expect, it } from "vitest";
import fixture from "../../../test/fixtures/routing-rules-v1.json";
import { resolveEndpoint } from "./adapter-registry";
import { PROFILE_KEYS, resolveProfile } from "./profile-registry";
import {
  ROUTING_RULES_V1_TIME_ZONE,
  RoutingRulesV1Error,
  selectRoutingRouteV1,
  validateRoutingRulesV1,
} from "./routing-rules-v1";

describe("routing_rules_v1", () => {
  it("validates the shared initial routing fixture and detaches it from caller mutation", () => {
    const source = structuredClone(fixture.validRules.g4InitialProvider);
    const rules = validateRoutingRulesV1(source);

    source.defaultRoute.profileVersionId = fixture.routes.mimoDefault.profileVersionId;
    source.windows[0].weekdays[0] = 7;

    expect(rules.defaultRoute).toEqual(fixture.routes.deepseekOffpeak);
    expect(rules.windows[0].weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(Object.isFrozen(rules)).toBe(true);
    expect(Object.isFrozen(rules.windows)).toBe(true);
    expect(Object.isFrozen(rules.windows[0].weekdays)).toBe(true);
  });

  it("freezes distinct G2 DeepSeek-only and G4 MiMo-peak exact route pairs", () => {
    const g2 = validateRoutingRulesV1(fixture.validRules.g2DeepseekOnly);
    const g4 = validateRoutingRulesV1(fixture.validRules.g4InitialProvider);

    expect(g2.defaultRoute).toEqual(fixture.routes.deepseekOffpeak);
    expect(g2.windows.map(({ route }) => route)).toEqual([
      fixture.routes.deepseekPeak,
      fixture.routes.deepseekPeak,
    ]);
    expect(g2.windows[0].route.profileVersionId).toBe(g2.defaultRoute.profileVersionId);
    expect(g2.windows[0].route.priceVersionId).not.toBe(g2.defaultRoute.priceVersionId);

    expect(g4.defaultRoute).toEqual(fixture.routes.deepseekOffpeak);
    expect(g4.windows.map(({ route }) => route)).toEqual([
      fixture.routes.mimoDefault,
      fixture.routes.mimoDefault,
    ]);
  });

  it.each(fixture.selectionCases)(
    "selects $expectedRoute for $name using the explicit Shanghai timestamp",
    ({ at, expectedRoute, rulesFixture }) => {
      const rules = validateRoutingRulesV1(
        fixture.validRules[rulesFixture as keyof typeof fixture.validRules],
      );

      expect(
        selectRoutingRouteV1(rules, new Date(at), fixture.policyTimeZone),
      ).toEqual(fixture.routes[expectedRoute as keyof typeof fixture.routes]);
    },
  );

  it("requires exactly Asia/Shanghai and a valid explicit timestamp", () => {
    const rules = validateRoutingRulesV1(fixture.validRules.g4InitialProvider);

    expect(() => selectRoutingRouteV1(rules, new Date(0), "UTC")).toThrow(
      /requires policy timezone Asia\/Shanghai/,
    );
    expect(() =>
      selectRoutingRouteV1(rules, new Date(Number.NaN), ROUTING_RULES_V1_TIME_ZONE),
    ).toThrow(/valid explicit Date/);
  });

  it.each(fixture.invalidCases)("rejects shared invalid shape: $name", ({ value }) => {
    expect(() => validateRoutingRulesV1(value)).toThrow(RoutingRulesV1Error);
  });

  it.each(fixture.generatedWindowCountCases)("$name", ({ accepted, count }) => {
    const windows = Array.from({ length: count }, (_, index) => ({
      weekdays: [1],
      startMinute: index,
      endMinute: index + 1,
      route: fixture.routes.mimoDefault,
    }));
    const validate = () =>
      validateRoutingRulesV1({
        schemaVersion: "routing_rules_v1",
        defaultRoute: fixture.routes.deepseekOffpeak,
        windows,
      });

    if (accepted) {
      expect(validate).not.toThrow();
    } else {
      expect(validate).toThrow(/at most 32/);
    }
  });

  it.each(fixture.validShapeCases)("accepts shared valid shape: $name", ({ value }) => {
    expect(() => validateRoutingRulesV1(value)).not.toThrow();
  });

  it("mirrors every frozen profile's route observation identity from the real registry", () => {
    expect(fixture.routeObservationPairs.map(({ profileKey }) => profileKey).sort()).toEqual(
      [...PROFILE_KEYS].sort(),
    );

    for (const expected of fixture.routeObservationPairs) {
      const profile = resolveProfile(expected.profileKey);
      expect(profile.endpointAlias).toBe(expected.endpointAlias);
      expect(profile.modelId).toBe(expected.modelId);
      expect(resolveEndpoint(profile.endpointAlias).url).toBe(expected.canonicalEndpoint);
    }
  });
});
