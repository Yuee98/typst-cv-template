import { setupAdminE2e } from "./admin-e2e-setup.mjs";
export default async function adminE2eGlobalSetup() {
  await setupAdminE2e({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    secretKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
}
