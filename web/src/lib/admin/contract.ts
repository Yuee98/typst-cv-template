import { z } from "zod";

export const ADMIN_SECTIONS = [
  "overview",
  "users",
  "profiles",
  "prices",
  "policies",
  "audit",
] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];
export const adminSectionSchema = z.enum(ADMIN_SECTIONS);
export const adminRecordSectionSchema = z.enum([
  "users",
  "profiles",
  "prices",
  "policies",
  "audit",
]);
export type AdminRecordSection = z.infer<typeof adminRecordSectionSchema>;
export const adminEnvironmentSchema = z.enum([
  "local",
  "preview",
  "production",
]);
export const decimalRevisionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => value.length < 19 || value <= "9223372036854775807");
const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const codeId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,199}$/);

export const adminContextSchema = z.strictObject({
  schemaVersion: z.literal("admin_context_v1"),
  actor: z.strictObject({
    userId: uuid,
    email: z.string().nullable(),
    revision: decimalRevisionSchema,
  }),
  environment: z.strictObject({
    name: adminEnvironmentSchema,
    projectRef: z.string().min(1).max(100),
    controlPlaneMode: z.enum(["legacy", "jwt_v1"]),
    revision: decimalRevisionSchema,
  }),
  features: z.strictObject({
    aiEnabled: z.boolean(),
    globalDailyLimit: z.number().int().nonnegative(),
    allowlistedUsers: z.number().int().nonnegative(),
    configGeneration: decimalRevisionSchema,
    activePolicyVersionId: uuid.nullable(),
    currentLegalBundle: codeId,
  }),
  capabilities: z.strictObject({ writes: z.boolean() }),
});
export type AdminContext = z.infer<typeof adminContextSchema>;

export const adminWriteAuthoritySchema = z.strictObject({
  schemaVersion: z.literal("admin_write_authority_v1"),
  actorUserId: uuid,
  writesEnabled: z.boolean(),
  recentTotp: z.boolean(),
});
export type AdminWriteAuthority = z.infer<typeof adminWriteAuthoritySchema>;

const safeMutationResultSchema = z.discriminatedUnion("schemaVersion", [
  z.strictObject({
    schemaVersion: z.literal("admin_ai_control_result_v1"),
    aiEnabled: z.boolean(),
    controlRevision: decimalRevisionSchema,
    closingCycleId: uuid.nullable(),
    configGeneration: decimalRevisionSchema,
    activePolicyVersionId: uuid.nullable(),
    globalDailyLimit: z.number().int().nonnegative().optional(),
    lifecycleAuditId: uuid.optional(),
    validationReportIds: z.array(uuid).min(1).max(32).optional(),
    readbackReportId: uuid.optional(),
  }),
  z.strictObject({
    schemaVersion: z.literal("admin_membership_result_v1"),
    userId: uuid,
    enabled: z.boolean(),
    revision: decimalRevisionSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal("admin_provider_result_v1"),
    providerId: uuid,
    revision: decimalRevisionSchema,
    archived: z.boolean(),
  }),
  z.strictObject({
    schemaVersion: z.literal("admin_profile_identity_result_v1"),
    profileId: uuid,
    profileKey: codeId,
    providerId: uuid,
    retired: z.boolean().optional(),
    lifecycleAuditId: uuid.optional(),
    validationReportId: uuid.optional(),
  }),
  z.strictObject({
    schemaVersion: z.literal("admin_profile_version_result_v1"),
    profileVersionId: uuid,
    profileId: uuid,
    version: z.number().int().positive(),
    status: z.enum(["draft", "validated", "canary", "active", "retired"]),
    configSha256: z.string().regex(/^[0-9a-f]{64}$/),
    lifecycleAuditId: uuid.optional(),
    validationReportId: uuid.optional(),
  }),
  z.strictObject({
    schemaVersion: z.literal("admin_price_version_result_v1"),
    priceVersionId: uuid,
    profileVersionId: uuid,
    pricingLane: codeId,
    version: z.number().int().positive(),
    sealed: z.boolean(),
    validTo: timestamp.nullable().optional(),
    lifecycleAuditId: uuid.optional(),
    validationReportId: uuid.optional(),
    reviewedDeploymentId: uuid.optional(),
  }),
  z.strictObject({
    schemaVersion: z.literal("admin_routing_policy_result_v1"),
    policyVersionId: uuid,
    policyKey: codeId,
    version: z.number().int().positive(),
    status: z.enum(["draft", "validated", "canary", "active", "retired"]),
    configSha256: z.string().regex(/^[0-9a-f]{64}$/),
    lifecycleAuditId: uuid,
    validationReportIds: z.array(uuid).min(1).max(32),
  }),
]);

