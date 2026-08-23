import { createHash } from "node:crypto";

export const LEGAL_FINGERPRINT_PREFIX = "ai_fingerprint_record_v1\n" as const;
export const LEGAL_FINGERPRINT_MAX_ARRAY_ITEMS = 4_096;
export const LEGAL_FINGERPRINT_MAX_SCALAR_UTF8_BYTES = 65_536;
export const LEGAL_FINGERPRINT_MAX_STREAM_UTF8_BYTES = 4_194_304;

const CODE_ID = /^[a-z0-9][a-z0-9._-]{0,199}$/;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const DATE_ONLY_SHANGHAI = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])@Asia\/Shanghai$/;
const KEY = /^[a-z0-9._-]+$/;

type FieldKind = "string" | "boolean" | "string[]";

interface SchemaDefinition {
  readonly fields: readonly (readonly [string, FieldKind])[];
  readonly allowEmpty: readonly string[];
  readonly setLike: readonly string[];
  readonly nonEmptyArrays: readonly string[];
  readonly enumValues: Readonly<Record<string, readonly string[]>>;
}

type SchemaOptions = {
  readonly allowEmpty: ReadonlySet<string>;
  readonly setLike: ReadonlySet<string>;
  readonly nonEmptyArrays: ReadonlySet<string>;
  readonly enumValues?: Readonly<Record<string, ReadonlySet<string>>>;
};

const schema = (
  fields: readonly (readonly [string, FieldKind])[],
  options: SchemaOptions,
): SchemaDefinition => Object.freeze({
  fields: Object.freeze(fields.map(([field, kind]) => Object.freeze([field, kind] as const))),
  allowEmpty: Object.freeze([...options.allowEmpty]),
  setLike: Object.freeze([...options.setLike]),
  nonEmptyArrays: Object.freeze([...options.nonEmptyArrays]),
  enumValues: Object.freeze(Object.fromEntries(
    Object.entries(options.enumValues ?? {}).map(([field, values]) => [
      field,
      Object.freeze([...values]),
    ]),
  )),
});

const EMPTY = new Set<string>();

