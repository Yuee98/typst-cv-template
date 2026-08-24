import { createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import fixture from "../../../test/fixtures/ai-runtime-execution-contract-v1.json";

const FIELD_KINDS = ["gateway_request_id", "provider_request_id"] as const;
type FieldKind = (typeof FIELD_KINDS)[number];

const RAW_ID_PATTERN_SOURCE = "^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$";
const RAW_ID_PATTERN = new RegExp(RAW_ID_PATTERN_SOURCE);
const SENSITIVE_PREFIXES = [
  "access-token",
  "access_token",
  "api-key",
  "api_key",
  "apikey",
  "authorization",
  "basic",
  "bearer",
  "cookie",
  "eyj",
  "ghp_",
  "github_pat_",
  "password",
  "passwd",
  "refresh-token",
  "refresh_token",
  "secret",
  "set-cookie",
  "sk-",
  "sk_",
  "token",
  "x-api-key",
  "x-auth-token",
] as const;

const MAX_POSTGRES_BIGINT = BigInt("9223372036854775807");
const CANONICAL_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOWER_HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const TAG_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;

const SUCCESS_KEYS = [
  "schemaVersion",
  "ok",
  "reservationId",
  "routeSnapshot",
  "profileExecutionConfig",
  "priceSnapshot",
] as const;
const ERROR_KEYS = ["schemaVersion", "ok", "reason"] as const;
const ROUTE_KEYS = [
  "schemaVersion",
  "configGeneration",
  "routingPolicyVersionId",
  "profileVersionId",
  "priceVersionId",
  "legalBundleVersion",
  "runtimeContractId",
  "runtimeContractSha256",
  "gatewayKind",
  "modelId",
  "wireApiKind",
  "displayDisclosureKey",
] as const;
const PROFILE_KEYS = [
  "schemaVersion",
  "profileKey",
  "gatewayKind",
  "adapterKind",
  "wireApiKind",
  "credentialAlias",
  "endpointAlias",
  "modelId",
  "capabilityContractId",
  "cachePolicyId",
  "legalManifestId",
  "calculatorKind",
  "displayDisclosureKey",
  "config",
] as const;
const PRICE_KEYS = [
  "schemaVersion",
  "priceVersionId",
  "currency",
  "calculatorKind",
  "components",
  "parameters",
] as const;
const PRICE_COMPONENTS = [
  "input_standard",
  "input_cache_read",
  "input_cache_write",
  "output",
] as const;
const ERROR_REASONS = ["NOT_FOUND", "ALREADY_FINALIZED", "SERVICE_UNAVAILABLE"] as const;

const REFERENCE_PROFILES = {
  "deepseek.official.deepseek-v4-flash.chat.v1": {
    profileVersionId: "11111111-1111-4111-8111-111111111111",
    execution: {
      schemaVersion: "profile_execution_config_v1",
      profileKey: "deepseek.official.deepseek-v4-flash.chat.v1",
      gatewayKind: "direct_deepseek",
      adapterKind: "deepseek_chat_v1",
      wireApiKind: "chat_completions_v1",
      credentialAlias: "deepseek_api_key",
      endpointAlias: "deepseek_official",
      modelId: "deepseek-v4-flash",
      capabilityContractId: "deepseek_chat_json_object_v1",
      cachePolicyId: "deepseek_automatic_context_cache_v1",
      legalManifestId: "deepseek-official-2026-08-23-v1",
      calculatorKind: "linear_token_v1",
      displayDisclosureKey: "deepseek-official-v1",
      config: {
        thinking: "disabled",
        structuredOutput: "json_object",
        providerSubjectField: "user_id",
      },
    },
  },
  "mimo.cn.mimo-v2.5-pro.responses.v1": {
    profileVersionId: "22222222-2222-4222-8222-222222222221",
    execution: {
      schemaVersion: "profile_execution_config_v1",
      profileKey: "mimo.cn.mimo-v2.5-pro.responses.v1",
      gatewayKind: "direct_mimo",
      adapterKind: "mimo_responses_v1",
      wireApiKind: "responses_v1",
      credentialAlias: "mimo_api_key",
      endpointAlias: "mimo_cn_official",
      modelId: "mimo-v2.5-pro",
      capabilityContractId: "mimo_responses_output_text_v1",
      cachePolicyId: "mimo_automatic_prompt_cache_v1",
      legalManifestId: "mimo-cn-2026-08-23-v1",
      calculatorKind: "linear_token_v1",
      displayDisclosureKey: "mimo-cn-v1",
      config: {
        reasoningEffort: "none",
        structuredOutput: "prompt_only",
        sendProviderSubjectId: false,
      },
    },
  },
} satisfies Record<
  string,
  { profileVersionId: string; execution: Record<string, unknown> }
>;

const PRICE_PROFILE_BINDINGS: Record<string, string> = {
  "11111111-1111-4111-8111-111111111112":
    "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222":
    "22222222-2222-4222-8222-222222222221",
};

const LEGAL_BUNDLE_MANIFESTS: Record<string, ReadonlySet<string>> = {
  "2026-08-23-multi-provider-v1": new Set([
    "deepseek-official-2026-08-23-v1",
    "mimo-cn-2026-08-23-v1",
  ]),
};

type ReferenceRecord = Record<string, unknown>;
type DropReason = "not_string" | "invalid_ascii_grammar" | "sensitive_prefix";
type RouteObservation =
  | { kind: "absent" }
  | { kind: "dropped"; reason: DropReason }
  | { kind: "tagged"; value: string };

class ReferenceContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReferenceContractError";
  }
}

