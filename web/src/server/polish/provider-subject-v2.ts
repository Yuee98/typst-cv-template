import { createHmac } from "node:crypto";

const UUID_8_4_4_4_12_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PROVIDER_SUBJECT_ID_V2_PATTERN = /^[0-9a-f]{64}$/;

export const PROVIDER_SUBJECT_V2_ALGORITHM = "hmac-sha256" as const;
export const PROVIDER_SUBJECT_V2_SECRET_CLASS =
  "utf8-trimmed-env:AI_USER_ID_HMAC_SECRET" as const;
export const PROVIDER_SUBJECT_V2_DERIVATION_MESSAGE_SCHEMA =
  "ASCII(provider-subject-v2\\nprofile_version_id:)+UUID36LOWER(profile_version_id)+ASCII(\\nuser_id:)+UUID36LOWER(user_id)" as const;

export class ProviderSubjectV2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderSubjectV2Error";
  }
}

export interface ProviderSubjectV2IdentityInput {
  readonly profileVersionId: string;
  readonly authenticatedUserId: string;
}

export interface DeriveProviderSubjectIdV2Input extends ProviderSubjectV2IdentityInput {
  readonly secret: string;
}

function canonicalizeUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_8_4_4_4_12_PATTERN.test(value)) {
    throw new ProviderSubjectV2Error(`${field} must be an RFC 4122 8-4-4-4-12 UUID`);
  }

  return value.toLowerCase();
}

function assertUnicodeScalarSequence(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new ProviderSubjectV2Error("secret must contain valid Unicode for UTF-8 encoding");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new ProviderSubjectV2Error("secret must contain valid Unicode for UTF-8 encoding");
    }
  }
}

function utf8TrimmedSecret(value: unknown): Buffer {
  if (typeof value !== "string") {
    throw new ProviderSubjectV2Error("secret must be a string");
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ProviderSubjectV2Error("secret must be non-empty after trimming");
  }
  assertUnicodeScalarSequence(trimmed);

  return Buffer.from(trimmed, "utf8");
}

/**
 * Build the exact provider-subject-v2 HMAC message. The returned bytes are a
 * fresh buffer and the caller-owned input is never changed.
 */
export function buildProviderSubjectV2Message(input: ProviderSubjectV2IdentityInput): Buffer {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProviderSubjectV2Error("provider subject identity input must be an object");
  }

  const profileVersionId = canonicalizeUuid(input.profileVersionId, "profileVersionId");
  const authenticatedUserId = canonicalizeUuid(
    input.authenticatedUserId,
    "authenticatedUserId",
  );

  return Buffer.from(
    `provider-subject-v2\nprofile_version_id:${profileVersionId}\nuser_id:${authenticatedUserId}`,
    "ascii",
  );
}

/** Derive the lowercase 64-hex pseudonym for a frozen V2 profile snapshot. */
export function deriveProviderSubjectIdV2(input: DeriveProviderSubjectIdV2Input): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ProviderSubjectV2Error("provider subject derivation input must be an object");
  }

  const key = utf8TrimmedSecret(input.secret);
  const message = buildProviderSubjectV2Message(input);
  return createHmac("sha256", key).update(message).digest("hex");
}

/** Validate an already-derived value before it enters a persisted or wire field. */
export function parseProviderSubjectIdV2(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER_SUBJECT_ID_V2_PATTERN.test(value)) {
    throw new ProviderSubjectV2Error(
      "providerSubjectId must be exactly 64 lowercase hexadecimal characters",
    );
  }

  return value;
}