const LEGAL_FINGERPRINT_SCHEMAS = Object.freeze({
  ai_legal_route_identity_v1: schema(
    [
      ["schema_version", "string"],
      ["route_descriptor_id", "string"],
      ["profile_key", "string"],
      ["gateway_kind", "string"],
      ["operator_identity_status", "string"],
      ["operator_legal_name", "string"],
      ["model_vendor_id", "string"],
      ["model_vendor_name", "string"],
      ["model_id", "string"],
      ["wire_api_kind", "string"],
      ["endpoint_alias", "string"],
      ["canonical_endpoint_url", "string"],
      ["display_disclosure_key", "string"],
    ],
    {
      allowEmpty: new Set(["operator_legal_name"]),
      setLike: EMPTY,
      nonEmptyArrays: EMPTY,
      enumValues: {
        operator_identity_status: new Set(["known", "unverified"]),
      },
    },
  ),
  ai_legal_provider_subject_v1: schema(
    [
      ["schema_version", "string"],
      ["subject_descriptor_id", "string"],
      ["mode", "string"],
      ["wire_field", "string"],
      ["algorithm", "string"],
      ["secret_class", "string"],
      ["derivation_message_schema", "string"],
      ["output_encoding", "string"],
      ["source_identity_class", "string"],
      ["raw_email_sent", "boolean"],
      ["raw_username_sent", "boolean"],
      ["raw_account_id_sent", "boolean"],
      ["documented_purposes", "string[]"],
    ],
    {
      allowEmpty: new Set([
        "wire_field",
        "algorithm",
        "secret_class",
        "derivation_message_schema",
        "output_encoding",
        "source_identity_class",
      ]),
      setLike: new Set(["documented_purposes"]),
      nonEmptyArrays: EMPTY,
      enumValues: { mode: new Set(["pseudonymous_hmac", "none"]) },
    },
  ),
  ai_legal_fact_v1: schema(
    [
      ["schema_version", "string"],
      ["fact_id", "string"],
      ["category", "string"],
      ["authority_class", "string"],
      ["operational_scope", "string"],
      ["status", "string"],
      ["subject", "string"],
      ["predicate", "string"],
      ["object", "string"],
      ["scope", "string"],
      ["qualifiers", "string[]"],
    ],
    {
      allowEmpty: new Set(["operational_scope"]),
      setLike: new Set(["qualifiers"]),
      nonEmptyArrays: EMPTY,
      enumValues: {
        category: new Set([
          "submitted-data", "gateway", "operator", "model", "wire", "endpoint",
          "display", "provider-subject", "region", "cache", "retention", "training",
          "transfer", "unknown", "service-processing", "ledger", "quota",
          "output-review", "privacy-linkage", "acceptance", "route-disclosure",
          "material-change",
        ]),
        authority_class: new Set([
          "provider-external", "service-operational", "service-display",
        ]),
        status: new Set(["confirmed", "unverified", "not-found", "not-applicable"]),
      },
    },
  ),
  ai_legal_source_evidence_v1: schema(
    [
      ["schema_version", "string"],
      ["evidence_id", "string"],
      ["authority_kind", "string"],
      ["source_locator_kind", "string"],
      ["source_locator", "string"],
      ["checked_at", "string"],
      ["source_revision_status", "string"],
      ["source_revision", "string"],
      ["upstream_snapshot_status", "string"],
      ["upstream_snapshot_artifact_path", "string"],
      ["upstream_snapshot_sha256", "string"],
      ["reviewed_excerpt", "string"],
      ["reviewed_excerpt_sha256", "string"],
      ["supported_fact_ids", "string[]"],
      ["supported_fact_sha256s", "string[]"],
    ],
    {
      allowEmpty: new Set([
        "source_revision", "upstream_snapshot_artifact_path", "upstream_snapshot_sha256",
      ]),
      setLike: EMPTY,
      nonEmptyArrays: new Set(["supported_fact_ids", "supported_fact_sha256s"]),
      enumValues: {
        authority_kind: new Set([
          "provider-official", "service-contract", "service-registry",
          "service-implementation", "service-test", "service-legal",
        ]),
        source_locator_kind: new Set(["https-url", "repo-path"]),
        source_revision_status: new Set(["known", "unavailable"]),
        upstream_snapshot_status: new Set(["sha256", "unavailable"]),
      },
    },
  ),
  ai_legal_manifest_fingerprint_v1: schema(
    [
      ["schema_version", "string"],
      ["manifest_id", "string"],
      ["display_disclosure_key", "string"],
      ["reviewed_at", "string"],
      ["route_descriptor_ids", "string[]"],
      ["route_descriptor_sha256s", "string[]"],
      ["subject_descriptor_id", "string"],
      ["subject_descriptor_sha256", "string"],
      ["fact_ids", "string[]"],
      ["fact_sha256s", "string[]"],
      ["evidence_ids", "string[]"],
      ["evidence_sha256s", "string[]"],
    ],
    {
      allowEmpty: EMPTY,
      setLike: EMPTY,
      nonEmptyArrays: new Set([
        "route_descriptor_ids", "route_descriptor_sha256s", "fact_ids", "fact_sha256s",
        "evidence_ids", "evidence_sha256s",
      ]),
    },
  ),
  ai_legal_bundle_semantic_contract_v1: schema(
    [
      ["schema_version", "string"],
      ["contract_id", "string"],
      ["contract_kind", "string"],
      ["fact_ids", "string[]"],
      ["fact_sha256s", "string[]"],
      ["evidence_ids", "string[]"],
      ["evidence_sha256s", "string[]"],
    ],
    {
      allowEmpty: EMPTY,
      setLike: EMPTY,
      nonEmptyArrays: new Set(["fact_ids", "fact_sha256s", "evidence_ids", "evidence_sha256s"]),
      enumValues: {
        contract_kind: new Set([
          "neutral-body", "privacy-ai", "acceptance", "route-disclosure", "material-change",
        ]),
      },
    },
  ),
  ai_legal_bundle_contract_fingerprint_v1: schema(
    [
      ["schema_version", "string"],
      ["legal_bundle_version", "string"],
      ["document_key", "string"],
      ["ai_terms_version", "string"],
      ["manifest_fingerprint_schema_version", "string"],
      ["semantic_contract_schema_version", "string"],
      ["neutral_body_contract_id", "string"],
      ["neutral_body_contract_sha256", "string"],
      ["privacy_ai_contract_id", "string"],
      ["privacy_ai_contract_sha256", "string"],
      ["acceptance_contract_id", "string"],
      ["acceptance_contract_sha256", "string"],
      ["route_disclosure_contract_id", "string"],
      ["route_disclosure_contract_sha256", "string"],
      ["material_change_contract_id", "string"],
      ["material_change_contract_sha256", "string"],
      ["manifest_ids", "string[]"],
      ["manifest_sha256s", "string[]"],
    ],
    {
      allowEmpty: EMPTY,
      setLike: EMPTY,
      nonEmptyArrays: new Set(["manifest_ids", "manifest_sha256s"]),
    },
  ),
  ai_service_runtime_evidence_v1: schema(
    [
      ["schema_version", "string"], ["runtime_evidence_id", "string"],
      ["authority_kind", "string"], ["supported_fact_id", "string"],
      ["supported_fact_sha256", "string"], ["source_repo_path", "string"],
      ["source_git_blob_sha256", "string"],
    ],
    {
      allowEmpty: EMPTY, setLike: EMPTY, nonEmptyArrays: EMPTY,
      enumValues: { authority_kind: new Set(["service-implementation", "service-test"]) },
    },
  ),
  ai_service_runtime_target_v1: schema(
    [
      ["schema_version", "string"], ["runtime_target_id", "string"],
      ["profile_key", "string"], ["legal_manifest_id", "string"],
      ["legal_manifest_sha256", "string"], ["route_descriptor_id", "string"],
      ["route_descriptor_sha256", "string"],
    ],
    { allowEmpty: EMPTY, setLike: EMPTY, nonEmptyArrays: EMPTY },
  ),
  ai_service_runtime_contract_v1: schema(
    [
      ["schema_version", "string"], ["runtime_contract_id", "string"],
      ["reviewed_source_commit_oid", "string"], ["legal_bundle_version", "string"],
      ["bundle_contract_sha256", "string"], ["runtime_target_ids", "string[]"],
      ["runtime_target_sha256s", "string[]"], ["service_fact_ids", "string[]"],
      ["service_fact_sha256s", "string[]"], ["runtime_evidence_ids", "string[]"],
      ["runtime_evidence_sha256s", "string[]"],
    ],
    {
      allowEmpty: EMPTY, setLike: EMPTY,
      nonEmptyArrays: new Set([
        "runtime_target_ids", "runtime_target_sha256s", "service_fact_ids",
        "service_fact_sha256s", "runtime_evidence_ids", "runtime_evidence_sha256s",
      ]),
    },
  ),
} satisfies Record<string, SchemaDefinition>);