function assertCondition(condition: boolean, code: string): asserts condition {
  if (!condition) {
    throw new ReferenceContractError(code);
  }
}

function requireRecord(value: unknown, label: string): ReferenceRecord {
  assertCondition(typeof value === "object" && value !== null && !Array.isArray(value), label);
  return value as ReferenceRecord;
}

function assertExactKeys(
  value: ReferenceRecord,
  expectedKeys: readonly string[],
  label: string,
): void {
  const expected = new Set(expectedKeys);
  const actualKeys = Object.keys(value);
  assertCondition(
    actualKeys.length === expected.size &&
      actualKeys.every((key) => expected.has(key)) &&
      expectedKeys.every((key) => Object.hasOwn(value, key)),
    `${label}_keys`,
  );
}

function requireString(value: unknown, label: string): string {
  assertCondition(typeof value === "string", label);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const result = requireString(value, label);
  assertCondition(result.length > 0, label);
  return result;
}

function requireCanonicalUuid(value: unknown, label: string): string {
  const result = requireString(value, label);
  assertCondition(UUID_PATTERN.test(result), label);
  return result;
}

function requirePostgresBigintDecimal(value: unknown, label: string): string {
  const result = requireString(value, label);
  assertCondition(CANONICAL_DECIMAL_PATTERN.test(result), label);
  assertCondition(BigInt(result) <= MAX_POSTGRES_BIGINT, label);
  return result;
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new ReferenceContractError("secret_invalid_unicode");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new ReferenceContractError("secret_invalid_unicode");
    }
  }
}

function isContractWhitespace(scalar: string): boolean {
  const codePoint = scalar.codePointAt(0);
  return (
    codePoint !== undefined &&
    ((codePoint >= 0x0009 && codePoint <= 0x000d) ||
      codePoint === 0x0020 ||
      codePoint === 0x00a0 ||
      codePoint === 0x1680 ||
      (codePoint >= 0x2000 && codePoint <= 0x200a) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      codePoint === 0x202f ||
      codePoint === 0x205f ||
      codePoint === 0x3000 ||
      codePoint === 0xfeff)
  );
}

