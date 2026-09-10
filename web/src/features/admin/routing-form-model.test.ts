import { describe, expect, it } from "vitest";
import fixture from "../../../test/fixtures/routing-rules-v1.json";
import { routingDraft, serializeRoutingDraft, parseMinute } from "./routing-form-model";
const route = { profileVersionId: "11111111-1111-4111-8111-111111111111", priceVersionId: "22222222-2222-4222-8222-222222222222" };
describe("structured routing form contract", () => {
  it("roundtrips every stored fixture without changing order or references", () => {
    for (const rules of Object.values(fixture.validRules)) expect(serializeRoutingDraft(routingDraft(rules)!)).toEqual(rules);
    const rules = { schemaVersion: "routing_rules_v1", defaultRoute: route, windows: [{ weekdays: [7,1,3], startMinute: 0, endMinute: 1440, route }] };
    expect(serializeRoutingDraft(routingDraft(rules)!)).toEqual(rules);
  });
  it("accepts default-only and adjacent intervals, but rejects overlaps and overnight windows", () => {
    const draft = routingDraft(undefined, true)!; draft.defaultRoute = route;
    expect(serializeRoutingDraft(draft).windows).toEqual([]);
    draft.windows = [{ key: "a", weekdays: [1], start: "00:00", end: "12:00", route }, { key: "b", weekdays: [1], start: "12:00", end: "24:00", route }];
    expect(serializeRoutingDraft(draft).windows).toHaveLength(2);
    draft.windows[1].start = "11:59"; expect(() => serializeRoutingDraft(draft)).toThrow();
    draft.windows[1].start = "23:00"; draft.windows[1].end = "02:00"; expect(() => serializeRoutingDraft(draft)).toThrow();
    expect(parseMinute("24:00", true)).toBe(1440); expect(() => parseMinute("24:00")).toThrow();
  });
  it("blocks malformed stored rules and too many windows instead of resetting them", () => {
    expect(routingDraft({ schemaVersion: "future", windows: [] })).toBeNull();
    const draft = routingDraft(undefined, true)!; draft.defaultRoute = route;
    draft.windows = Array.from({ length: 32 }, (_, i) => ({ key: String(i), weekdays: [1], start: `00:${String(i).padStart(2, "0")}`, end: `00:${String(i + 1).padStart(2, "0")}`, route }));
    expect(serializeRoutingDraft(draft).windows).toHaveLength(32);
    draft.windows.push({ ...draft.windows[0] }); expect(() => serializeRoutingDraft(draft)).toThrow();
  });
});