export type LegalFingerprintSchemaVersion = keyof typeof LEGAL_FINGERPRINT_SCHEMAS;

export class LegalFingerprintV1Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegalFingerprintV1Error";
  }
}

function assertUnicodeScalarSequence(value: string, field: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new LegalFingerprintV1Error(`${field} contains a lone UTF-16 surrogate`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new LegalFingerprintV1Error(`${field} contains a lone UTF-16 surrogate`);
    }
  }
}

function canonicalString(value: unknown, field: string, allowEmpty: boolean): string {
  if (typeof value !== "string") {
    throw new LegalFingerprintV1Error(`${field} must be a string`);
  }
  assertUnicodeScalarSequence(value, field);
  const normalized = value.normalize("NFC");
  if (/[\0\r\n]/u.test(normalized)) {
    throw new LegalFingerprintV1Error(`${field} contains a forbidden control character`);
  }
  if (!allowEmpty && normalized.length === 0) {
    throw new LegalFingerprintV1Error(`${field} must not be empty`);
  }
  if (Buffer.byteLength(normalized, "utf8") > LEGAL_FINGERPRINT_MAX_SCALAR_UTF8_BYTES) {
    throw new LegalFingerprintV1Error(`${field} exceeds the UTF-8 byte limit`);
  }
  return normalized;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isPortableRepoPath(value: string): boolean {
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith("/") || value.endsWith("/")) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function assertExactDataArray(value: unknown, field: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new LegalFingerprintV1Error(`${field} must be an array`);
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new LegalFingerprintV1Error(`${field} must not use an inherited or custom array prototype`);
  }
  const allowed = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new LegalFingerprintV1Error(`${field} must not contain symbol or extra array properties`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new LegalFingerprintV1Error(`${field} must contain every index as an own data property`);
    }
  }
}

