export const ROUTING_RULES_V1_TIME_ZONE = "Asia/Shanghai" as const;

export interface RoutingRouteV1 {
  readonly profileVersionId: string;
  readonly priceVersionId: string;
}

export interface RoutingWindowV1 {
  readonly weekdays: ReadonlyArray<number>;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly route: RoutingRouteV1;
}

export interface RoutingRulesV1 {
  readonly schemaVersion: "routing_rules_v1";
  readonly defaultRoute: RoutingRouteV1;
  readonly windows: ReadonlyArray<RoutingWindowV1>;
}

export class RoutingRulesV1Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingRulesV1Error";
  }
}

const ROUTING_RULE_KEYS = ["schemaVersion", "defaultRoute", "windows"] as const;
const ROUTE_KEYS = ["profileVersionId", "priceVersionId"] as const;
const WINDOW_KEYS = ["weekdays", "startMinute", "endMinute", "route"] as const;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SHANGHAI_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: ROUTING_RULES_V1_TIME_ZONE,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const ISO_WEEKDAY_BY_LABEL: Readonly<Record<string, number>> = Object.freeze({
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
});

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RoutingRulesV1Error(`${path} must be an object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));

  if (unknown.length > 0 || missing.length > 0) {
    throw new RoutingRulesV1Error(
      `${path} keys mismatch (unknown: ${unknown.join(",") || "none"}; missing: ${missing.join(",") || "none"})`,
    );
  }
}

function parseRoute(value: unknown, path: string): RoutingRouteV1 {
  assertRecord(value, path);
  assertExactKeys(value, ROUTE_KEYS, path);

  for (const key of ROUTE_KEYS) {
    if (typeof value[key] !== "string" || !CANONICAL_UUID.test(value[key])) {
      throw new RoutingRulesV1Error(`${path}.${key} must be a canonical UUID`);
    }
  }

  return Object.freeze({
    profileVersionId: value.profileVersionId as string,
    priceVersionId: value.priceVersionId as string,
  });
}

function parseWeekdays(value: unknown, path: string): ReadonlyArray<number> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RoutingRulesV1Error(`${path} must be a non-empty array`);
  }

  const weekdays: number[] = [];
  const seen = new Set<number>();
  for (const weekday of value) {
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      throw new RoutingRulesV1Error(`${path} must contain only ISO weekdays 1 through 7`);
    }
    if (seen.has(weekday)) {
      throw new RoutingRulesV1Error(`${path} must not contain duplicate weekdays`);
    }
    seen.add(weekday);
    weekdays.push(weekday);
  }

  return Object.freeze(weekdays);
}

function parseWindow(value: unknown, index: number): RoutingWindowV1 {
  const path = `routing rules.windows[${index}]`;
  assertRecord(value, path);
  assertExactKeys(value, WINDOW_KEYS, path);

  if (!Number.isInteger(value.startMinute) || !Number.isInteger(value.endMinute)) {
    throw new RoutingRulesV1Error(`${path} minute boundaries must be integers`);
  }

  const startMinute = value.startMinute as number;
  const endMinute = value.endMinute as number;
  if (startMinute < 0 || startMinute >= endMinute || endMinute > 1440) {
    throw new RoutingRulesV1Error(
      `${path} must satisfy 0 <= startMinute < endMinute <= 1440`,
    );
  }

  return Object.freeze({
    weekdays: parseWeekdays(value.weekdays, `${path}.weekdays`),
    startMinute,
    endMinute,
    route: parseRoute(value.route, `${path}.route`),
  });
}

function windowsOverlap(left: RoutingWindowV1, right: RoutingWindowV1): boolean {
  const shareWeekday = left.weekdays.some((weekday) => right.weekdays.includes(weekday));
  return shareWeekday && left.startMinute < right.endMinute && right.startMinute < left.endMinute;
}

/**
 * Strictly validate and detach JSON routing rules from their caller-owned input.
 * The returned graph is deeply frozen so later caller mutation cannot change a
 * previously validated policy.
 */
export function validateRoutingRulesV1(value: unknown): RoutingRulesV1 {
  const path = "routing rules";
  assertRecord(value, path);
  assertExactKeys(value, ROUTING_RULE_KEYS, path);

  if (value.schemaVersion !== "routing_rules_v1") {
    throw new RoutingRulesV1Error(`${path}.schemaVersion must be routing_rules_v1`);
  }
  if (!Array.isArray(value.windows)) {
    throw new RoutingRulesV1Error(`${path}.windows must be an array`);
  }
  if (value.windows.length > 32) {
    throw new RoutingRulesV1Error(`${path}.windows must contain at most 32 entries`);
  }

  const windows = value.windows.map((window, index) => parseWindow(window, index));
  for (let left = 0; left < windows.length; left += 1) {
    for (let right = left + 1; right < windows.length; right += 1) {
      if (windowsOverlap(windows[left], windows[right])) {
        throw new RoutingRulesV1Error(
          `${path}.windows[${left}] overlaps ${path}.windows[${right}]`,
        );
      }
    }
  }

  return Object.freeze({
    schemaVersion: "routing_rules_v1",
    defaultRoute: parseRoute(value.defaultRoute, `${path}.defaultRoute`),
    windows: Object.freeze(windows),
  });
}

function shanghaiWeekdayAndMinute(at: Date): { weekday: number; minute: number } {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    throw new RoutingRulesV1Error("routing timestamp must be a valid explicit Date");
  }

  const parts = SHANGHAI_CLOCK.formatToParts(new Date(at.getTime()));
  const weekdayLabel = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const weekday = weekdayLabel === undefined ? undefined : ISO_WEEKDAY_BY_LABEL[weekdayLabel];

  if (weekday === undefined || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new RoutingRulesV1Error("could not resolve routing timestamp in Asia/Shanghai");
  }

  return { weekday, minute: hour * 60 + minute };
}

/**
 * Select a target using only caller-supplied inputs. The function never reads a
 * wall clock and v1 intentionally supports only the frozen Asia/Shanghai policy
 * timezone.
 */
export function selectRoutingRouteV1(
  value: unknown,
  at: Date,
  policyTimeZone: string,
): RoutingRouteV1 {
  if (policyTimeZone !== ROUTING_RULES_V1_TIME_ZONE) {
    throw new RoutingRulesV1Error(
      `routing_rules_v1 requires policy timezone ${ROUTING_RULES_V1_TIME_ZONE}`,
    );
  }

  const rules = validateRoutingRulesV1(value);
  const { weekday, minute } = shanghaiWeekdayAndMinute(at);
  const matchingWindow = rules.windows.find(
    (window) =>
      window.weekdays.includes(weekday) &&
      window.startMinute <= minute &&
      minute < window.endMinute,
  );

  return matchingWindow?.route ?? rules.defaultRoute;
}
