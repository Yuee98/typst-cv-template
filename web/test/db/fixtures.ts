import { execFileSync } from "node:child_process";
import { createProviderLiveDbFixture, type LiveProviderConfiguration } from "../../../scripts/provider-live-db-fixture";
export const configurations: LiveProviderConfiguration[] = [1, 2, 3].map(index => ({
  adapterId: index as 1 | 2 | 3,
  name: `Synthetic adapter ${index}`,
  displayName: `Visible choice ${index}`,
  recipientName: `Synthetic recipient ${index}`,
  endpointUrl: ["https://api.deepseek.com/responses", "https://api.xiaomimimo.com/v1/responses", "https://generativelanguage.googleapis.com/v1/interactions"][index - 1],
  modelId: `synthetic-model-${index}`,
  credentialRef: `AI_PROVIDER_KEY_FIXTURE_${index}`,
  price: { currency: index === 3 ? "USD" : "CNY", input_standard_nanos_per_million: "1000000", input_cache_read_nanos_per_million: "100000", input_cache_write_nanos_per_million: "0", output_nanos_per_million: "2000000" }
}));
export function ensureLocalBootstrap() {
  execFileSync("docker", ["exec", "-i", "supabase_db_typst-cv-template", "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { input: "do $$begin if not exists(select 1 from admin.environment) then insert into auth.users(id,email,email_confirmed_at) values('00000000-0000-4000-8000-000000000092','db-bootstrap@example.invalid',clock_timestamp()) on conflict(id) do nothing;perform admin.initialize('LOCAL','00000000-0000-4000-8000-000000000092');end if;end $$;", stdio: ["pipe", "pipe", "pipe"] });
}
export async function withFixture<T>(run: (fixture: Awaited<ReturnType<typeof createProviderLiveDbFixture>>) => Promise<T>): Promise<T> {
  ensureLocalBootstrap();
  const fixture = await createProviderLiveDbFixture();
  try { await fixture.configure(configurations); return await run(fixture); }
  finally { await fixture.dispose(); }
}