function referenceSecretBytes(value: unknown): Buffer {
  if (typeof value !== "string") {
    throw new ReferenceContractError("secret_not_string");
  }
  assertUnicodeScalarString(value);

  const scalars = Array.from(value);
  let start = 0;
  let end = scalars.length;
  while (start < end && isContractWhitespace(scalars[start])) {
    start += 1;
  }
  while (end > start && isContractWhitespace(scalars[end - 1])) {
    end -= 1;
  }
  if (start === end) {
    throw new ReferenceContractError("secret_empty_after_trim");
  }
  return Buffer.from(scalars.slice(start, end).join(""), "utf8");
}

function requireFieldKind(value: string): FieldKind {
  assertCondition(FIELD_KINDS.includes(value as FieldKind), "unknown_field_kind");
  return value as FieldKind;
}

function classifyRawId(
  value: unknown,
): { kind: "absent" } | { kind: "dropped"; reason: DropReason } | { kind: "eligible"; rawId: string } {
  if (value === null || value === undefined) {
    return { kind: "absent" };
  }
  if (typeof value !== "string") {
    return { kind: "dropped", reason: "not_string" };
  }
  if (!RAW_ID_PATTERN.test(value)) {
    return { kind: "dropped", reason: "invalid_ascii_grammar" };
  }
  const lower = value.toLowerCase();
  if (SENSITIVE_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return { kind: "dropped", reason: "sensitive_prefix" };
  }
  return { kind: "eligible", rawId: value };
}

function referenceMessage(fieldKind: FieldKind, rawId: string): Buffer {
  const byteLength = Buffer.byteLength(rawId, "utf8");
  return Buffer.from(
    `route-observation-v1\nfield_kind:${fieldKind}\nraw_id_utf8_length:${byteLength}\nraw_id:${rawId}`,
    "utf8",
  );
}

function observeRouteId(value: unknown, fieldKindValue: string, secret: unknown): RouteObservation {
  const classified = classifyRawId(value);
  if (classified.kind !== "eligible") {
    return classified;
  }
  const fieldKind = requireFieldKind(fieldKindValue);
  const digest = createHmac("sha256", referenceSecretBytes(secret))
    .update(referenceMessage(fieldKind, classified.rawId))
    .digest("hex");
  return { kind: "tagged", value: `hmac-sha256:${digest}` };
}

function validateRouteSnapshot(value: unknown): ReferenceRecord {
  const route = requireRecord(value, "route_object");
  assertExactKeys(route, ROUTE_KEYS, "route");
  assertCondition(route.schemaVersion === "route_snapshot_v1", "route_schema");
  requirePostgresBigintDecimal(route.configGeneration, "route_generation");
  requireCanonicalUuid(route.routingPolicyVersionId, "route_policy_id");
  requireCanonicalUuid(route.profileVersionId, "route_profile_id");
  requireCanonicalUuid(route.priceVersionId, "route_price_id");
  requireNonEmptyString(route.legalBundleVersion, "route_legal_bundle");
  requireNonEmptyString(route.runtimeContractId, "route_runtime_id");
  const runtimeHash = requireString(route.runtimeContractSha256, "route_runtime_hash");
  assertCondition(LOWER_HEX_64_PATTERN.test(runtimeHash), "route_runtime_hash");
  requireNonEmptyString(route.gatewayKind, "route_gateway");
  requireNonEmptyString(route.modelId, "route_model");
  requireNonEmptyString(route.wireApiKind, "route_wire_api");
  requireNonEmptyString(route.displayDisclosureKey, "route_disclosure");
  return route;
}

function validateProfileExecution(value: unknown): ReferenceRecord {
  const profile = requireRecord(value, "profile_object");
  assertExactKeys(profile, PROFILE_KEYS, "profile");
  assertCondition(profile.schemaVersion === "profile_execution_config_v1", "profile_schema");
  const profileKey = requireString(profile.profileKey, "profile_key");
  const registration = REFERENCE_PROFILES[profileKey as keyof typeof REFERENCE_PROFILES];
  assertCondition(registration !== undefined, "profile_unknown");
  assertCondition(isDeepStrictEqual(profile, registration.execution), "profile_registry_mismatch");
  return profile;
}

