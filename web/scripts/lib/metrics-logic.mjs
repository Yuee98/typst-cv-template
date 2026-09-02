/** Pure/testable helpers used by the manual AI metrics command. */

export const DEFAULT_PAGE_SIZE = 1000;

const REQUEST_STATUSES = [
  "succeeded",
  "canceled",
  "failed_upstream",
  "invalid_output",
  "released",
  "abandoned",
];
const ATTEMPT_STATUSES = [
  "succeeded",
  "invalid_output",
  "failed_upstream",
  "timed_out",
  "canceled",
  "unknown",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const SAFE_TOKEN = /^[a-z0-9][a-z0-9._-]{0,199}$/u;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const URI_SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const MAX_PG_BIGINT = 9223372036854775807n;
const MAX_LATENCY_MS = 2147483647;
const ROUTE_SCHEMA = "route_snapshot_v1";
const LEGACY_ROUTE = "legacy_v1";
const LEGACY_PRICING_ROUTE = "legacy_pricing_v1";
const ROUTE_TUPLE_FIELDS = [
  "route_schema_version",
  "config_generation",
  "routing_policy_version_id",
  "profile_version_id",
  "price_version_id",
  "legal_bundle_version",
  "runtime_contract_id",
  "gateway_kind",
  "model_id",
  "wire_api_kind",
  "display_disclosure_key",
  "billing_currency",
];

function safeUuid(value) {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function safeCurrency(value) {
  return typeof value === "string" && CURRENCY.test(value) ? value : null;
}

function safeToken(value) {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : null;
}

function safeModel(value) {
  return typeof value === "string"
    && SAFE_MODEL.test(value)
    && !URI_SCHEME_PREFIX.test(value)
    ? value
    : null;
}

function decimal(value) {
  if (typeof value === "bigint") return value >= 0n && value <= MAX_PG_BIGINT ? value : null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === "string" && value.length <= 19 && DECIMAL.test(value)) {
    try {
      const parsed = BigInt(value);
      return parsed <= MAX_PG_BIGINT ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function routeKind(row) {
  // A null schema is deliberately an un-dimensioned legacy fallback. The
  // historical pricing route is different: its immutable profile/price and
  // currency binding are retained so its cost remains attributable.
  if (row.route_schema_version === "legacy_pricing_v1") {
    const legacyFields = [
      "config_generation",
      "routing_policy_version_id",
      "runtime_contract_id",
      "legal_bundle_version",
      "gateway_kind",
      "model_id",
      "wire_api_kind",
      "display_disclosure_key",
    ];
    if (legacyFields.every((field) => row[field] === null || row[field] === undefined)
      && safeUuid(row.profile_version_id) !== null
      && safeUuid(row.price_version_id) !== null
      && safeCurrency(row.billing_currency) !== null) return LEGACY_PRICING_ROUTE;
    return "unexpected_route";
  }
  if (row.route_schema_version === null) {
    const legacyFields = [
      "config_generation",
      "routing_policy_version_id",
      "profile_version_id",
      "price_version_id",
      "legal_bundle_version",
      "runtime_contract_id",
      "gateway_kind",
      "model_id",
      "wire_api_kind",
      "display_disclosure_key",
    ];
    if (legacyFields.every((field) => row[field] === null || row[field] === undefined)) return LEGACY_ROUTE;
    return "unexpected_route";
  }
  if (row.route_schema_version === ROUTE_SCHEMA
    && decimal(row.config_generation) !== null
    && safeUuid(row.routing_policy_version_id) !== null
    && safeUuid(row.profile_version_id) !== null
    && safeUuid(row.price_version_id) !== null
    && safeToken(row.legal_bundle_version) !== null
    && safeToken(row.runtime_contract_id) !== null
    && gatewayDimension(row.gateway_kind) !== null
    && safeModel(row.model_id) !== null
    && ["chat_completions_v1", "responses_v1"].includes(row.wire_api_kind)
    && safeToken(row.display_disclosure_key) !== null
    && safeCurrency(row.billing_currency) !== null) {
    return ROUTE_SCHEMA;
  }
  return "unexpected_route";
}

function gatewayDimension(value) {
  return ["direct_deepseek", "direct_mimo", "openrouter"].includes(value)
    ? value
    : null;
}

function groupKey(row) {
  if (routeKind(row) === LEGACY_ROUTE) {
    return {
      routeSchemaVersion: LEGACY_ROUTE,
      configGeneration: null,
      profileVersionId: null,
      routingPolicyVersionId: null,
      priceVersionId: null,
      legalBundleVersion: null,
      runtimeContractId: null,
      gatewayKind: null,
      modelId: null,
      wireApiKind: null,
      displayDisclosureKey: null,
      currency: null,
    };
  }
  if (routeKind(row) === LEGACY_PRICING_ROUTE) {
    return {
      routeSchemaVersion: LEGACY_PRICING_ROUTE,
      profileVersionId: safeUuid(row.profile_version_id),
      routingPolicyVersionId: null,
      priceVersionId: safeUuid(row.price_version_id),
      runtimeContractId: null,
      gatewayKind: null,
      currency: safeCurrency(row.billing_currency),
    };
  }
  if (routeKind(row) !== ROUTE_SCHEMA) {
    return {
      routeSchemaVersion: "unexpected_route",
      configGeneration: null,
      profileVersionId: null,
      routingPolicyVersionId: null,
      priceVersionId: null,
      legalBundleVersion: null,
      runtimeContractId: null,
      gatewayKind: null,
      modelId: null,
      wireApiKind: null,
      displayDisclosureKey: null,
      currency: null,
    };
  }
  return {
    routeSchemaVersion: ROUTE_SCHEMA,
    configGeneration: decimal(row.config_generation).toString(),
    profileVersionId: safeUuid(row.profile_version_id),
    routingPolicyVersionId: safeUuid(row.routing_policy_version_id),
    priceVersionId: safeUuid(row.price_version_id),
    legalBundleVersion: safeToken(row.legal_bundle_version),
    runtimeContractId: safeToken(row.runtime_contract_id),
    gatewayKind: gatewayDimension(row.gateway_kind),
    modelId: safeModel(row.model_id),
    wireApiKind: row.wire_api_kind,
    displayDisclosureKey: safeToken(row.display_disclosure_key),
    currency: safeCurrency(row.billing_currency),
  };
}

function boundedLatency(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_LATENCY_MS ? value : null;
}

function percentileValue(values, fraction) {
  if (values.length === 0) return null;
  const rank = Math.max(1, Math.ceil(fraction * values.length));
  return [...values].sort((left, right) => left - right)[rank - 1];
}

function serializeLatency(values) {
  return {
    knownCount: values.length,
    p50Ms: percentileValue(values, 0.5),
    p95Ms: percentileValue(values, 0.95),
  };
}

function routeTuple(row) {
  if (routeKind(row) === LEGACY_ROUTE) return [LEGACY_ROUTE];
  if (routeKind(row) === LEGACY_PRICING_ROUTE) {
    return [
      LEGACY_PRICING_ROUTE,
      row.profile_version_id,
      row.price_version_id,
      row.billing_currency,
    ];
  }
  if (routeKind(row) !== ROUTE_SCHEMA) return ["unexpected_route"];
  return ROUTE_TUPLE_FIELDS.map((field) => row[field] ?? null);
}

function sameRoute(left, right) {
  return JSON.stringify(routeTuple(left)) === JSON.stringify(routeTuple(right));
}

function newAccumulator(kind) {
  return {
    kind,
    total: 0,
    successCount: 0,
    retryCount: 0,
    statusCounts: Object.fromEntries(
      (kind === "request" ? REQUEST_STATUSES : ATTEMPT_STATUSES).map((status) => [status, 0]),
    ),
    usageIncompleteCount: 0,
    latencies: [],
    usage: {
      inputCacheReadTokens: 0n,
      inputCacheWriteTokens: 0n,
      inputStandardTokens: 0n,
      outputTokens: 0n,
      reasoningTokens: 0n,
      knownInputCacheReadCount: 0,
      knownInputCacheWriteCount: 0,
      knownInputStandardCount: 0,
      knownOutputCount: 0,
      knownReasoningCount: 0,
    },
    cost: {
      knownEstimatedNanos: 0n,
      estimatedNanos: 0n,
      providerReportedNanos: 0n,
      knownEstimatedCount: 0,
      estimatedCount: 0,
      providerReportedCount: 0,
      reconciliationCounts: {
        matched: 0,
        mismatch: 0,
        incomplete_usage: 0,
        not_available: 0,
        pending: 0,
        unknown: 0,
      },
    },
    groups: new Map(),
  };
}

function addRow(accumulator, row) {
  accumulator.total += 1;
  const status = typeof row.status === "string" ? row.status : "unknown";
  if (Object.hasOwn(accumulator.statusCounts, status)) accumulator.statusCounts[status] += 1;
  if (status === "succeeded") accumulator.successCount += 1;
  const retry = accumulator.kind === "request"
    ? decimal(row.attempt_count) !== null && decimal(row.attempt_count) > 1n
    : decimal(row.attempt_no) !== null && decimal(row.attempt_no) > 1n;
  if (retry) accumulator.retryCount += 1;
  if (row.usage_complete !== true) accumulator.usageIncompleteCount += 1;
  const latency = boundedLatency(row.latency_ms);
  if (latency !== null) accumulator.latencies.push(latency);

  const usageFields = [
    ["inputCacheReadTokens", row.input_cache_read_tokens ?? row.input_cached_tokens],
    ["inputCacheWriteTokens", row.input_cache_write_tokens],
    ["inputStandardTokens", row.input_standard_tokens ?? row.input_uncached_tokens],
    ["outputTokens", row.output_tokens],
    ["reasoningTokens", row.reasoning_tokens],
  ];
  const key = groupKey(row);
  for (const [name, value] of usageFields) {
    const parsed = decimal(value);
    if (parsed === null) continue;
    accumulator.usage[name] += parsed;
    const countName = `known${name.replace("Tokens", "")}Count`;
    accumulator.usage[countName] += 1;
  }

  const estimated = accumulator.kind === "request"
    ? row.known_estimated_cost_nanos ?? row.estimated_cost_nanos
    : row.estimated_cost_nanos;
  const estimatedParsed = decimal(estimated);
  if (estimatedParsed !== null && key.currency !== null) {
    accumulator.cost.knownEstimatedNanos += estimatedParsed;
    accumulator.cost.estimatedNanos += estimatedParsed;
    accumulator.cost.knownEstimatedCount += 1;
    accumulator.cost.estimatedCount += 1;
  }
  const reported = decimal(row.provider_reported_cost_nanos);
  const reportedCurrency = safeCurrency(row.provider_reported_currency);
  const reportedCurrencyMismatch = reported !== null
    && (key.currency === null || reportedCurrency !== key.currency);
  if (reported !== null && key.currency !== null && !reportedCurrencyMismatch) {
    accumulator.cost.providerReportedNanos += reported;
    accumulator.cost.providerReportedCount += 1;
  }
  const reconciliation = reportedCurrencyMismatch
    ? "unknown"
    : typeof row.cost_reconciliation_status === "string"
    ? row.cost_reconciliation_status
    : "unknown";
  if (Object.hasOwn(accumulator.cost.reconciliationCounts, reconciliation)) {
    accumulator.cost.reconciliationCounts[reconciliation] += 1;
  } else {
    accumulator.cost.reconciliationCounts.unknown += 1;
  }

  const groupId = JSON.stringify(key);
  let group = accumulator.groups.get(groupId);
  if (!group) {
    group = {
      key,
      requestCount: 0,
      attemptCount: 0,
      successCount: 0,
      retryCount: 0,
      usageIncompleteCount: 0,
      latencies: [],
      usage: {
        inputCacheReadTokens: 0n,
        inputCacheWriteTokens: 0n,
        inputStandardTokens: 0n,
        outputTokens: 0n,
        reasoningTokens: 0n,
      },
      cost: {
        knownEstimatedNanos: 0n,
        providerReportedNanos: 0n,
        reconciliationCounts: {
          matched: 0,
          mismatch: 0,
          incomplete_usage: 0,
          not_available: 0,
          pending: 0,
          unknown: 0,
        },
      },
    };
    accumulator.groups.set(groupId, group);
  }
  if (accumulator.kind === "request") group.requestCount += 1;
  else group.attemptCount += 1;
  if (status === "succeeded") group.successCount += 1;
  if (retry) group.retryCount += 1;
  if (row.usage_complete !== true) group.usageIncompleteCount += 1;
  if (latency !== null) group.latencies.push(latency);
  for (const [name, value] of usageFields) {
    const parsed = decimal(value);
    if (parsed !== null) group.usage[name] += parsed;
  }
  if (estimatedParsed !== null && key.currency !== null) {
    group.cost.knownEstimatedNanos += estimatedParsed;
  }
  if (reported !== null && key.currency !== null && !reportedCurrencyMismatch) {
    group.cost.providerReportedNanos += reported;
  }
  if (Object.hasOwn(group.cost.reconciliationCounts, reconciliation)) {
    group.cost.reconciliationCounts[reconciliation] += 1;
  } else {
    group.cost.reconciliationCounts.unknown += 1;
  }
}

function serializeAccumulator(accumulator) {
  const serializeUsage = (usage) => Object.fromEntries(
    Object.entries(usage).map(([key, value]) => [
      key,
      typeof value === "bigint" ? value.toString() : value,
    ]),
  );
  const costByCurrency = {};
  for (const group of accumulator.groups.values()) {
    const currency = group.key.currency;
    if (currency === null) continue;
    const current = costByCurrency[currency] ?? {
      knownEstimatedNanos: 0n,
      providerReportedNanos: 0n,
    };
    current.knownEstimatedNanos += group.cost.knownEstimatedNanos;
    current.providerReportedNanos += group.cost.providerReportedNanos;
    costByCurrency[currency] = current;
  }
  return {
    [accumulator.kind === "request" ? "totalRequests" : "totalAttempts"]: accumulator.total,
    successCount: accumulator.successCount,
    totalRetries: accumulator.retryCount,
    statusCounts: { ...accumulator.statusCounts },
    usageIncompleteCount: accumulator.usageIncompleteCount,
    latency: serializeLatency(accumulator.latencies),
    usage: serializeUsage(accumulator.usage),
    cost: {
      byCurrency: Object.fromEntries(
        Object.entries(costByCurrency).map(([currency, cost]) => [currency, {
          knownEstimatedNanos: cost.knownEstimatedNanos.toString(),
          providerReportedNanos: cost.providerReportedNanos.toString(),
        }]),
      ),
      reconciliationCounts: { ...accumulator.cost.reconciliationCounts },
    },
    groups: [...accumulator.groups.values()]
      .map((group) => {
        const { latencies, ...publicGroup } = group;
        return {
          ...publicGroup,
          latency: serializeLatency(latencies),
          usage: serializeUsage(group.usage),
          cost: {
            knownEstimatedNanos: group.cost.knownEstimatedNanos.toString(),
            providerReportedNanos: group.cost.providerReportedNanos.toString(),
            reconciliationCounts: { ...group.cost.reconciliationCounts },
          },
        };
      })
      .sort((left, right) => JSON.stringify(left.key).localeCompare(JSON.stringify(right.key))),
  };
}

/** Build disjoint request/attempt metrics from service-role ledger rows. */
export function buildMetrics({ requests = [], attempts = [] }) {
  const requestRows = requests.filter((row) => row?.state === "finalized");
  const attemptRows = attempts.filter((row) => row?.status && row.status !== "started");
  const requestAccumulator = newAccumulator("request");
  const attemptAccumulator = newAccumulator("attempt");
  requestRows.forEach((row) => addRow(requestAccumulator, row));
  attemptRows.forEach((row) => addRow(attemptAccumulator, row));

  const requestsByReservation = new Map(
    requestRows
      .filter((row) => typeof row.reservation_id === "string")
      .map((row) => [row.reservation_id, row]),
  );
  const unexpectedRequestReservations = new Set();
  let unexpectedRequestWithoutReservation = 0;
  let unexpectedAttemptCount = 0;
  for (const request of requestRows) {
    if (routeKind(request) !== "unexpected_route") continue;
    if (typeof request.reservation_id === "string") unexpectedRequestReservations.add(request.reservation_id);
    else unexpectedRequestWithoutReservation += 1;
  }
  for (const attempt of attemptRows) {
    if (routeKind(attempt) === "unexpected_route") unexpectedAttemptCount += 1;
  }
  for (const attempt of attemptRows) {
    const request = requestsByReservation.get(attempt.reservation_id);
    if (!request || !sameRoute(request, attempt)) {
      if (routeKind(attempt) !== "unexpected_route") unexpectedAttemptCount += 1;
      if (request) unexpectedRequestReservations.add(attempt.reservation_id);
    }
  }
  return {
    requestLevel: serializeAccumulator(requestAccumulator),
    attemptLevel: serializeAccumulator(attemptAccumulator),
    alerts: {
      unexpectedRoute: {
        requestCount: unexpectedRequestReservations.size + unexpectedRequestWithoutReservation,
        attemptCount: unexpectedAttemptCount,
      },
    },
  };
}

export async function collectAllPages(loadPage, pageSize = DEFAULT_PAGE_SIZE) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await loadPage(offset, offset + pageSize - 1);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + (row[field] ?? 0), 0);
}

function totals(rows) {
  return {
    inputCached: sum(rows, "input_cached_tokens"),
    inputUncached: sum(rows, "input_uncached_tokens"),
    output: sum(rows, "output_tokens"),
  };
}

function hasKnownUsage(row) {
  return (
    row.input_cached_tokens !== null ||
    row.input_uncached_tokens !== null ||
    row.output_tokens !== null
  );
}

function hasInputUsage(row) {
  return (row.input_cached_tokens ?? 0) + (row.input_uncached_tokens ?? 0) > 0;
}

export function summarizeTokenUsage(finalizedRows) {
  const known = finalizedRows.filter(hasKnownUsage);
  const complete = finalizedRows.filter((row) => row.usage_complete === true);
  const incompleteKnown = finalizedRows.filter(
    (row) => row.usage_complete !== true && hasKnownUsage(row),
  );
  const completeWithInput = complete.filter(hasInputUsage);
  const succeededCompleteWithInput = completeWithInput.filter(
    (row) => row.status === "succeeded",
  );

  return {
    known: { count: known.length, totals: totals(known) },
    complete: { count: complete.length, totals: totals(complete) },
    incompleteKnown: {
      count: incompleteKnown.length,
      totals: totals(incompleteKnown),
    },
    completeWithInput: {
      count: completeWithInput.length,
      totals: totals(completeWithInput),
    },
    succeededCompleteWithInput: {
      count: succeededCompleteWithInput.length,
      totals: totals(succeededCompleteWithInput),
    },
  };
}

export function classifyGlobalUsage(used, limit, alertThreshold = 0.8) {
  if (limit === 0 && used === 0) return { level: "disabled", ratio: null };
  const ratio = limit > 0 ? used / limit : Number.POSITIVE_INFINITY;
  if (ratio >= 1) return { level: "critical", ratio };
  if (ratio >= alertThreshold) return { level: "alert", ratio };
  return { level: "ok", ratio };
}
