import { describe, expect, it } from "vitest";
import { filterPublicEvent } from "./public-event";

describe("public telemetry boundary", () => {
  it("rejects private events and delayed public events while on a private page", () => {
    const origin = "https://example.com";
    for (const path of ["/zh/admin", "/en/admin/users?id=private", "/en/admin/profiles/id", "/api/admin", "/zh/%61dmin"]) {
      expect(filterPublicEvent({ url: origin + path }, origin + "/zh")).toBeNull();
      expect(filterPublicEvent({ url: origin + "/zh" }, origin + path)).toBeNull();
    }
    expect(filterPublicEvent({ url: "https://foreign.example/zh" }, origin + "/zh")).toBeNull();
  });
  it("resumes for public pages and removes query/hash even after a round trip", () => {
    const event = { type: "vital", url: "https://example.com/en/privacy?search=private#state" };
    expect(filterPublicEvent(event, "https://example.com/en/admin")).toBeNull();
    expect(filterPublicEvent(event, "https://example.com/en/privacy")).toEqual({ ...event, url: "https://example.com/en/privacy" });
  });
});
