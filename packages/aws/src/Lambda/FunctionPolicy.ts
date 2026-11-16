import type { ResourceBinding } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { PolicyStatement } from "../IAM/Policy.ts";

export const LambdaRolePolicyMaxBytes = 10_240;

const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, stable(v)]),
        )
      : value;
const key = (value: unknown) => JSON.stringify(stable(value));
const strings = (value: string | readonly string[]) =>
  [...new Set(typeof value === "string" ? [value] : value)].sort();

/**
 * Compact resolved identity statements without changing any action/resource pair.
 * Only positive Action/Resource statements merge. All other selectors must match;
 * in particular NotAction/NotResource and principals are never discarded.
 * The first canonical Sid labels a merged statement; Sids do not grant permissions.
 * @internal
 */
export const compactFunctionPolicy = (
  statements: readonly PolicyStatement[],
): PolicyStatement[] => {
  const normalized = statements
    .map((statement) => ({
      ...statement,
      ...(statement.Sid === undefined ? {} : { Sid: statement.Sid.replace(/[^A-Za-z0-9]+/gi, "") }),
      ...(statement.Action === undefined ? {} : { Action: strings(statement.Action) }),
      ...(statement.Resource === undefined ? {} : { Resource: strings(statement.Resource) }),
    }))
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const unique = [...new Map(normalized.map((statement) => [key(statement), statement])).values()];
  const merge = (input: PolicyStatement[], field: "Action" | "Resource") => {
    const groups = new Map<string, PolicyStatement>();
    for (const statement of input) {
      if (
        !statement.Action ||
        !statement.Resource ||
        statement.NotAction ||
        statement.NotResource
      ) {
        groups.set(`opaque:${key(statement)}`, statement);
        continue;
      }
      const identity = Object.fromEntries(
        Object.entries(statement).filter(([k]) => k !== field && k !== "Sid"),
      );
      const groupKey = `merge:${key(identity)}`;
      const previous = groups.get(groupKey);
      groups.set(
        groupKey,
        previous
          ? {
              ...previous,
              [field]: strings([...strings(previous[field]!), ...strings(statement[field]!)]),
            }
          : statement,
      );
    }
    return [...groups.values()];
  };
  return merge(merge(unique, "Resource"), "Action")
    .map((s) => stable(s) as PolicyStatement)
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
};

export const functionBindingStatements = (
  bindings: readonly (ResourceBinding<{ policyStatements?: PolicyStatement[] }> & {
    action?: string;
  })[],
) =>
  bindings
    .filter((binding) => binding.action !== "delete")
    .flatMap((binding) => binding.data?.policyStatements ?? []);

export const functionLogGroupGuard = (region: string, accountId: string, functionName: string) =>
  JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Deny",
        Action: "logs:CreateLogGroup",
        Resource: `arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/${functionName}:*`,
      },
    ],
  });

export class LambdaRolePolicyTooLarge extends Data.TaggedError("LambdaRolePolicyTooLarge")<{
  roleName: string;
  sizeBytes: number;
  limitBytes: number;
}> {
  override get message() {
    return `Lambda execution role ${this.roleName} requires ${this.sizeBytes} inline-policy bytes after compaction (including its log-group guard); limit is ${this.limitBytes}. Reduce binding permissions or use an explicitly designed managed-policy split.`;
  }
}

/** Render the two Alchemy-owned inline policies against their aggregate budget. @internal */
export const renderFunctionPolicy = (
  roleName: string,
  statements: readonly PolicyStatement[],
  guard: string,
) =>
  Effect.gen(function* () {
    const compacted = compactFunctionPolicy(statements);
    const document =
      compacted.length === 0
        ? undefined
        : JSON.stringify({ Version: "2012-10-17", Statement: compacted });
    const sizeBytes =
      new TextEncoder().encode(document ?? "").byteLength +
      new TextEncoder().encode(guard).byteLength;
    if (sizeBytes > LambdaRolePolicyMaxBytes)
      return yield* new LambdaRolePolicyTooLarge({
        roleName,
        sizeBytes,
        limitBytes: LambdaRolePolicyMaxBytes,
      });
    return { document, sizeBytes };
  });
