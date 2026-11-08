import { z } from "zod";
import { legalDocumentSchema, legalIdSchema } from "@/lib/legal/legal-display";
export const ADMIN_SECTIONS = ["configurations", "rules", "controls", "usage", "users", "audit"] as const;
export const adminSectionSchema = z.enum(ADMIN_SECTIONS);
export type AdminSection = z.infer<typeof adminSectionSchema>;
export const adminEnvironmentSchema = z.enum(["local", "preview", "production"]);
export const decimalRevisionSchema = legalIdSchema;
export const decimalValueSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v => /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= BigInt("9223372036854775807"));
export const entityIdSchema = legalIdSchema;
export const adapterIdSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const clientWriteFields = {
  contract_code: z.literal("cv_app_db_2"),
  database_instance_id: z.uuid()
};
const base = {
  ...clientWriteFields,
  operation_key: z.uuid(),
  reason: z.string().trim().min(3).max(500)
};
const entity = {
  id: entityIdSchema.nullable(),
  expected_revision: decimalRevisionSchema.nullable()
};
export const adminPriceSchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  input_standard_nanos_per_million: decimalValueSchema,
  input_cache_read_nanos_per_million: decimalValueSchema,
  input_cache_write_nanos_per_million: decimalValueSchema,
  output_nanos_per_million: decimalValueSchema
});
export const configurationFields = {
  name: z.string().trim().min(1).max(200),
  adapter_id: adapterIdSchema,
  endpoint_url: z.string().url().max(2048).refine(value => {
    try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
  }),
  model_id: z.string().trim().min(1).max(200),
  credential_ref: z.string().regex(/^AI_PROVIDER_KEY_[A-Z0-9_]+$/),
  legal_document_id: entityIdSchema,
  enabled: z.boolean(),
  price: adminPriceSchema
};
export const adminConfigurationSchema = z.strictObject({
  id: entityIdSchema,
  revision: decimalRevisionSchema,
  ...configurationFields
});
export type AdminConfiguration = z.infer<typeof adminConfigurationSchema>;
export const ruleFields = {
  weekday: z.number().int().min(1).max(7).nullable(),
  start_minute: z.number().int().min(0).max(1439).nullable(),
  end_minute: z.number().int().min(1).max(1440).nullable(),
  enabled: z.boolean(),
  members: z.array(z.strictObject({
    config_id: entityIdSchema,
    is_default: z.boolean()
  })).min(1).max(32)
};
function validRule(rule: z.infer<typeof adminRuleShape>) {
  return (rule.weekday === null && rule.start_minute === null && rule.end_minute === null || rule.weekday !== null && rule.start_minute !== null && rule.end_minute !== null && rule.start_minute < rule.end_minute) && rule.members.filter(member => member.is_default).length === 1 && new Set(rule.members.map(member => member.config_id)).size === rule.members.length;
}
const adminRuleShape = z.strictObject({
  id: entityIdSchema,
  revision: decimalRevisionSchema,
  ...ruleFields
});
export const adminRuleSchema = adminRuleShape.refine(validRule, "Choose one default and a valid Asia/Shanghai period");
export type AdminRule = z.infer<typeof adminRuleSchema>;
export const controlFields = {
  enabled: z.boolean(),
  audience: z.enum(["ALLOWLIST", "ALL"]),
  user_daily_limit: decimalValueSchema,
  global_daily_limit: decimalValueSchema,
  user_minute_limit: decimalValueSchema
};
export const adminControlStateSchema = z.strictObject({
  revision: decimalRevisionSchema,
  ...controlFields
});
export type AdminControlState = z.infer<typeof adminControlStateSchema>;
export const adminContextSchema = z.strictObject({
  ready: z.literal(true),
  contract_code: z.literal("cv_app_db_2"),
  database_instance_id: z.uuid(),
  environment: z.enum(["LOCAL", "PREVIEW", "PRODUCTION"]),
  member_id: entityIdSchema,
  control: adminControlStateSchema,
  capabilities: z.strictObject({
    cv_schema_version: z.literal(7),
    encrypted_envelope_version: z.literal(1)
  })
});
export type AdminContext = z.infer<typeof adminContextSchema>;
export const adminMutationRequestSchema = z.discriminatedUnion("operation", [z.strictObject({
  operation: z.literal("admin_configuration_save"),
  ...base,
  ...entity,
  ...configurationFields
}).refine(v => v.id === null === (v.expected_revision === null)), z.strictObject({
  operation: z.literal("admin_rule_save"),
  ...base,
  ...entity,
  ...ruleFields
}).refine(v => v.id === null === (v.expected_revision === null) && validRule({
  ...v,
  id: v.id ?? "1",
  revision: v.expected_revision ?? "1"
})), z.strictObject({
  operation: z.literal("admin_ai_update"),
  ...base,
  expected_revision: decimalRevisionSchema,
  ...controlFields
}), z.strictObject({
  operation: z.literal("admin_ai_disable"),
  ...base,
  expected_revision: decimalRevisionSchema
}), z.strictObject({
  operation: z.literal("admin_allowed_user_set"),
  ...base,
  expected_revision: decimalRevisionSchema,
  auth_user_id: z.uuid(),
  allowed: z.boolean()
}), z.strictObject({
  operation: z.literal("admin_member_grant"),
  ...base,
  expected_revision: decimalRevisionSchema.nullable(),
  auth_user_id: z.uuid()
}), z.strictObject({
  operation: z.literal("admin_member_revoke"),
  ...base,
  expected_revision: decimalRevisionSchema,
  id: entityIdSchema
})]);
export type AdminMutationRequest = z.infer<typeof adminMutationRequestSchema>;
export const adminCommittedOperationSchema = z.strictObject({
  operation_id: entityIdSchema,
  operation: z.string().min(1),
  entity_kind: z.string().min(1),
  entity_id: entityIdSchema,
  revision: decimalRevisionSchema,
  time_committed: z.string().datetime({
    offset: true
  })
});
export type AdminCommittedOperation = z.infer<typeof adminCommittedOperationSchema>;
export const adminRecordSchema = z.record(z.string(), z.unknown());
export type AdminRecord = z.infer<typeof adminRecordSchema>;
export const adminPageSchema = z.strictObject({
  records: z.array(adminRecordSchema).max(100),
  next_cursor: z.string().max(500).nullable()
});
export type AdminPage = z.infer<typeof adminPageSchema>;
export const adminAnalyticsSchema = z.strictObject({
  day_basis: z.literal("UTC_RESERVE_DAY"),
  quota_day_basis: z.literal("UTC_PROVIDER_ADMISSION_DAY"),
  global_quota: z.array(adminRecordSchema),
  configurations: z.array(adminRecordSchema)
});
export const adminReadResponseSchema = z.strictObject({
  context: adminContextSchema,
  data: z.unknown()
});
export const adminAdapterSchema = z.strictObject({
  id: adapterIdSchema,
  name: z.string().min(1)
});
export const adminDocumentSchema = legalDocumentSchema;
export const ADMIN_ERROR_CODES = ["UNAUTHORIZED", "FORBIDDEN", "INVALID_REQUEST", "NOT_FOUND", "CONFLICT", "NOT_READY", "UNAVAILABLE", "CLIENT_UPDATE_REQUIRED", "INTERNAL_ERROR", "RATE_LIMITED", "QUOTA_EXCEEDED"] as const;
export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[number];
export const adminConfigurationErrorReasonSchema = z.enum(["CREDENTIAL_UNAVAILABLE", "ENDPOINT_INVALID", "ENDPOINT_UNREACHABLE"]);
export type AdminConfigurationErrorReason = z.infer<typeof adminConfigurationErrorReasonSchema>;
export const adminErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(ADMIN_ERROR_CODES),
    reason: z.string().optional()
  })
});
export const ADMIN_ERROR_STATUS: Record<AdminErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  NOT_READY: 409,
  UNAVAILABLE: 503,
  CLIENT_UPDATE_REQUIRED: 409,
  INTERNAL_ERROR: 500,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429
};