function pairBase(field: string): string | undefined {
  return field.endsWith("_ids") ? field.slice(0, -4) : undefined;
}

function validateSpecialFields(schemaVersion: LegalFingerprintSchemaVersion, value: Record<string, unknown>): void {
  const operatorStatus = value.operator_identity_status;
  if (schemaVersion === "ai_legal_route_identity_v1") {
    if ((operatorStatus === "known") !== (value.operator_legal_name !== "")) {
      throw new LegalFingerprintV1Error("operator_legal_name must be present exactly when operator is known");
    }
    try {
      const endpoint = new URL(value.canonical_endpoint_url as string);
      if (endpoint.protocol !== "https:" || endpoint.href !== value.canonical_endpoint_url) {
        throw new Error("not exact HTTPS");
      }
    } catch {
      throw new LegalFingerprintV1Error("canonical_endpoint_url must be an exact canonical HTTPS URL");
    }
  }
  if (schemaVersion === "ai_legal_provider_subject_v1") {
    const noneFields = ["wire_field", "algorithm", "secret_class", "derivation_message_schema", "output_encoding", "source_identity_class"];
    const isNone = value.mode === "none";
    if (noneFields.some((field) => ((value[field] as string) === "") !== isNone)) {
      throw new LegalFingerprintV1Error("subject derivation fields must all be empty exactly for mode=none");
    }
    if (isNone && (value.documented_purposes as string[]).length !== 0) {
      throw new LegalFingerprintV1Error("mode=none requires empty documented_purposes");
    }
    if (!isNone && (value.documented_purposes as string[]).length === 0) {
      throw new LegalFingerprintV1Error("pseudonymous_hmac requires documented_purposes");
    }
  }
  if (schemaVersion === "ai_legal_fact_v1") {
    const operational = value.authority_class === "service-operational";
    const scope = value.operational_scope as string;
    if (operational) {
      if (scope !== "global" && !/^profile:[a-z0-9][a-z0-9._-]{0,199}$/.test(scope)) {
        throw new LegalFingerprintV1Error("service-operational fact requires an exact operational_scope");
      }
    } else if (scope !== "") {
      throw new LegalFingerprintV1Error("non-operational fact must have empty operational_scope");
    }
  }
  if (schemaVersion === "ai_legal_source_evidence_v1") {
    if (!DATE_ONLY_SHANGHAI.test(value.checked_at as string)) {
      throw new LegalFingerprintV1Error("checked_at must use YYYY-MM-DD@Asia/Shanghai");
    }
    const official = value.authority_kind === "provider-official";
    if ((value.source_locator_kind === "https-url") !== official) {
      throw new LegalFingerprintV1Error("provider-official requires https-url and service evidence requires repo-path");
    }
    if (official) {
      try {
        if (new URL(value.source_locator as string).protocol !== "https:") throw new Error();
      } catch {
        throw new LegalFingerprintV1Error("provider-official source_locator must be HTTPS");
      }
    } else if (!isPortableRepoPath(value.source_locator as string)) {
      throw new LegalFingerprintV1Error("service evidence source_locator must be a portable repo path");
    }
    const revisionUnavailable = value.source_revision_status === "unavailable";
    if (((value.source_revision as string) === "") !== revisionUnavailable) {
      throw new LegalFingerprintV1Error("source_revision must be empty exactly when unavailable");
    }
    const snapshotUnavailable = value.upstream_snapshot_status === "unavailable";
    for (const field of ["upstream_snapshot_artifact_path", "upstream_snapshot_sha256"] as const) {
      if (((value[field] as string) === "") !== snapshotUnavailable) {
        throw new LegalFingerprintV1Error(`${field} must be empty exactly when snapshot is unavailable`);
      }
    }
    if (!official && snapshotUnavailable) {
      throw new LegalFingerprintV1Error("service evidence requires an exact SHA-256 Git snapshot");
    }
    if (!snapshotUnavailable) {
      const artifactPath = value.upstream_snapshot_artifact_path as string;
      if (!isPortableRepoPath(artifactPath)) {
        throw new LegalFingerprintV1Error("snapshot artifact must be a portable repo path");
      }
      if (!official && artifactPath !== value.source_locator) {
        throw new LegalFingerprintV1Error("service evidence snapshot path must equal its source locator");
      }
    }
    const excerptHash = createHash("sha256").update(value.reviewed_excerpt as string, "utf8").digest("hex");
    if (excerptHash !== value.reviewed_excerpt_sha256) {
      throw new LegalFingerprintV1Error("reviewed_excerpt_sha256 does not match exact NFC UTF-8 excerpt bytes");
    }
  }
  if ("reviewed_at" in value && !DATE_ONLY_SHANGHAI.test(value.reviewed_at as string)) {
    throw new LegalFingerprintV1Error("reviewed_at must use YYYY-MM-DD@Asia/Shanghai");
  }
  if (schemaVersion === "ai_legal_bundle_contract_fingerprint_v1") {
    if (value.document_key !== "ai_terms" || value.ai_terms_version !== value.legal_bundle_version) {
      throw new LegalFingerprintV1Error("bundle must bind document_key=ai_terms and equal terms/bundle versions");
    }
    if (
      value.manifest_fingerprint_schema_version !== "ai_legal_manifest_fingerprint_v1" ||
      value.semantic_contract_schema_version !== "ai_legal_bundle_semantic_contract_v1"
    ) {
      throw new LegalFingerprintV1Error("bundle schema referents are not exact v1 schemas");
    }
  }
  if (schemaVersion === "ai_service_runtime_contract_v1" && !/^sha1:[0-9a-f]{40}$/.test(value.reviewed_source_commit_oid as string)) {
    throw new LegalFingerprintV1Error("reviewed_source_commit_oid must be sha1:<40 lowercase hex>");
  }
  if (schemaVersion === "ai_service_runtime_evidence_v1" && !isPortableRepoPath(value.source_repo_path as string)) {
    throw new LegalFingerprintV1Error("source_repo_path must be a portable ASCII repo path");
  }
}

