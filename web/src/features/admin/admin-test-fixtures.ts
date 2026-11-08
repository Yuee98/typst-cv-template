import type { AdminConfiguration, AdminContext } from "@/lib/admin/contract";
export const adminContextFixture = (instance = "00000000-0000-4000-8000-000000000001"): AdminContext => ({
  ready: true,
  capabilities: {
    cv_schema_version: 7,
    encrypted_envelope_version: 1
  },
  environment: "LOCAL",
  database_instance_id: instance,
  contract_code: "cv_app_db_2",
  member_id: "1",
  control: {
    enabled: false,
    audience: "ALLOWLIST",
    revision: "1",
    user_daily_limit: "20",
    global_daily_limit: "2000",
    user_minute_limit: "3"
  }
});
export const configurationFixture = (): AdminConfiguration => ({
  id: "1",
  revision: "1",
  name: "Current configuration",
  display_name: "Public service name",
  adapter_id: 1,
  endpoint_url: "https://api.example.test/responses",
  model_id: "model-a",
  credential_ref: "AI_PROVIDER_KEY_TEST",
  legal_document_id: "3",
  enabled: false,
  price: {
    currency: "USD",
    input_standard_nanos_per_million: "1000000000",
    input_cache_read_nanos_per_million: "0",
    input_cache_write_nanos_per_million: "0",
    output_nanos_per_million: "2000000000"
  }
});
