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
