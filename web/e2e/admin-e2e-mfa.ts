import { createClient } from "@supabase/supabase-js";
/** A failed test must not leave a verified factor blocking the next enrollment. */
export async function resetAdminFixtureMfa({ url, secretKey }: { url: string | undefined; secretKey: string | undefined }) {
  if (url !== "http://127.0.0.1:54321" || !secretKey) throw new Error("Admin fixture MFA cleanup requires local Supabase");
  const service = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await service.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  const user = data.users.find(user => user.email === "admin-e2e-admin@example.test");
  if (!user) return;
  const factors = await service.auth.admin.mfa.listFactors({ userId: user.id });
  if (factors.error) throw factors.error;
  for (const factor of factors.data.factors) {
    const { error } = await service.auth.admin.mfa.deleteFactor({ userId: user.id, id: factor.id });
    if (error) throw error;
  }
}