function normalizeDescriptor(input: unknown): { schemaVersion: LegalFingerprintSchemaVersion; values: Record<string, string | boolean | string[]> } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new LegalFingerprintV1Error("descriptor must be a non-array object");
  }
  const descriptor = input as Record<string, unknown>;
  if (typeof descriptor.schema_version !== "string" || !(descriptor.schema_version in LEGAL_FINGERPRINT_SCHEMAS)) {
    throw new LegalFingerprintV1Error("descriptor has an unknown schema_version");
  }
  const schemaVersion = descriptor.schema_version as LegalFingerprintSchemaVersion;
  const definition = LEGAL_FINGERPRINT_SCHEMAS[schemaVersion];
  const expected = new Set(definition.fields.map(([field]) => field));
  const ownKeys = Reflect.ownKeys(descriptor);
  if (ownKeys.some((field) => typeof field !== "string")) {
    throw new LegalFingerprintV1Error("descriptor contains an unknown symbol field");
  }
  const stringKeys = ownKeys as string[];
  const unknown = stringKeys.filter((field) => !expected.has(field));
  const missing = [...expected].filter((field) => !Object.hasOwn(descriptor, field));
  if (unknown.length > 0 || missing.length > 0 || stringKeys.length !== expected.size) {
    throw new LegalFingerprintV1Error(`descriptor keys mismatch (unknown=${unknown.join(",") || "none"}; missing=${missing.join(",") || "none"})`);
  }
  for (const field of stringKeys) {
    const property = Object.getOwnPropertyDescriptor(descriptor, field);
    if (property === undefined || !("value" in property)) {
      throw new LegalFingerprintV1Error(`${field} must be an own data property`);
    }
  }

  const values: Record<string, string | boolean | string[]> = {};
  for (const [field, kind] of definition.fields) {
    if (!KEY.test(field)) throw new LegalFingerprintV1Error(`invalid schema key ${field}`);
    const raw = descriptor[field];
    if (kind === "boolean") {
      if (typeof raw !== "boolean") throw new LegalFingerprintV1Error(`${field} must be a boolean`);
      values[field] = raw;
      continue;
    }
    if (kind === "string") {
      values[field] = canonicalString(raw, field, definition.allowEmpty.includes(field));
      continue;
    }
    assertExactDataArray(raw, field);
    if (raw.length > LEGAL_FINGERPRINT_MAX_ARRAY_ITEMS) throw new LegalFingerprintV1Error(`${field} exceeds the item limit`);
    if (definition.nonEmptyArrays.includes(field) && raw.length === 0) throw new LegalFingerprintV1Error(`${field} must not be empty`);
    const array = raw.map((item, index) => canonicalString(item, `${field}.${index}`, false));
    if (definition.setLike.includes(field)) {
      const sorted = [...array].sort(compareUtf8);
      if (sorted.some((item, index) => index > 0 && item === sorted[index - 1])) {
        throw new LegalFingerprintV1Error(`${field} contains an NFC-duplicate`);
      }
      values[field] = sorted;
    } else {
      values[field] = array;
    }
  }

  for (const [field, allowed] of Object.entries(definition.enumValues)) {
    if (!allowed.includes(values[field] as string)) throw new LegalFingerprintV1Error(`${field} contains an unknown enum value`);
  }

  for (const [field, value] of Object.entries(values)) {
    if ((field.endsWith("_id") || field.endsWith("_version") || field === "schema_version" || field === "display_disclosure_key") && typeof value === "string" && !CODE_ID.test(value)) {
      throw new LegalFingerprintV1Error(`${field} must be an ASCII code ID`);
    }
    if (field.endsWith("_sha256") && typeof value === "string" && value !== "" && !LOWER_HEX_64.test(value)) {
      throw new LegalFingerprintV1Error(`${field} must be lowercase hex-64`);
    }
    if (field.endsWith("_ids") && Array.isArray(value) && value.some((item) => !CODE_ID.test(item))) {
      throw new LegalFingerprintV1Error(`${field} must contain ASCII code IDs`);
    }
    if (field.endsWith("_sha256s") && Array.isArray(value) && value.some((item) => !LOWER_HEX_64.test(item))) {
      throw new LegalFingerprintV1Error(`${field} must contain lowercase hex-64 values`);
    }
  }

  for (const [field] of definition.fields) {
    const base = pairBase(field);
    if (base === undefined) continue;
    const ids = values[field] as string[];
    const hashesField = `${base}_sha256s`;
    const hashes = values[hashesField] as string[] | undefined;
    if (hashes === undefined || ids.length !== hashes.length) {
      throw new LegalFingerprintV1Error(`${field}/${hashesField} pair arrays must have equal length`);
    }
    const pairs = ids.map((id, index) => [id, hashes[index]] as const).sort(([left], [right]) => compareUtf8(left, right));
    if (pairs.some(([id], index) => index > 0 && id === pairs[index - 1][0])) {
      throw new LegalFingerprintV1Error(`${field} contains a duplicate pair ID`);
    }
    values[field] = pairs.map(([id]) => id);
    values[hashesField] = pairs.map(([, hash]) => hash);
  }

  validateSpecialFields(schemaVersion, values);
  return { schemaVersion, values };
}

