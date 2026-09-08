import "server-only";

import { z } from "zod";

const codeId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,199}$/u);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const uuid = z.string().uuid();

/**
 * Durable proof that the database matched an immutable reservation to a
 * currently usable configuration. It deliberately has no deployment/build
 * identity and no short-lived validation-report expiry: those belong to
 * Admin publication and readback, not every user request.
 */
export const runtimeConfigReceiptSchema = z.strictObject({
  schemaVersion: z.literal("runtime_config_receipt_v1"),
  environment: z.enum(["local", "preview", "production"]),
  projectRef: z.string().min(1).max(100),
  runtimeContractId: codeId,
  runtimeTargetId: codeId,
  runtimeTargetSha256: sha256,
  profileVersionId: uuid,
  priceVersionId: uuid,
  providerId: uuid,
  codeCapabilityId: codeId,
  codeCapabilitySha256: sha256,
  legalBundleVersion: codeId,
  legalManifestId: codeId,
  displayDisclosureKey: codeId,
});

export type RuntimeConfigReceiptV1 = z.infer<typeof runtimeConfigReceiptSchema>;
