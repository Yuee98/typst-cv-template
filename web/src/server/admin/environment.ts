import "server-only";
import { adminEnvironmentSchema } from "@/lib/admin/contract";

export interface AdminEnvironment {
  name: "local" | "preview" | "production";
  projectRef: string;
  supabaseUrl: string;
  publishableKey: string;
}

export function resolveAdminEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): AdminEnvironment {
  const name = adminEnvironmentSchema.parse(env.ADMIN_ENVIRONMENT);
  if (
    env.VERCEL === "1" &&
    env.VERCEL_ENV !== (name === "local" ? "development" : name)
  ) {
    throw new Error("Admin deployment/environment mismatch");
  }
  const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (
    !publishableKey ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  ) {
    throw new Error("Invalid admin environment");
  }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  const hosted = /^([a-z0-9-]+)\.supabase\.co$/.exec(url.hostname);
  if (
    name === "local"
      ? !local || url.protocol !== "http:" || url.port !== "54321"
      : !hosted || url.protocol !== "https:" || Boolean(url.port)
  ) {
    throw new Error("Admin project/environment mismatch");
  }
  return {
    name,
    projectRef: local ? "local" : hosted![1],
    supabaseUrl: url.origin,
    publishableKey,
  };
}
