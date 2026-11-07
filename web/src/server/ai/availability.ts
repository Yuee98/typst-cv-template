import { z } from "zod";
import { legalDisplaySchema } from "@/lib/legal/legal-display";
import { polishAvailabilitySchema } from "@/lib/polish/contract";
import type { AiDatabase } from "./database";
import { validateProviderConfiguration, providerProfileSchema } from "./provider";
import { AiError } from "./errors";
const option = z.object({
  option_id: z.string(),
  profile_version_id: z.string(),
  provider_id: z.string(),
  provider_code: z.string(),
  provider_name: z.string(),
  model_id: z.string(),
  disclosure_id: z.string(),
  content_digest: z.string(),
  bundle_id: z.string(),
  manifest_digest: z.string(),
  recipient_code: z.string(),
  content: z.object({
    zh: z.unknown(),
    en: z.unknown()
  }),
  status: z.enum(["READY", "CONSENT_REQUIRED", "UNAVAILABLE"]),
  reason: z.string().nullable(),
  runtime_profile: z.unknown()
});
const rawSchema = z.object({
  generation: z.string(),
  policy_version_id: z.string().nullable(),
  rule_ordinal: z.number().nullable(),
  options: z.array(option),
  default_option_id: z.string().nullable(),
  observed_at: z.string(),
  next_change_at: z.string().nullable(),
  enabled: z.boolean(),
  reason: z.string().nullable(),
  database_instance_id: z.string(),
  contract_code: z.literal("cv_app_db_1")
});
/** Only this projection crosses the browser boundary; credentials and endpoints stay server-side. */
export async function readAvailability(db: AiDatabase, userId: string, instance: string, env: Readonly<Record<string, string | undefined>> = process.env, checkProviders = true) {
  const common = {
    contract_code: "cv_app_db_1",
    owner_auth_user_id: userId,
    database_instance_id: instance
  };
  for (let read = 0; read < 2; read++) {
    const raw = rawSchema.parse(await db.call("ai_availability", common));
    const options = raw.options.map(option => {
      let status = option.status,
        reason = option.reason;
      try {
        if (checkProviders) validateProviderConfiguration(Object.fromEntries(Object.keys(providerProfileSchema.shape).map(key => [key, z.record(z.string(), z.unknown()).parse(option.runtime_profile)[key]])), env);
      } catch {
        status = "UNAVAILABLE";
        reason = "EXECUTION_CONFIG_UNAVAILABLE";
      }
      return {
        optionId: option.option_id,
        profileVersionId: option.profile_version_id,
        providerName: option.provider_name,
        modelName: option.model_id,
        status,
        reason,
        legalDisplay: legalDisplaySchema.parse({
          contract: "cv_app_db_1",
          disclosureId: option.disclosure_id,
          bundleId: option.bundle_id,
          manifestDigest: option.manifest_digest,
          providerId: option.provider_id,
          recipientCode: option.recipient_code,
          modelId: option.model_id,
          contentDigest: option.content_digest,
          zh: option.content.zh,
          en: option.content.en
        })
      };
    });
    const confirm = rawSchema.parse(await db.call("ai_availability", common));
    if (confirm.generation !== raw.generation || confirm.rule_ordinal !== raw.rule_ordinal) continue;
    return polishAvailabilitySchema.parse({
      enabled: raw.enabled && raw.reason === null,
      contract: raw.contract_code,
      databaseInstanceId: raw.database_instance_id,
      configGeneration: raw.generation,
      policyVersionId: raw.policy_version_id,
      ruleOrdinal: raw.rule_ordinal,
      options,
      defaultOptionId: raw.default_option_id,
      observedAt: raw.observed_at,
      nextChangeAt: raw.next_change_at,
      reason: raw.reason
    });
  }
  throw new AiError("CONFLICT", "CONFIG_CHANGED");
}