export const adminCommittedOperationSchema = z.strictObject({
  schemaVersion: z.literal("admin_committed_operation_v1"),
  operationId: uuid,
  operationKind: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
  idempotencyKey: uuid,
  result: safeMutationResultSchema,
  auditId: uuid,
  committedAt: timestamp,
});
export type AdminCommittedOperation = z.infer<
  typeof adminCommittedOperationSchema
>;

export const adminValidationRequestSchema = z.strictObject({
  operation: z.literal("validate_runtime_target"),
  reviewedDeploymentId: uuid,
  runtimeContractId: codeId,
  runtimeTargetId: codeId,
});
export type AdminValidationRequest = z.infer<
  typeof adminValidationRequestSchema
>;

export const adminValidationReportSchema = z.strictObject({
  schemaVersion: z.literal("admin_validation_report_v1"),
  reportId: uuid,
  reviewedDeploymentId: uuid,
  environment: adminEnvironmentSchema,
  projectRef: z.string().min(1).max(100),
  runtimeBuildId: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,199}$/),
  bindingManifestRevision: codeId,
  bindingManifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  runtimeContractId: codeId,
  runtimeTargetId: codeId,
  runtimeTargetSha256: z.string().regex(/^[0-9a-f]{64}$/),
  profileVersionId: uuid,
  priceVersionId: uuid,
  providerId: uuid,
  codeCapabilityId: codeId,
  codeCapabilitySha256: z.string().regex(/^[0-9a-f]{64}$/),
  legalBundleVersion: codeId,
  legalManifestId: codeId,
  displayDisclosureKey: codeId,
  checks: z.strictObject({
    endpointPolicy: z.boolean(),
    manifestBinding: z.boolean(),
    credentialConfigured: z.boolean(),
    compiledCapability: z.boolean(),
    databaseBinding: z.boolean(),
  }),
  passed: z.boolean(),
  evidenceIds: z.array(codeId).min(1).max(96).refine(
    (values) => new Set(values).size === values.length,
    "evidence IDs must be unique",
  ),
  checkedAt: timestamp,
  expiresAt: timestamp,
  reportSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).superRefine((value, context) => {
  if (value.passed !== Object.values(value.checks).every(Boolean)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["passed"],
      message: "passed does not match checks",
    });
  }
  const checkedAt = Date.parse(value.checkedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (expiresAt <= checkedAt || expiresAt - checkedAt > 10 * 60_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "invalid report validity window",
    });
  }
});
export type AdminValidationReport = z.infer<
  typeof adminValidationReportSchema
>;

const mutationReason = z.string().refine((value) => value === value.trim(), "reason must be trimmed").min(1).max(500);
const idempotencyKey = uuid;
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ids = z.array(uuid).min(1).max(96).refine((values) => new Set(values).size === values.length, "IDs must be unique");
const policyIds = z.array(uuid).min(1).max(32).refine((values) => new Set(values).size === values.length, "IDs must be unique");
const codeText = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,199}$/);
const jsonObject = z.record(z.string(), z.unknown());
const mutationBase = {
  reason: mutationReason,
  idempotencyKey,
};

