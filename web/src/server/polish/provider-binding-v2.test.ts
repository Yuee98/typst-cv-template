import { describe, expect, it, vi } from "vitest";
import fixtures from "../../../test/fixtures/profile-execution-v2.json";
import { createProviderSecretResolver, prepareProviderTransportV2, validateProviderEndpoint } from "./provider-binding-v2";
import { validateProfileExecutionConfigV2 } from "./profile-execution-v2";

describe("code-owned v2 provider binding", () => {
  it("never reads a non-provider secret and snapshots only valid names", () => {
    const env = { AI_PROVIDER_KEY_DEEPSEEK_PRIMARY: "test-secret" };
    Object.defineProperty(env, "SUPABASE_SERVICE_ROLE_KEY", { enumerable: true, get() { throw new Error("must never read unrelated secret"); } });
    const resolve = createProviderSecretResolver(env);
    expect(resolve("AI_PROVIDER_KEY_DEEPSEEK_PRIMARY")).toBe("test-secret");
    expect(() => resolve("SUPABASE_SERVICE_ROLE_KEY")).toThrow();
    expect(() => resolve("__proto__")).toThrow();
    env.AI_PROVIDER_KEY_DEEPSEEK_PRIMARY = "later";
    expect(resolve("AI_PROVIDER_KEY_DEEPSEEK_PRIMARY")).toBe("test-secret");
  });
  it.each([
    "http://api.deepseek.com/chat/completions", "https://api.deepseek.com.evil.test/chat/completions",
    "https://localhost/chat/completions", "https://127.0.0.1/chat/completions", "https://[::1]/chat/completions",
    "https://169.254.169.254/chat/completions", "https://api.deepseek.com:8443/chat/completions",
    "https://key@api.deepseek.com/chat/completions", "https://api.deepseek.com/chat/completions?key=x",
    "https://api.deepseek.com/chat/completions#x", "https://API.DEEPSEEK.COM/chat/completions",
    "https://api.deepseek.com:443/chat/completions", "https://api.deepseek.com/ignored/../chat/completions",
    "https://api.deepseek.com/v1/responses",
  ])("rejects unapproved or noncanonical destination %s", endpointUrl => {
    const profile = validateProfileExecutionConfigV2({ ...fixtures.deepseek, endpointUrl });
    expect(() => validateProviderEndpoint(profile)).toThrow();
  });
  it("binds the namespace secret to the exact code-approved recipient, provider and origin before reading it", () => {
    const resolveSecret = vi.fn().mockReturnValue("fake-provider-key");
    const input = { profile: fixtures.deepseek, recipient: { providerId: fixtures.deepseek.providerId, recipientKey: "deepseek" }, resolveSecret };
    const prepared = prepareProviderTransportV2(input);
    expect(prepared.endpoint).toBe(fixtures.deepseek.endpointUrl);
    expect(prepared.profile.modelId).toBe("synthetic-compatible-model");
    resolveSecret.mockClear();
    for (const override of [
      { recipient: { ...input.recipient, recipientKey: "xiaomi-mimo" } },
      { profile: { ...fixtures.deepseek, providerId: fixtures.mimo.providerId } },
      { profile: { ...fixtures.deepseek, credentialEnvName: "AI_PROVIDER_KEY_MIMO_PRIMARY" } },
    ]) expect(() => prepareProviderTransportV2({ ...input, ...override })).toThrow();
    expect(resolveSecret).not.toHaveBeenCalled();
  });
  it("rejects a crossed DeepSeek credential name for the MiMo transport", () => {
    expect(() => prepareProviderTransportV2({
      profile: { ...fixtures.mimo, credentialEnvName: "AI_PROVIDER_KEY_DEEPSEEK_PRIMARY" },
      recipient: { providerId: fixtures.mimo.providerId, recipientKey: "xiaomi-mimo" },
      resolveSecret: () => "fake-provider-key",
    })).toThrow();
  });
});

it("keeps custom directory drafts outside executable transports before reading secrets", () => {
  const resolveSecret = vi.fn(() => "unused-local-secret");
  expect(() => prepareProviderTransportV2({ profile: { ...fixtures.deepseek, gatewayKind: "custom_compatible", endpointUrl: "https://example.test/chat/completions" }, recipient: { providerId: fixtures.deepseek.providerId, recipientKey: "custom-test" }, resolveSecret })).toThrow();
  expect(resolveSecret).not.toHaveBeenCalled();
});
