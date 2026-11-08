import { describe, expect, it } from "vitest";
import { readAvailability } from "./availability";
import { createFakeRuntime } from "./fake";
import { fixtureInstance } from "./fixtures";
const userId = "10000000-0000-4000-8000-000000000002";
const fake = () => createFakeRuntime(() => new Date("2026-11-07T00:00:00Z"));

describe("public configuration names and recipient disclosures", () => {
  it("projects only the public display name without leaking execution configuration", async () => {
    const runtime = fake();
    runtime.fixture.configurations[0].display_name = "Fast writing";
    const availability = await readAvailability(runtime.db, userId, fixtureInstance, {}, false);
    expect(availability.configurations[0]).toMatchObject({ displayName: "Fast writing", status: "READY" });
    expect(Object.keys(availability.configurations[0]).sort()).toEqual(["configId", "configRevision", "displayName", "legalDisplay", "reason", "status"]);
    const json = JSON.stringify(availability);
    for (const internal of ["internal-connection-1", "fixture-model-1", "AI_PROVIDER_KEY_FIXTURE_1", "https://api.deepseek.com/responses"]) expect(json).not.toContain(internal);
    expect(availability.configurations[0].legalDisplay.provider.recipient_name).toBe("DeepSeek");
  });

  it("allows explicit reuse of one recipient document across distinct execution configurations", async () => {
    const runtime = fake();
    runtime.fixture.configurations[1].legal_display = structuredClone(runtime.fixture.configurations[0].legal_display);
    const availability = await readAvailability(runtime.db, userId, fixtureInstance, {}, false);
    expect(availability.configurations.map(configuration => configuration.status)).toEqual(["READY", "READY"]);
    expect(availability.configurations[0].legalDisplay).toEqual(availability.configurations[1].legalDisplay);
    expect(runtime.fixture.configurations[0].adapter_id).not.toBe(runtime.fixture.configurations[1].adapter_id);
    expect(runtime.fixture.configurations[0].endpoint_url).not.toBe(runtime.fixture.configurations[1].endpoint_url);
    expect(runtime.fixture.configurations[0].model_id).not.toBe(runtime.fixture.configurations[1].model_id);
  });

  it("does not offer a configuration whose explicitly selected document is disabled", async () => {
    const runtime = fake();
    runtime.fixture.configurations[0].legal_display.provider.enabled = false;
    const availability = await readAvailability(runtime.db, userId, fixtureInstance, {}, false);
    expect(availability.configurations[0]).toMatchObject({ status: "UNAVAILABLE", reason: "EXECUTION_CONFIG_UNAVAILABLE" });
  });

  it.each([undefined, "", "  "])("rejects a missing or blank display name instead of using the internal name: %s", async displayName => {
    const runtime = fake();
    Object.assign(runtime.fixture.configurations[0], { display_name: displayName });
    await expect(readAvailability(runtime.db, userId, fixtureInstance, {}, false)).rejects.toThrow();
  });
});
