import { cleanupAdminE2e } from "./admin-e2e-setup.mjs";
export default async function adminE2eGlobalTeardown() {
  await cleanupAdminE2e({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    secretKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
}
