// Read-only metrics through the current Admin API. Never query private tables.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const token = process.env.SUPABASE_ADMIN_ACCESS_TOKEN;
if (!url || !key || !token) throw new Error("Set Supabase URL, publishable key and a current Admin access token.");
const client = createClient(url, key, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
const { data, error } = await client.rpc("admin_analytics", { p_days: 30 });
if (error) throw new Error(`Metrics denied: ${error.code}`);
// Only explicitly aggregated fields are printed, never entire request rows.
const allowed = ["days", "global", "profiles"];
console.log(JSON.stringify(Object.fromEntries(allowed.filter(field => field in data).map(field => [field, data[field]])), null, 2));