function validatePriceSnapshot(value: unknown): ReferenceRecord {
  const price = requireRecord(value, "price_object");
  assertExactKeys(price, PRICE_KEYS, "price");
  assertCondition(price.schemaVersion === "price_snapshot_v1", "price_schema");
  requireCanonicalUuid(price.priceVersionId, "price_id");
  const currency = requireString(price.currency, "price_currency");
  assertCondition(/^[A-Z]{3}$/.test(currency), "price_currency");
  const calculatorKind = requireString(price.calculatorKind, "price_calculator");
  assertCondition(calculatorKind === "linear_token_v1", "price_calculator");

  const components = requireRecord(price.components, "price_components");
  const componentKeys = Object.keys(components);
  assertCondition(
    componentKeys.every((key) => PRICE_COMPONENTS.includes(key as (typeof PRICE_COMPONENTS)[number])),
    "price_component_keys",
  );
  for (const required of ["input_standard", "input_cache_read", "output"] as const) {
    assertCondition(Object.hasOwn(components, required), "price_required_component");
  }
  for (const [component, nanos] of Object.entries(components)) {
    requirePostgresBigintDecimal(nanos, `price_component_${component}`);
  }

  const parameters = requireRecord(price.parameters, "price_parameters");
  assertExactKeys(parameters, [], "linear_parameters");
  return price;
}

function validateExecutionSnapshot(value: unknown): void {
  const result = requireRecord(value, "execution_result");
  assertCondition(
    result.schemaVersion === "ai_polish_execution_snapshot_v1",
    "execution_schema",
  );

  if (result.ok === false) {
    assertExactKeys(result, ERROR_KEYS, "execution_error");
    assertCondition(
      typeof result.reason === "string" &&
        ERROR_REASONS.includes(result.reason as (typeof ERROR_REASONS)[number]),
      "execution_reason",
    );
    return;
  }

  assertCondition(result.ok === true, "execution_ok_discriminator");
  assertExactKeys(result, SUCCESS_KEYS, "execution_success");
  requireCanonicalUuid(result.reservationId, "execution_reservation_id");
  const route = validateRouteSnapshot(result.routeSnapshot);
  const profile = validateProfileExecution(result.profileExecutionConfig);
  const price = validatePriceSnapshot(result.priceSnapshot);

  const profileKey = requireString(profile.profileKey, "profile_key");
  const registration = REFERENCE_PROFILES[profileKey as keyof typeof REFERENCE_PROFILES];
  assertCondition(registration !== undefined, "profile_unknown");
  assertCondition(route.profileVersionId === registration.profileVersionId, "profile_version_binding");
  assertCondition(route.priceVersionId === price.priceVersionId, "route_price_binding");
  assertCondition(
    PRICE_PROFILE_BINDINGS[requireString(price.priceVersionId, "price_id")] ===
      route.profileVersionId,
    "price_profile_binding",
  );
  for (const key of [
    "gatewayKind",
    "modelId",
    "wireApiKind",
    "displayDisclosureKey",
  ] as const) {
    assertCondition(route[key] === profile[key], `route_profile_${key}`);
  }
  assertCondition(profile.calculatorKind === price.calculatorKind, "profile_price_calculator");
  const bundle = LEGAL_BUNDLE_MANIFESTS[
    requireString(route.legalBundleVersion, "route_legal_bundle")
  ];
  assertCondition(bundle !== undefined, "legal_bundle_unknown");
  assertCondition(
    bundle.has(requireString(profile.legalManifestId, "profile_legal_manifest")),
    "legal_manifest_binding",
  );
}

function caughtCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof ReferenceContractError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("expected the independent reference to reject the value");
}

