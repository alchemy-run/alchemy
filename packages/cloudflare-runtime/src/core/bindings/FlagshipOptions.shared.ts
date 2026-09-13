/** Persistent local flag definition, mirroring the Flagship control plane. */
export interface FlagDefinition {
  key: string;
  accountId?: string;
  enabled: boolean;
  defaultVariation: string;
  variations: Record<string, unknown>;
  rules: Array<{
    priority: number;
    conditions: FlagCondition[];
    serveVariation: string;
    rollout?: { percentage: number; attribute?: string };
  }>;
}
export type FlagCondition =
  | { clauses: FlagCondition[]; logicalOperator: "AND" | "OR" }
  | { attribute: string; operator: string; value: unknown };
type Context = Record<string, string | number | boolean>;

const matches = (condition: FlagCondition, context: Context): boolean => {
  if ("clauses" in condition)
    return condition.logicalOperator === "AND"
      ? condition.clauses.every((clause) => matches(clause, context))
      : condition.clauses.some((clause) => matches(clause, context));
  const actual = context[condition.attribute];
  const expected = condition.value;
  if (actual === undefined) return false;
  switch (condition.operator) {
    case "equals":
      return actual === expected;
    case "not_equals":
      return actual !== expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "not_in":
      return Array.isArray(expected) && !expected.includes(actual);
    case "contains":
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        actual.includes(expected)
      );
    case "starts_with":
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        actual.startsWith(expected)
      );
    case "ends_with":
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        actual.endsWith(expected)
      );
    default: {
      const left =
        typeof actual === "number"
          ? actual
          : typeof actual === "string"
            ? Date.parse(actual)
            : NaN;
      const right =
        typeof expected === "number"
          ? expected
          : typeof expected === "string"
            ? Date.parse(expected)
            : NaN;
      if (
        !Number.isFinite(left) ||
        !Number.isFinite(right) ||
        typeof actual !== typeof expected
      )
        return false;
      switch (condition.operator) {
        case "greater_than":
          return left > right;
        case "less_than":
          return left < right;
        case "greater_than_or_equals":
          return left >= right;
        case "less_than_or_equals":
          return left <= right;
        default:
          return false;
      }
    }
  }
};

/**
 * Offline targeting evaluator. Rollouts use local FNV-1a bucketing: stable per
 * account/flag/attribute and shared across cumulative rules, but not guaranteed
 * to select the same users as Cloudflare's unpublished hash implementation.
 */
export const evaluateFlag = (
  flag: FlagDefinition | undefined,
  flagKey: string,
  fallback: unknown,
  type: string | undefined,
  context: Context = {},
) => {
  const error = (errorCode: string, errorMessage: string) => ({
    flagKey,
    value: fallback,
    reason: "ERROR",
    errorCode,
    errorMessage,
  });
  if (
    !context ||
    typeof context !== "object" ||
    Array.isArray(context) ||
    Object.values(context).some(
      (v) =>
        !["string", "number", "boolean"].includes(typeof v) ||
        (typeof v === "number" && !Number.isFinite(v)),
    )
  )
    return error(
      "INVALID_CONTEXT",
      "Context attributes must be strings, finite numbers, or booleans",
    );
  if (!flag) return error("FLAG_NOT_FOUND", `Flag ${flagKey} does not exist`);
  let variant = flag.defaultVariation;
  let reason = flag.enabled ? "DEFAULT" : "DISABLED";
  const buckets = new Map<string, number>();
  if (flag.enabled)
    for (const rule of [...flag.rules].sort(
      (a, b) => a.priority - b.priority,
    )) {
      if (!rule.conditions.every((condition) => matches(condition, context)))
        continue;
      if (rule.rollout) {
        const attribute = rule.rollout.attribute ?? "targetingKey";
        let bucket = buckets.get(attribute);
        if (bucket === undefined) {
          const identifier = context[attribute];
          if (identifier === undefined) bucket = Math.random() * 100;
          else {
            let hash = 2166136261;
            for (const char of JSON.stringify([
              flag.accountId,
              flag.key,
              identifier,
            ]))
              hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
            bucket = (hash / 4294967296) * 100;
          }
          buckets.set(attribute, bucket);
        }
        if (bucket >= rule.rollout.percentage) continue;
      }
      variant = rule.serveVariation;
      reason = rule.rollout ? "SPLIT" : "TARGETING_MATCH";
      break;
    }
  if (!Object.hasOwn(flag.variations, variant))
    return error("GENERAL", `Unknown variation ${variant}`);
  const value = flag.variations[variant];
  if (
    type &&
    (type === "object"
      ? value === null || typeof value !== "object"
      : typeof value !== type)
  )
    return error("TYPE_MISMATCH", `Flag ${flagKey} is not ${type}`);
  return { flagKey, value, variant, reason };
};
