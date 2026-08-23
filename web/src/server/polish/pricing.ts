import { ProviderRegistryError, resolveCalculator, type CalculatorKind } from "./adapter-registry";
import {
  InferenceV2ContractError,
  assertNormalizedUsageV2,
  type NormalizedUsageV2,
} from "./inference-v2";

export type PriceComponent =
  | "input_standard"
  | "input_cache_read"
  | "input_cache_write"
  | "output";

export interface MoneyNanosV1 {
  currency: string;
  nanos: string;
}

export interface FrozenPriceSnapshotV1 {
  schemaVersion: "price_snapshot_v1";
  priceVersionId: string;
  currency: string;
  calculatorKind: string;
  components: Partial<Record<PriceComponent, string>>;
  parameters: unknown;
}

export type CostCalculationIncompleteReason =
  | "invalid_usage"
  | "unknown_calculator"
  | "invalid_price_snapshot"
  | "missing_price_component"
  | "input_cache_write";

export type CostCalculationResultV1 =
  | {
      status: "complete";
      estimatedCost: MoneyNanosV1;
      incompleteReasons: [];
    }
  | {
      status: "incomplete_usage";
      estimatedCost: null;
      incompleteReasons: CostCalculationIncompleteReason[];
    };

type ParsedPriceSnapshot = Omit<FrozenPriceSnapshotV1, "calculatorKind" | "components"> & {
  calculatorKind: CalculatorKind;
  components: Partial<Record<PriceComponent, bigint>>;
  parameters:
    | Record<string, never>
    | {
        longContext: null | {
          thresholdInputTokens: number;
          inputMultiplierBps: number;
          outputMultiplierBps: number;
        };
      };
};

const COMPONENTS: readonly PriceComponent[] = [
  "input_standard",
  "input_cache_read",
  "input_cache_write",
  "output",
];
const ZERO_NANOS = BigInt(0);
const MAX_POSTGRES_BIGINT = BigInt("9223372036854775807");
const TOKENS_PER_MILLION = BigInt(1_000_000);
const BASIS_POINTS = BigInt(10_000);

export class PricingContractError extends Error {
  readonly reason: CostCalculationIncompleteReason;

  constructor(reason: CostCalculationIncompleteReason, message: string) {
    super(message);
    this.name = "PricingContractError";
    this.reason = reason;
  }
}