export const adminMutationRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("disable_ai"), ...mutationBase, expectedControlRevision: revision }),
  z.strictObject({ operation: z.literal("pointer_set"), ...mutationBase, policyVersionId: uuid, validationReportIds: ids, expectedControlRevision: revision, expectedPolicyVersionId: uuid.nullable(), expectedConfigGeneration: revision }),
  z.strictObject({ operation: z.literal("pointer_clear"), ...mutationBase, validationReportIds: ids, expectedControlRevision: revision, expectedPolicyVersionId: uuid, expectedConfigGeneration: revision }),
  z.strictObject({ operation: z.literal("reopen"), ...mutationBase, readbackReportId: uuid, expectedClosingCycleId: uuid, expectedControlRevision: revision, expectedPolicyVersionId: uuid.nullable(), expectedConfigGeneration: revision }),
  z.strictObject({ operation: z.literal("membership_set"), ...mutationBase, targetUserId: uuid, enabled: z.boolean(), expectedRevision: revision }),
  z.strictObject({ operation: z.literal("provider_defaults_update"), ...mutationBase, providerId: uuid, displayName: z.string().trim().min(1).max(200), defaultAdapterId: codeText, defaultEndpointUrl: z.string().url().max(512), defaultCredentialEnvName: z.string().regex(/^AI_PROVIDER_KEY_[A-Z0-9_]{1,160}$/), defaultModelId: z.string().min(1).max(200), archived: z.boolean(), expectedRevision: revision }),
  z.strictObject({ operation: z.literal("provider_profile_create"), ...mutationBase, providerId: uuid, profileKey: codeText, displayName: z.string().trim().min(1).max(200), modelVendor: z.string().trim().min(1).max(200) }),
  z.strictObject({ operation: z.literal("profile_version_create"), ...mutationBase, profileId: uuid, expectedLatestVersion: revision, adapterId: codeText, wireApiKind: z.enum(["chat_completions_v1", "responses_v1"]), endpointUrl: z.string().url().max(512), credentialEnvName: z.string().regex(/^AI_PROVIDER_KEY_[A-Z0-9_]{1,160}$/), modelId: z.string().min(1).max(200), capabilityContractId: codeText, cachePolicyId: codeText, legalManifestId: codeText, displayDisclosureKey: codeText, config: jsonObject }),
  z.strictObject({ operation: z.literal("price_version_create"), ...mutationBase, profileVersionId: uuid, pricingLane: codeText, expectedLatestVersion: revision, currency: z.string().regex(/^[A-Z]{3}$/), calculatorKind: z.enum(["linear_token_v1", "openai_gpt56_v1"]), validFrom: timestamp, validTo: timestamp.nullable(), providerEffectiveFrom: timestamp.nullable(), providerEffectiveTo: timestamp.nullable(), sourceUrl: z.string().url().refine((value) => value.startsWith("https://")), sourceCheckedAt: timestamp, sourceSnapshotSha256: z.string().regex(/^[0-9a-f]{64}$/), parameters: jsonObject, components: jsonObject }),
  z.strictObject({ operation: z.literal("global_daily_limit_set"), ...mutationBase, globalDailyLimit: z.number().int().nonnegative(), expectedGlobalDailyLimit: z.number().int().nonnegative(), expectedControlRevision: revision }),
  z.strictObject({ operation: z.literal("price_seal"), ...mutationBase, priceVersionId: uuid, runtimeContractId: codeText, reviewedDeploymentId: uuid }),
  z.strictObject({ operation: z.literal("profile_version_transition"), ...mutationBase, profileVersionId: uuid, toStatus: z.enum(["validated", "canary", "active"]), validationReportId: uuid }),
  z.strictObject({ operation: z.literal("routing_policy_create"), ...mutationBase, policyKey: codeText, expectedLatestVersion: revision, rules: jsonObject, defaultProfileVersionId: uuid, legalBundleVersion: codeText, runtimeContractId: codeText, validationReportIds: policyIds }),
  z.strictObject({ operation: z.literal("routing_policy_transition"), ...mutationBase, policyVersionId: uuid, toStatus: z.enum(["validated", "canary", "active", "retired"]), validationReportIds: policyIds }),
  z.strictObject({ operation: z.literal("price_close"), ...mutationBase, priceVersionId: uuid, validTo: timestamp, successorPriceVersionId: uuid.nullable(), validationReportId: uuid }),
  z.strictObject({ operation: z.literal("profile_version_retire"), ...mutationBase, profileVersionId: uuid, validationReportId: uuid }),
  z.strictObject({ operation: z.literal("provider_profile_retire"), ...mutationBase, profileId: uuid, validationReportId: uuid }),
]);
export type AdminMutationRequest = z.infer<typeof adminMutationRequestSchema>;