function materializeSecretErrorInput(vector: {
  inputEncoding: string;
  input: unknown;
}): unknown {
  if (vector.inputEncoding === "json_value") {
    return vector.input;
  }
  assertCondition(vector.inputEncoding === "utf16_code_units_hex", "fixture_input_encoding");
  assertCondition(Array.isArray(vector.input), "fixture_utf16_units");
  const codeUnits = vector.input.map((unit) => {
    assertCondition(typeof unit === "string" && /^[0-9a-f]{4}$/.test(unit), "fixture_utf16_unit");
    return Number.parseInt(unit, 16);
  });
  return String.fromCharCode(...codeUnits);
}

function deepseekSuccess(): ReferenceRecord {
  return structuredClone(
    fixture.executionSnapshot.successes[0].value,
  ) as unknown as ReferenceRecord;
}

describe("CTRL-010 route-observation contract vectors", () => {
  it("freezes the exact field kinds, ASCII grammar, and prefix denylist", () => {
    const root = requireRecord(fixture, "fixture_root");
    assertExactKeys(root, ["schemaVersion", "routeObservation", "executionSnapshot"], "fixture");
    assertExactKeys(
      requireRecord(fixture.routeObservation, "fixture_route_observation"),
      [
        "fieldKinds",
        "rawIdPattern",
        "sensitivePrefixes",
        "derivationVectors",
        "dropVectors",
        "secretErrorVectors",
      ],
      "fixture_route_observation",
    );
    assertExactKeys(
      requireRecord(fixture.executionSnapshot, "fixture_execution_snapshot"),
      ["successes", "errors"],
      "fixture_execution_snapshot",
    );
    expect(fixture.schemaVersion).toBe("ai_runtime_execution_contract_vectors_v1");
    expect(fixture.routeObservation.fieldKinds).toEqual(FIELD_KINDS);
    expect(fixture.routeObservation.rawIdPattern).toBe(RAW_ID_PATTERN_SOURCE);
    expect(fixture.routeObservation.sensitivePrefixes).toEqual(SENSITIVE_PREFIXES);
  });

  it.each(fixture.routeObservation.derivationVectors)(
    "independently reproduces exact key, message, and HMAC bytes for $name",
    (vector) => {
      const fieldKind = requireFieldKind(vector.fieldKind);
      const key = referenceSecretBytes(vector.secretInput);
      const message = referenceMessage(fieldKind, vector.rawId);
      const observed = observeRouteId(vector.rawId, vector.fieldKind, vector.secretInput);

      expect(key.toString("hex")).toBe(vector.trimmedSecretUtf8Hex);
      expect(Buffer.byteLength(vector.rawId, "utf8")).toBe(vector.rawIdUtf8Length);
      expect(message.toString("hex")).toBe(vector.messageUtf8Hex);
      expect(observed).toEqual({ kind: "tagged", value: vector.expectedTag });
      expect(vector.expectedTag).toMatch(TAG_PATTERN);
      expect(message.at(-1)).not.toBe(0x0a);
      expect(message.at(-1)).not.toBe(0x00);
    },
  );

  it.each(fixture.routeObservation.dropVectors)(
    "classifies $name without retaining raw input",
    (vector) => {
      const observed = observeRouteId(vector.input, "gateway_request_id", "route-secret");
      const expected =
        vector.expectedKind === "absent"
          ? { kind: "absent" }
          : { kind: "dropped", reason: vector.expectedReason };
      expect(observed).toEqual(expected);
      if (typeof vector.input === "string" && vector.input.length > 0) {
        expect(JSON.stringify(observed)).not.toContain(vector.input);
      }
    },
  );

  it.each(fixture.routeObservation.secretErrorVectors)(
    "returns the fixed safe secret error for $name",
    (vector) => {
      expect(caughtCode(() => referenceSecretBytes(materializeSecretErrorInput(vector)))).toBe(
        vector.expectedCode,
      );
    },
  );

  it("keeps boundary length, domain separation, Unicode bytes, and missing-value semantics exact", () => {
    expect(observeRouteId(undefined, "gateway_request_id", "route-secret")).toEqual({
      kind: "absent",
    });
    expect(observeRouteId(`a${"b".repeat(7)}`, "gateway_request_id", "route-secret").kind).toBe(
      "tagged",
    );
    expect(
      observeRouteId(`a${"b".repeat(127)}`, "gateway_request_id", "route-secret").kind,
    ).toBe("tagged");
    expect(observeRouteId(`a${"b".repeat(128)}`, "gateway_request_id", "route-secret")).toEqual({
      kind: "dropped",
      reason: "invalid_ascii_grammar",
    });

    const byName = Object.fromEntries(
      fixture.routeObservation.derivationVectors.map((vector) => [vector.name, vector.expectedTag]),
    );
    expect(byName["gateway-ascii"]).not.toBe(byName["provider-ascii"]);
    expect(byName["gateway-nfc-secret"]).not.toBe(byName["gateway-nfd-secret"]);
    expect(referenceSecretBytes("\u180e").toString("hex")).toBe("e1a08e");
    expect(caughtCode(() => observeRouteId("req_ABC12345", "unknown", "route-secret"))).toBe(
      "unknown_field_kind",
    );
  });
});

