import { describe, expect, it } from "vitest";
import fixture from "../../../test/fixtures/routing-rules-v1.json";
import {
  ROUTING_RULES_V1_TIME_ZONE,
  RoutingRulesV1Error,
  selectRoutingRouteV1,
  validateRoutingRulesV1,
} from "./routing-rules-v1";

describe("routing_rules_v1", () => {
  it("validates the shared initial routing fixture and detaches it from caller mutation", () => {
    const source = structuredClone(fixture.validRules);
    const rules = validateRoutingRulesV1(source);

    source.defaultRoute.profileVersionId = fixture.routes.mimoDefault.profileVersionId;
    source.windows[0].weekdays[0] = 7;

    expect(rules.defaultRoute).toEqual(fixture.routes.deepseekOffpeak);
    expect(rules.windows[0].weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(Object.isFrozen(rules)).toBe(true);
    expect(Object.isFrozen(rules.windows)).toBe(true);
    expect(Object.isFrozen(rules.windows[0].weekdays)).toBe(true);
  });

  it.each(fixture.selectionCases)(
    "selects $expectedRoute for $name using the explicit Shanghai timestamp",
    ({ at, expectedRoute }) => {
      const rules = validateRoutingRulesV1(fixture.validRules);

      expect(
        selectRoutingRouteV1(rules, new Date(at), fixture.policyTimeZone),
      ).toEqual(fixture.routes[expectedRoute as keyof typeof fixture.routes]);
    },
  );

  it("requires exactly Asia/Shanghai and a valid explicit timestamp", () => {
    const rules = validateRoutingRulesV1(fixture.validRules);

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

  it("enforces the 32-window maximum", () => {
    const route = fixture.routes.mimoDefault;
    const windows = Array.from({ length: 33 }, (_, index) => ({
      weekdays: [(index % 7) + 1],
      startMinute: index,
      endMinute: index + 1,
      route,
    }));

    expect(() =>
      validateRoutingRulesV1({
        schemaVersion: "routing_rules_v1",
        defaultRoute: fixture.routes.deepseekOffpeak,
        windows,
      }),
    ).toThrow(/at most 32/);
  });

  it("allows adjacent windows and equal clock ranges on disjoint weekdays", () => {
    expect(() =>
      validateRoutingRulesV1({
        schemaVersion: "routing_rules_v1",
        defaultRoute: fixture.routes.deepseekOffpeak,
        windows: [
          { weekdays: [1], startMinute: 0, endMinute: 720, route: fixture.routes.mimoDefault },
          {
            weekdays: [1],
            startMinute: 720,
            endMinute: 1440,
            route: fixture.routes.mimoDefault,
          },
          { weekdays: [2], startMinute: 0, endMinute: 720, route: fixture.routes.mimoDefault },
        ],
      }),
    ).not.toThrow();
  });

  it("freezes the code-owned route observation alias/model/endpoint pairs", () => {
    expect(fixture.routeObservationPairs).toEqual([
      {
        profileKey: "deepseek.official.deepseek-v4-flash.chat.v1",
        endpointAlias: "deepseek_official",
        modelId: "deepseek-v4-flash",
        canonicalEndpoint: "https://api.deepseek.com/chat/completions",
      },
      {
        profileKey: "mimo.cn.mimo-v2.5-pro.responses.v1",
        endpointAlias: "mimo_cn_official",
        modelId: "mimo-v2.5-pro",
        canonicalEndpoint: "https://api.xiaomimimo.com/v1/responses",
      },
    ]);
  });
});
