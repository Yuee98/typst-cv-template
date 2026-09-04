import { describe, expect, it, vi } from "vitest";
import fixtures from "../../../test/fixtures/profile-execution-v2.json";
import { createProviderSecretResolver, parseProviderBindingManifest, prepareProviderTransportV2, validateProviderEndpoint } from "./provider-binding-v2";
import { validateProfileExecutionConfigV2 } from "./profile-execution-v2";

const manifest = { schemaVersion: "ai_provider_bindings_v1", revision: "local-test-v1", bindings: [{
  credentialEnvName: fixtures.deepseek.credentialEnvName,
  providerId: fixtures.deepseek.providerId,
  recipientKey: "deepseek", origin: "https://api.deepseek.com",
}] };

describe("deployment-owned v2 binding", () => {
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
  it("binds the namespace secret to the exact legal recipient, provider and manifest revision before reading it", () => {
    const resolveSecret = vi.fn().mockReturnValue("fake-provider-key");
    const input = { profile: fixtures.deepseek, recipient: { providerId: fixtures.deepseek.providerId, recipientKey: "deepseek" },
      manifest, expectedManifestRevision: "local-test-v1", runtimeBuildId: "local.test-build", resolveSecret };
    const prepared = prepareProviderTransportV2(input);
    expect(prepared.endpoint).toBe(fixtures.deepseek.endpointUrl);
    expect(prepared.profile.modelId).toBe("synthetic-compatible-model");
    resolveSecret.mockClear();
    for (const override of [
      { expectedManifestRevision: "stale" },
      { recipient: { ...input.recipient, recipientKey: "xiaomi-mimo" } },
      { profile: { ...fixtures.deepseek, providerId: fixtures.mimo.providerId } },
      { manifest: { ...manifest, bindings: [{ ...manifest.bindings[0], origin: "https://api.xiaomimimo.com" }] } },
    ]) expect(() => prepareProviderTransportV2({ ...input, ...override })).toThrow();
    expect(resolveSecret).not.toHaveBeenCalled();
  });
  it("rejects ambiguous or broadened deployment manifests", () => {
    expect(() => parseProviderBindingManifest({ ...manifest, bindings: [...manifest.bindings, ...manifest.bindings] })).toThrow();
    expect(() => parseProviderBindingManifest({ ...manifest, secret: "forbidden" })).toThrow();
  });
});