describe("CTRL-010 execution-snapshot contract vectors", () => {
  it.each(fixture.executionSnapshot.successes)(
    "accepts the strict request-frozen success vector $name",
    ({ value }) => {
      expect(() => validateExecutionSnapshot(value)).not.toThrow();
    },
  );

  it.each(fixture.executionSnapshot.errors)("accepts error result $reason", (value) => {
    expect(() => validateExecutionSnapshot(value)).not.toThrow();
  });

  it("distinguishes an omitted optional cache-write component from an explicit free component", () => {
    const deepseekComponents = fixture.executionSnapshot.successes[0].value.priceSnapshot.components;
    const mimoComponents = fixture.executionSnapshot.successes[1].value.priceSnapshot.components;

    expect(Object.hasOwn(deepseekComponents, "input_cache_write")).toBe(false);
    expect(mimoComponents.input_cache_write).toBe("0");
  });

  it("rejects missing and extra keys in every result branch", () => {
    const missing = deepseekSuccess();
    delete missing.reservationId;
    expect(caughtCode(() => validateExecutionSnapshot(missing))).toBe("execution_success_keys");

    const extra = { ...deepseekSuccess(), provider: "deepseek" };
    expect(caughtCode(() => validateExecutionSnapshot(extra))).toBe("execution_success_keys");

    const errorExtra = { ...fixture.executionSnapshot.errors[0], detail: "hidden" };
    expect(caughtCode(() => validateExecutionSnapshot(errorExtra))).toBe("execution_error_keys");

    const routeExtra = deepseekSuccess();
    requireRecord(routeExtra.routeSnapshot, "route").selectedAt = "2026-08-25T00:00:00Z";
    expect(caughtCode(() => validateExecutionSnapshot(routeExtra))).toBe("route_keys");

    const profileMissing = deepseekSuccess();
    delete requireRecord(profileMissing.profileExecutionConfig, "profile").config;
    expect(caughtCode(() => validateExecutionSnapshot(profileMissing))).toBe("profile_keys");

    const parameterExtra = deepseekSuccess();
    requireRecord(requireRecord(parameterExtra.priceSnapshot, "price").parameters, "parameters").rate =
      1;
    expect(caughtCode(() => validateExecutionSnapshot(parameterExtra))).toBe(
      "linear_parameters_keys",
    );
  });

  it("rejects numeric, null, noncanonical, and overflowing price components", () => {
    const cases: Array<{ expectedCode: string; value: unknown }> = [];

    const numeric = deepseekSuccess();
    requireRecord(requireRecord(numeric.priceSnapshot, "price").components, "components").output =
      4_500_000_000;
    cases.push({ expectedCode: "price_component_output", value: numeric });

    const nullable = deepseekSuccess();
    requireRecord(
      requireRecord(nullable.priceSnapshot, "price").components,
      "components",
    ).input_cache_write = null;
    cases.push({ expectedCode: "price_component_input_cache_write", value: nullable });

    const leadingZero = deepseekSuccess();
    requireRecord(
      requireRecord(leadingZero.priceSnapshot, "price").components,
      "components",
    ).output = "04500000000";
    cases.push({ expectedCode: "price_component_output", value: leadingZero });

    const overflow = deepseekSuccess();
    requireRecord(requireRecord(overflow.priceSnapshot, "price").components, "components").output =
      "9223372036854775808";
    cases.push({ expectedCode: "price_component_output", value: overflow });

    const missingRequired = deepseekSuccess();
    delete requireRecord(
      requireRecord(missingRequired.priceSnapshot, "price").components,
      "components",
    ).output;
    cases.push({ expectedCode: "price_required_component", value: missingRequired });

    const unknownComponent = deepseekSuccess();
    requireRecord(
      requireRecord(unknownComponent.priceSnapshot, "price").components,
      "components",
    ).reasoning = "0";
    cases.push({ expectedCode: "price_component_keys", value: unknownComponent });

    for (const testCase of cases) {
      expect(caughtCode(() => validateExecutionSnapshot(testCase.value))).toBe(
        testCase.expectedCode,
      );
    }
  });

  it("rejects route, price, profile, calculator, and legal cross-object drift", () => {
    const routePriceDrift = deepseekSuccess();
    requireRecord(routePriceDrift.routeSnapshot, "route").priceVersionId =
      "22222222-2222-4222-8222-222222222222";
    expect(caughtCode(() => validateExecutionSnapshot(routePriceDrift))).toBe(
      "route_price_binding",
    );

    const profileAliasDrift = deepseekSuccess();
    requireRecord(profileAliasDrift.profileExecutionConfig, "profile").endpointAlias =
      "mimo_cn_official";
    expect(caughtCode(() => validateExecutionSnapshot(profileAliasDrift))).toBe(
      "profile_registry_mismatch",
    );

    const routeModelDrift = deepseekSuccess();
    requireRecord(routeModelDrift.routeSnapshot, "route").modelId = "mimo-v2.5-pro";
    expect(caughtCode(() => validateExecutionSnapshot(routeModelDrift))).toBe(
      "route_profile_modelId",
    );

    const calculatorDrift = deepseekSuccess();
    requireRecord(calculatorDrift.priceSnapshot, "price").calculatorKind = "openai_gpt56_v1";
    expect(caughtCode(() => validateExecutionSnapshot(calculatorDrift))).toBe(
      "price_calculator",
    );

    const legalDrift = deepseekSuccess();
    requireRecord(legalDrift.routeSnapshot, "route").legalBundleVersion = "unknown-bundle";
    expect(caughtCode(() => validateExecutionSnapshot(legalDrift))).toBe(
      "legal_bundle_unknown",
    );
  });

  it("rejects malformed route scalars and unknown error vocabulary", () => {
    const leadingGenerationZero = deepseekSuccess();
    requireRecord(leadingGenerationZero.routeSnapshot, "route").configGeneration = "042";
    expect(caughtCode(() => validateExecutionSnapshot(leadingGenerationZero))).toBe(
      "route_generation",
    );

    const uppercaseHash = deepseekSuccess();
    requireRecord(uppercaseHash.routeSnapshot, "route").runtimeContractSha256 = "A".repeat(64);
    expect(caughtCode(() => validateExecutionSnapshot(uppercaseHash))).toBe(
      "route_runtime_hash",
    );

    const unknownReason = {
      schemaVersion: "ai_polish_execution_snapshot_v1",
      ok: false,
      reason: "AI_DISABLED",
    };
    expect(caughtCode(() => validateExecutionSnapshot(unknownReason))).toBe("execution_reason");
  });
});
