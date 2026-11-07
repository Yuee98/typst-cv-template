import { z } from "zod";
export const ADMIN_SECTIONS = ["overview", "users", "providers", "profiles", "prices", "policies", "controls", "analytics", "audit"] as const;
export const adminSectionSchema = z.enum(ADMIN_SECTIONS);
export type AdminSection = z.infer<typeof adminSectionSchema>;
export const adminRecordSectionSchema = z.enum(["users", "providers", "profiles", "prices", "policies", "audit"]);
export type AdminRecordSection = z.infer<typeof adminRecordSectionSchema>;
export const adminEnvironmentSchema = z.enum(["local", "preview", "production"]);
export const decimalRevisionSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v => BigInt(v) <= BigInt("9223372036854775807"));
export const externalIdSchema = z.string().regex(/^(prv|prf|pfv|pcv|pol|plv|opt|lgb|lds|ldv|adm|op|val|rbk|evt|req)_[0-9A-HJKMNP-TV-Z]{12}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const code = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
const timestamp = z.string().datetime({
  offset: true
});
const json = z.record(z.string(), z.unknown());
const reason = z.string().trim().min(3).max(500);
export const clientWriteFields = {
  contract_code: z.literal("cv_app_db_1"),
  database_instance_id: z.string().uuid()
};
const base = {
  ...clientWriteFields,
  operation_key: z.string().uuid(),
  reason
};
const expected = {
  expected_revision: decimalRevisionSchema
};
const lifecycle = {
  external_id: externalIdSchema,
  expected_status: z.enum(["DRAFT", "PUBLISHED"]),
  config_digest: digest,
  ...expected
};
const component = z.enum(["INPUT_STANDARD", "INPUT_CACHE_READ", "INPUT_CACHE_WRITE", "OUTPUT"]);
const components = z.record(component, decimalRevisionSchema);
const optionalDefaults = z.strictObject({
  capability_code: code.nullable(),
  endpoint_url: z.string().url().max(512).nullable(),
  credential_ref: z.string().regex(/^AI_PROVIDER_KEY_[A-Z0-9_]+$/).nullable(),
  model_id: z.string().min(1).max(200).nullable()
});
export const adminMutationRequestSchema = z.discriminatedUnion("operation", [z.strictObject({
  operation: z.literal("admin_provider_update"),
  ...base,
  ...expected,
  external_id: externalIdSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000),
  defaults: optionalDefaults
}), z.strictObject({
  operation: z.literal("admin_profile_create"),
  ...base,
  provider_id: externalIdSchema,
  code,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000)
}), z.strictObject({
  operation: z.literal("admin_policy_create"),
  ...base,
  code,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000)
}), z.strictObject({
  operation: z.literal("admin_profile_version_create"),
  ...base,
  ...expected,
  profile_id: externalIdSchema,
  capability_code: code,
  endpoint_url: z.string().url().max(512),
  credential_ref: z.string().regex(/^AI_PROVIDER_KEY_[A-Z0-9_]+$/),
  model_id: z.string().min(1).max(200),
  adapter_config: json,
  disclosure_id: externalIdSchema
}), z.strictObject({
  operation: z.literal("admin_price_version_create"),
  ...base,
  ...expected,
  profile_version_id: externalIdSchema,
  lane_code: code,
  currency: z.string().regex(/^[A-Z]{3}$/),
  calculator_kind: code,
  parameters: json,
  valid_from: timestamp,
  valid_until: timestamp.nullable(),
  components
}), z.strictObject({
  operation: z.literal("admin_policy_version_create"),
  ...base,
  ...expected,
  policy_id: externalIdSchema,
  bundle_id: externalIdSchema,
  options: z.array(z.strictObject({
    key: code,
    profile_version_id: externalIdSchema,
    price_lane_code: code,
    display_order: z.number().int().nonnegative()
  })).min(1).max(32),
  rules: z.array(z.strictObject({
    ordinal: z.number().int().nonnegative(),
    is_fallback: z.boolean(),
    weekday: z.number().int().min(1).max(7).nullable(),
    start_minute: z.number().int().min(0).max(1439).nullable(),
    end_minute: z.number().int().min(1).max(1440).nullable(),
    option_keys: z.array(code).min(1).max(32),
    default_option_key: code
  })).min(1).max(128)
}), ...(["admin_profile_version_publish", "admin_price_version_publish", "admin_policy_version_publish"] as const).map(operation => z.strictObject({
  operation: z.literal(operation),
  ...base,
  ...lifecycle,
  validation_id: externalIdSchema
})), ...(["admin_profile_version_retire", "admin_price_version_retire", "admin_policy_version_retire"] as const).map(operation => z.strictObject({
  operation: z.literal(operation),
  ...base,
  ...lifecycle
})), ...(["admin_profile_retire", "admin_policy_retire"] as const).map(operation => z.strictObject({
  operation: z.literal(operation),
  ...base,
  ...expected,
  external_id: externalIdSchema
})), z.strictObject({
  operation: z.literal("admin_price_version_close"),
  ...base,
  ...lifecycle
}), z.strictObject({
  operation: z.literal("admin_price_version_replace"),
  ...base,
  ...lifecycle,
  currency: z.string().regex(/^[A-Z]{3}$/),
  lane_code: code,
  calculator_kind: code,
  parameters: json,
  components,
  validation_id: externalIdSchema
}), z.strictObject({
  operation: z.literal("admin_ai_disable"),
  ...base,
  ...expected
}), z.strictObject({
  operation: z.literal("admin_ai_set_policy"),
  ...base,
  ...expected,
  policy_version_id: externalIdSchema.nullable(),
  validation_id: externalIdSchema
}), z.strictObject({
  operation: z.literal("admin_ai_reopen"),
  ...base,
  ...expected,
  readback_id: externalIdSchema
}), z.strictObject({
  operation: z.literal("admin_ai_update_limits"),
  ...base,
  ...expected,
  user_daily_limit: decimalRevisionSchema,
  global_daily_limit: decimalRevisionSchema,
  user_minute_limit: decimalRevisionSchema
}), z.strictObject({
  operation: z.literal("admin_ai_set_audience"),
  ...base,
  ...expected,
  audience: z.enum(["ALLOWLIST", "ALL"])
}), z.strictObject({
  operation: z.literal("admin_ai_set_allowed_user"),
  ...base,
  ...expected,
  auth_user_id: z.string().uuid(),
  allowed: z.boolean()
}), ...(["admin_member_grant", "admin_member_revoke"] as const).map(operation => z.strictObject({
  operation: z.literal(operation),
  ...base,
  auth_user_id: z.string().uuid(),
  ...expected
}))]);
export type AdminMutationRequest = z.infer<typeof adminMutationRequestSchema>;
export const adminValidationRequestSchema = z.strictObject({
  operation: z.literal("validate"),
  ...clientWriteFields,
  target_kind: z.enum(["PROFILE", "PRICE", "POLICY"]),
  target_id: externalIdSchema
});
export const adminRuntimeReadbackRequestSchema = z.strictObject({
  operation: z.literal("readback"),
  ...clientWriteFields
});
export const adminControlStateSchema = z.strictObject({
  enabled: z.boolean(),
  active_policy_version_id: externalIdSchema.nullable(),
  audience: z.enum(["ALLOWLIST", "ALL"]),
  generation: decimalRevisionSchema,
  close_cycle: decimalRevisionSchema,
  revision: decimalRevisionSchema,
  user_daily_limit: decimalRevisionSchema,
  global_daily_limit: decimalRevisionSchema,
  user_minute_limit: decimalRevisionSchema
});
export type AdminControlState = z.infer<typeof adminControlStateSchema>;
export const adminContextSchema = z.strictObject({
  ready: z.literal(true),
  capabilities: z.array(z.string()),
  environment: z.enum(["LOCAL", "PREVIEW", "PRODUCTION"]),
  database_instance_id: z.string().uuid(),
  contract_code: z.literal("cv_app_db_1"),
  member_id: externalIdSchema,
  aal: z.enum(["aal1", "aal2"]),
  control: adminControlStateSchema
});
export type AdminContext = z.infer<typeof adminContextSchema>;
export const adminReadResponseSchema = z.strictObject({
  context: adminContextSchema,
  data: json.nullable()
});
export type AdminReadResponse = z.infer<typeof adminReadResponseSchema>;
export const adminRecordSchema = z.record(z.string(), z.unknown());
export const adminPageSchema = z.strictObject({
  records: z.array(adminRecordSchema).max(100),
  next_cursor: z.string().max(200).nullable()
});
export type AdminPage = z.infer<typeof adminPageSchema>;
export type AdminRecord = z.infer<typeof adminRecordSchema>;
export const adminCommittedOperationSchema = z.strictObject({
  operation_id: externalIdSchema,
  operation: z.string(),
  result: json,
  audit_id: externalIdSchema,
  time_committed: timestamp
});
export type AdminCommittedOperation = z.infer<typeof adminCommittedOperationSchema>;
export const adminValidationReportSchema = z.strictObject({
  external_id: externalIdSchema,
  target_kind: z.enum(["PROFILE", "PRICE", "POLICY"]),
  target_id: externalIdSchema,
  dependency_digest: digest,
  passed: z.boolean(),
  reasons: z.array(code).max(64),
  time_checked: timestamp,
  time_expires: timestamp
});
export type AdminValidationReport = z.infer<typeof adminValidationReportSchema>;
export const adminRuntimeReadbackSchema = z.strictObject({
  external_id: externalIdSchema,
  policy_version_id: externalIdSchema,
  dependency_digest: digest,
  passed: z.boolean(),
  reasons: z.array(code).max(64),
  time_checked: timestamp,
  time_expires: timestamp
});
export type AdminRuntimeReadback = z.infer<typeof adminRuntimeReadbackSchema>;
export const adminAnalyticsSchema = z.record(z.string(), z.unknown());
export type AdminAnalytics = z.infer<typeof adminAnalyticsSchema>;
export const ADMIN_ERROR_CODES = ["UNAUTHORIZED", "FORBIDDEN", "INVALID_REQUEST", "NOT_FOUND", "CONFLICT", "STEP_UP_REQUIRED", "NOT_READY", "UNAVAILABLE", "CLIENT_UPDATE_REQUIRED", "INTERNAL_ERROR", "RATE_LIMITED", "QUOTA_EXCEEDED"] as const;
export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[number];
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
  STEP_UP_REQUIRED: 403,
  NOT_READY: 409,
  UNAVAILABLE: 503,
  CLIENT_UPDATE_REQUIRED: 409,
  INTERNAL_ERROR: 500,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429
};