export interface LegalFingerprintResultV1 {
  readonly schemaVersion: LegalFingerprintSchemaVersion;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly normalized: Readonly<Record<string, string | boolean | readonly string[]>>;
}

export function fingerprintLegalDescriptorV1(input: unknown): LegalFingerprintResultV1 {
  const { schemaVersion, values } = normalizeDescriptor(input);
  const definition = LEGAL_FINGERPRINT_SCHEMAS[schemaVersion];
  const records: string[] = [LEGAL_FINGERPRINT_PREFIX];
  const append = (key: string, scalar: string): void => {
    records.push(`${Buffer.byteLength(key, "utf8")}:${key}:${Buffer.byteLength(scalar, "utf8")}:${scalar}\n`);
  };
  for (const [field, kind] of definition.fields) {
    const value = values[field];
    if (kind === "boolean") append(field, value === true ? "true" : "false");
    else if (kind === "string") append(field, value as string);
    else {
      const array = value as string[];
      append(`${field}.count`, String(array.length));
      array.forEach((item, index) => append(`${field}.${index}`, item));
    }
  }
  const bytes = Buffer.from(records.join(""), "utf8");
  if (bytes.length > LEGAL_FINGERPRINT_MAX_STREAM_UTF8_BYTES) {
    throw new LegalFingerprintV1Error("fingerprint stream exceeds the UTF-8 byte limit");
  }
  const normalized = Object.freeze(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Array.isArray(value) ? Object.freeze([...value]) : value])));
  return Object.freeze({
    schemaVersion,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    normalized,
  });
}

export function sha256ExactUtf8(value: string): string {
  assertUnicodeScalarSequence(value, "value");
  return createHash("sha256").update(value.normalize("NFC"), "utf8").digest("hex");
}
