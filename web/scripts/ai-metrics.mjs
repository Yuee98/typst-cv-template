// Read-only metrics through the current Admin API. Never query private tables.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const token = process.env.SUPABASE_ADMIN_ACCESS_TOKEN;
const environment = process.env.ADMIN_ENVIRONMENT?.toUpperCase();
if (!url || !key || !token || !["LOCAL", "PREVIEW", "PRODUCTION"].includes(environment)) throw new Error("Set Supabase URL, publishable key, Admin environment and a current Admin access token.");
const client = createClient(url, key, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
const { data: envelope, error } = await client.rpc("admin_read", { p_input: { contract_code: "cv_app_db_2", expected_environment: environment, section: "usage", kind: "analytics", days: 30 } });
if (error) throw new Error(`Metrics denied: ${error.code}`);
if (envelope?.context?.contract_code !== "cv_app_db_2" || envelope.context.environment !== environment || !envelope.data) throw new Error("Unexpected metrics contract or environment.");
const data = envelope.data;
// Only explicitly aggregated fields are printed, never entire request rows.
const allowed = ["day_basis", "quota_day_basis", "global_quota", "configurations"];
console.log(JSON.stringify(Object.fromEntries(allowed.filter(field => field in data).map(field => [field, data[field]])), null, 2));
