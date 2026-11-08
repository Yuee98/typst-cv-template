import { z } from "zod";
import { legalDisplaySchema } from "@/lib/legal/legal-display";
import { polishAvailabilitySchema, polishDatabaseIdSchema } from "@/lib/polish/contract";
import type { AiDatabase } from "./database";
import { validateExecutionConfiguration, executionConfigurationSchema } from "./provider";

const rawSchema = z.strictObject({
  contract_code: z.literal("cv_app_db_2"), database_instance_id: z.uuid(),
  enabled: z.boolean(), reason: z.string().nullable(),
  control_revision: polishDatabaseIdSchema,
  default_config_id: polishDatabaseIdSchema.nullable(), quota: z.unknown(),
  configurations: z.array(z.strictObject({
    config_id: polishDatabaseIdSchema, name: z.string().min(1), revision: polishDatabaseIdSchema,
    ...executionConfigurationSchema.shape,
    eligible: z.boolean(), reason: z.string().nullable(), consent_required: z.boolean(),
    legal_display: legalDisplaySchema
  }))
});
/** Credentials stay server-side. Public recipient facts remain in the exact legal document. */
export async function readAvailability(db: AiDatabase, userId: string, instance: string, env: Readonly<Record<string, string | undefined>> = process.env, checkProviders = true) {
  const raw = rawSchema.parse(await db.call("ai_availability", {
    contract_code: "cv_app_db_2", owner_auth_user_id: userId, database_instance_id: instance
  }));
  return polishAvailabilitySchema.parse({
    enabled: raw.enabled && raw.reason === null,
    contract: raw.contract_code, databaseInstanceId: raw.database_instance_id,
    controlRevision: raw.control_revision, defaultConfigId: raw.default_config_id, reason: raw.reason,
    configurations: raw.configurations.map(configuration => {
      let status: "READY" | "CONSENT_REQUIRED" | "UNAVAILABLE" = !configuration.eligible ? "UNAVAILABLE" : configuration.consent_required ? "CONSENT_REQUIRED" : "READY";
      let reason = configuration.reason;
      try {
        if (checkProviders) validateExecutionConfiguration(Object.fromEntries(Object.keys(executionConfigurationSchema.shape).map(key => [key, configuration[key as keyof typeof configuration]])), env);
        const legal = configuration.legal_display.provider;
        if (legal.adapter_id !== configuration.adapter_id || legal.endpoint_url !== configuration.endpoint_url || legal.model_id !== configuration.model_id || !legal.enabled || !configuration.legal_display.common.enabled) throw new Error("Legal scope does not match configuration");
      } catch {
        status = "UNAVAILABLE";
        reason = "EXECUTION_CONFIG_UNAVAILABLE";
      }
      return {
        configId: configuration.config_id, configRevision: configuration.revision,
        name: configuration.name, modelId: configuration.model_id,
        status, reason, legalDisplay: configuration.legal_display
      };
    })
  });
}
