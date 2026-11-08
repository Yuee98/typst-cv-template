import { fixtureConfigurationFacts, fixtureLegalDisplay } from "@/lib/polish/fixtures";
import { ADAPTERS } from "./provider";
/** Synthetic local/CI facts; never hosted configuration or secrets. */
export const fixtureId = (prefix: string, n: number) => `${prefix}_${String(n).padStart(12, "0")}`;
export const fixtureInstance = "10000000-0000-4000-8000-000000000001";
export function fixtureExecutionConfiguration(index = 1) {
  const adapterId = index as 1 | 2 | 3;
  return {
    adapter_id: adapterId, execution_contract: ADAPTERS[adapterId].executionContract,
    endpoint_url: fixtureConfigurationFacts[index - 1].endpoint,
    credential_ref: `AI_PROVIDER_KEY_FIXTURE_${index}`,
    model_id: `fixture-model-${index}`
  };
}
export const fixturePrice = {
  currency: "CNY", input_standard_nanos_per_million: "100", input_cache_read_nanos_per_million: "10",
  input_cache_write_nanos_per_million: "0", output_nanos_per_million: "100"
};
export function fixtureConfiguration(index = 1) {
  return {
    config_id: String(index), name: fixtureConfigurationFacts[index - 1].name, revision: "1",
    ...fixtureExecutionConfiguration(index), eligible: true, reason: null, consent_required: false,
    legal_display: fixtureLegalDisplay(index)
  };
}
