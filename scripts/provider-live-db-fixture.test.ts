import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLiveConfigurations, type LiveProviderConfiguration } from "./provider-live-db-fixture.ts";
const configuration: LiveProviderConfiguration = {
  name: "Local synthetic connection", displayName: "Local preview", recipientName: "Synthetic recipient", adapterId: 1, endpointUrl: "https://relay.example/responses", modelId: "test-model", credentialRef: "AI_PROVIDER_KEY_FIXTURE",
  price: { currency: "CNY", input_standard_nanos_per_million: "100", input_cache_read_nanos_per_million: "10", input_cache_write_nanos_per_million: "0", output_nanos_per_million: "100" }
};
test("live fixture accepts two independent suppliers using the same adapter", () => {
  assert.doesNotThrow(() => validateLiveConfigurations([configuration, { ...configuration, name: "Another supplier", endpointUrl: "https://second.example/responses" }]));
});
test("live fixture requires separate public names and actual recipients without an internal-name fallback", () => {
  for (const field of ["displayName", "recipientName"] as const) {
    for (const value of [undefined, "", " "]) assert.throws(() => validateLiveConfigurations([{ ...configuration, [field]: value } as unknown as LiveProviderConfiguration]));
  }
  assert.throws(() => validateLiveConfigurations([{ ...configuration, displayName: "x".repeat(201) }]));
  assert.throws(() => validateLiveConfigurations([{ ...configuration, recipientName: "x".repeat(501) }]));
});
test("live fixture rejects unrelated secrets and invalid targets without Docker or network", () => {
  for (const credentialRef of ["SUPABASE_SERVICE_ROLE_KEY", "AWS_SECRET_ACCESS_KEY", "AI_PROVIDER_KEY_"]) assert.throws(() => validateLiveConfigurations([{ ...configuration, credentialRef }]));
  for (const endpointUrl of ["http://relay.example/responses", "https://user:pass@relay.example/responses", "https://relay.example/responses?key=secret"]) assert.throws(() => validateLiveConfigurations([{ ...configuration, endpointUrl }]));
});
test("live fixture synthetic prices require all four canonical nonnegative bigint amounts", () => {
  for (const value of ["-1", "1.5", "01", "9223372036854775808"]) assert.throws(() => validateLiveConfigurations([{ ...configuration, price: { ...configuration.price, output_nanos_per_million: value } }]));
  assert.throws(() => validateLiveConfigurations([{ ...configuration, price: { ...configuration.price, input_cache_write_nanos_per_million: undefined } as unknown as LiveProviderConfiguration["price"] }]));
  assert.doesNotThrow(() => validateLiveConfigurations([{ ...configuration, price: { ...configuration.price, output_nanos_per_million: "9223372036854775807" } }]));
});