function assertRecord(
  value: unknown,
  reason: CostCalculationIncompleteReason,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PricingContractError(reason, `${label} must be an object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new PricingContractError(
      "invalid_price_snapshot",
      `${label} keys mismatch (unknown: ${unknown.join(",") || "none"}; missing: ${missing.join(",") || "none"})`,
    );
  }
}

function parseNanos(value: unknown, component: PriceComponent): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new PricingContractError(
      "invalid_price_snapshot",
      `${component} nanos_per_million must be a canonical non-negative decimal string`,
    );
  }
  const parsed = BigInt(value);
  if (parsed > MAX_POSTGRES_BIGINT) {
    throw new PricingContractError(
      "invalid_price_snapshot",
      `${component} nanos_per_million exceeds PostgreSQL bigint`,
    );
  }
  return parsed;
}

function assertPositiveSafeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new PricingContractError(
      "invalid_price_snapshot",
      `${field} must be a positive safe integer`,
    );
  }
}

function parseParameters(
  kind: CalculatorKind,
  value: unknown,
): ParsedPriceSnapshot["parameters"] {
  assertRecord(value, "invalid_price_snapshot", "price parameters");
  if (kind === "linear_token_v1") {
    assertExactKeys(value, [], "linear_token_v1 parameters");
    return {};
  }

  assertExactKeys(value, ["longContext"], "openai_gpt56_v1 parameters");
  if (value.longContext === null) {
    return { longContext: null };
  }
  assertRecord(value.longContext, "invalid_price_snapshot", "longContext");
  assertExactKeys(
    value.longContext,
    ["thresholdInputTokens", "inputMultiplierBps", "outputMultiplierBps"],
    "longContext",
  );
  assertPositiveSafeInteger(value.longContext.thresholdInputTokens, "thresholdInputTokens");
  assertPositiveSafeInteger(value.longContext.inputMultiplierBps, "inputMultiplierBps");
  assertPositiveSafeInteger(value.longContext.outputMultiplierBps, "outputMultiplierBps");
  return {
    longContext: {
      thresholdInputTokens: value.longContext.thresholdInputTokens,
      inputMultiplierBps: value.longContext.inputMultiplierBps,
      outputMultiplierBps: value.longContext.outputMultiplierBps,
    },
  };
}

/** Validate a DB price projection without accepting executable config from DB. */
export function validateFrozenPriceSnapshot(snapshot: FrozenPriceSnapshotV1): ParsedPriceSnapshot {
  if (snapshot.schemaVersion !== "price_snapshot_v1") {
    throw new PricingContractError("invalid_price_snapshot", "unknown price snapshot schemaVersion");
  }
  if (snapshot.priceVersionId.length === 0) {
    throw new PricingContractError("invalid_price_snapshot", "priceVersionId must not be empty");
  }
  if (!/^[A-Z]{3}$/.test(snapshot.currency)) {
    throw new PricingContractError(
      "invalid_price_snapshot",
      "currency must be an uppercase ISO-style three-letter code",
    );
  }

  let calculator: ReturnType<typeof resolveCalculator>;
  try {
    calculator = resolveCalculator(snapshot.calculatorKind);
  } catch (error) {
    if (error instanceof ProviderRegistryError) {
      throw new PricingContractError("unknown_calculator", error.message);
    }
    throw error;
  }

  assertRecord(snapshot.components, "invalid_price_snapshot", "price components");
  const unknownComponents = Object.keys(snapshot.components).filter(
    (component) => !COMPONENTS.includes(component as PriceComponent),
  );
  if (unknownComponents.length > 0) {
    throw new PricingContractError(
      "invalid_price_snapshot",
      `unknown price components: ${unknownComponents.join(",")}`,
    );
  }

  const parsedComponents: Partial<Record<PriceComponent, bigint>> = {};
  for (const component of COMPONENTS) {
    const value = snapshot.components[component];
    if (value !== undefined) {
      parsedComponents[component] = parseNanos(value, component);
    }
  }
  const missing = calculator.requiredComponents.filter(
    (component) => parsedComponents[component] === undefined,
  );
  if (missing.length > 0) {
    throw new PricingContractError(
      "missing_price_component",
      `missing required price components: ${missing.join(",")}`,
    );
  }

  return {
    ...snapshot,
    calculatorKind: calculator.kind,
    components: parsedComponents,
    parameters: parseParameters(calculator.kind, snapshot.parameters),
  };
}

function incomplete(reason: CostCalculationIncompleteReason): CostCalculationResultV1 {
  return {
    status: "incomplete_usage",
    estimatedCost: null,
    incompleteReasons: [reason],
  };
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator === ZERO_NANOS
    ? ZERO_NANOS
    : (numerator + denominator - BigInt(1)) / denominator;
}

function componentRate(snapshot: ParsedPriceSnapshot, component: PriceComponent): bigint {
  const value = snapshot.components[component];
  if (value === undefined) {
    throw new PricingContractError(
      "missing_price_component",
      `missing price component: ${component}`,
    );
  }
  return value;
}

function calculateLinear(
  usage: NormalizedUsageV2,
  snapshot: ParsedPriceSnapshot,
): CostCalculationResultV1 {
  let numerator =
    BigInt(usage.inputStandardTokens) * componentRate(snapshot, "input_standard") +
    BigInt(usage.inputCacheReadTokens) * componentRate(snapshot, "input_cache_read") +
    BigInt(usage.outputTokens) * componentRate(snapshot, "output");

  const writeRate = snapshot.components.input_cache_write;
  if (usage.inputCacheWriteTokens === null) {
    if (writeRate !== undefined && writeRate !== ZERO_NANOS) {
      return incomplete("input_cache_write");
    }
  } else if (usage.inputCacheWriteTokens > 0) {
    if (writeRate === undefined) {
      return incomplete("missing_price_component");
    }
    numerator += BigInt(usage.inputCacheWriteTokens) * writeRate;
  }

  return {
    status: "complete",
    estimatedCost: {
      currency: snapshot.currency,
      nanos: ceilDiv(numerator, TOKENS_PER_MILLION).toString(),
    },
    incompleteReasons: [],
  };
}

function calculateGptStyle(
  usage: NormalizedUsageV2,
  snapshot: ParsedPriceSnapshot,
): CostCalculationResultV1 {
  if (usage.inputCacheWriteTokens === null) {
    return incomplete("input_cache_write");
  }
  const parameters = snapshot.parameters as {
    longContext: null | {
      thresholdInputTokens: number;
      inputMultiplierBps: number;
      outputMultiplierBps: number;
    };
  };
  const longContext =
    parameters.longContext !== null &&
    usage.inputTotalTokens > parameters.longContext.thresholdInputTokens
      ? parameters.longContext
      : null;
  const inputMultiplier = BigInt(longContext?.inputMultiplierBps ?? 10_000);
  const outputMultiplier = BigInt(longContext?.outputMultiplierBps ?? 10_000);

  const inputNumerator =
    BigInt(usage.inputStandardTokens) * componentRate(snapshot, "input_standard") +
    BigInt(usage.inputCacheReadTokens) * componentRate(snapshot, "input_cache_read") +
    BigInt(usage.inputCacheWriteTokens) * componentRate(snapshot, "input_cache_write");
  const outputNumerator = BigInt(usage.outputTokens) * componentRate(snapshot, "output");
  const numerator =
    inputNumerator * inputMultiplier + outputNumerator * outputMultiplier;

  return {
    status: "complete",
    estimatedCost: {
      currency: snapshot.currency,
      nanos: ceilDiv(numerator, TOKENS_PER_MILLION * BASIS_POINTS).toString(),
    },
    incompleteReasons: [],
  };
}

/**
 * Calculate native-currency estimated cost from the reservation-frozen price
 * snapshot. Any unknown required fact returns null/incomplete instead of a
 * low estimate. Reasoning tokens are deliberately not added to output again.
 */
export function calculateEstimatedCost(
  usage: NormalizedUsageV2,
  frozenPrice: FrozenPriceSnapshotV1,
): CostCalculationResultV1 {
  try {
    assertNormalizedUsageV2(usage);
  } catch (error) {
    if (error instanceof InferenceV2ContractError) {
      return incomplete("invalid_usage");
    }
    throw error;
  }

  let snapshot: ParsedPriceSnapshot;
  try {
    snapshot = validateFrozenPriceSnapshot(frozenPrice);
  } catch (error) {
    if (error instanceof PricingContractError) {
      return incomplete(error.reason);
    }
    throw error;
  }

  if (snapshot.calculatorKind === "linear_token_v1") {
    return calculateLinear(usage, snapshot);
  }
  if (snapshot.calculatorKind === "openai_gpt56_v1") {
    return calculateGptStyle(usage, snapshot);
  }
  return incomplete("unknown_calculator");
}