export const adminUserSchema = z.strictObject({
  id: uuid,
  email: z.string().nullable(),
  createdAt: timestamp,
  isAdmin: z.boolean(),
  revision: decimalRevisionSchema.nullable(),
  banned: z.boolean(),
});
export const adminProfileSchema = z.strictObject({
  id: uuid,
  profileId: uuid,
  profileKey: codeId,
  version: z.number().int().positive(),
  status: z.string().max(40),
  gatewayKind: codeId,
  adapterKind: codeId,
  wireApiKind: codeId,
  modelId: z.string().min(1).max(200),
  legalManifestId: codeId,
  displayDisclosureKey: codeId.nullable(),
  endpointAlias: codeId.nullable(),
  credentialAlias: codeId.nullable(),
  endpointUrl: z.string().max(2048).nullable(),
  credentialEnvName: z.string().max(200).nullable(),
  configSha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: timestamp,
});
export const adminPriceSchema = z.strictObject({
  id: uuid,
  profileVersionId: uuid,
  currency: z.string().max(10),
  calculatorKind: codeId,
  validFrom: timestamp,
  validTo: timestamp.nullable(),
  sealedAt: timestamp.nullable(),
  createdAt: timestamp,
});
export const adminPolicySchema = z.strictObject({
  id: uuid,
  policyKey: codeId,
  version: z.number().int().positive(),
  status: z.string().max(40),
  timezone: z.string().max(100),
  defaultProfileVersionId: uuid,
  legalBundleVersion: codeId,
  runtimeContractId: codeId.nullable(),
  configSha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: timestamp,
});
export const adminAuditSchema = z.strictObject({
  id: uuid,
  occurredAt: timestamp,
  source: z.enum(["admin", "lifecycle"]),
  operation: z.string().min(1).max(100),
  actor: z.string().max(200),
  targetId: uuid.nullable(),
  reason: z.string().max(2000),
});
const page = <const S extends AdminRecordSection, T extends z.ZodType>(
  section: S,
  row: T,
) =>
  z.strictObject({
    schemaVersion: z.literal("admin_page_v1"),
    section: z.literal(section),
    items: z.array(row).max(100),
    nextCursor: uuid.nullable(),
  });
export const adminPageSchema = z.union([
  page("users", adminUserSchema),
  page("profiles", adminProfileSchema),
  page("prices", adminPriceSchema),
  page("policies", adminPolicySchema),
  page("audit", adminAuditSchema),
]);
export type AdminPage = z.infer<typeof adminPageSchema>;
export type AdminRecord = AdminPage["items"][number];
export const ADMIN_ERROR_CODES = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "ENVIRONMENT_MISMATCH",
  "INVALID_REQUEST",
  "NOT_FOUND",
  "CONFLICT",
  "STEP_UP_REQUIRED",
  "NOT_READY",
  "UNAVAILABLE",
] as const;
export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[number];
export const adminErrorSchema = z.strictObject({
  error: z.strictObject({ code: z.enum(ADMIN_ERROR_CODES) }),
});
export const ADMIN_ERROR_STATUS: Record<AdminErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  ENVIRONMENT_MISMATCH: 403,
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  STEP_UP_REQUIRED: 403,
  NOT_READY: 409,
  UNAVAILABLE: 503,
};
