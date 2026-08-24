import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { havePropsChanged } from "../Diff.ts";
import * as Output from "../Output.ts";
import { isPlainData } from "../Util/data.ts";
import { stringify } from "yaml";

export type YamlDisplayValue =
  | string
  | number
  | boolean
  | null
  | YamlDisplayValue[]
  | { readonly [key: string]: YamlDisplayValue };

export interface DeclaredPropertyYaml {
  readonly kind: "create" | "change";
  readonly lines: ReadonlyArray<string>;
}

const REDACTED = "(redacted)";
const KNOWN_AFTER_APPLY = "(known after apply)";
const COMPUTED = "(computed)";
const UNDEFINED = "(undefined)";
const OPAQUE = "(opaque)";
const CIRCULAR = "(circular)";

/**
 * Turn arbitrary declared inputs or persisted state into safe, deterministic
 * plain data for terminal display. Deferred values are described, never run,
 * and Redacted values are replaced before their contents can reach YAML.
 */
export const toYamlDisplayValue = (
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
): YamlDisplayValue => {
  // Output expressions are Effects too, so this order is security-sensitive.
  if (Redacted.isRedacted(value)) return REDACTED;
  if (Output.isExpr(value)) return KNOWN_AFTER_APPLY;
  if (Effect.isEffect(value) || typeof value === "function") return COMPUTED;
  if (value === undefined) return UNDEFINED;
  if (value === null || typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (!isPlainData(value)) return OPAQUE;
  if (ancestors.has(value)) return CIRCULAR;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => toYamlDisplayValue(item, ancestors));
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort((a, b) => a.localeCompare(b))
        .map((key) => [
          key,
          toYamlDisplayValue(
            (value as Record<string, unknown>)[key],
            ancestors,
          ),
        ]),
    );
  } finally {
    ancestors.delete(value);
  }
};

/** Format a value as stable, unadorned YAML lines for terminal renderers. */
export const formatYamlLines = (value: unknown): string[] => {
  const yaml = stringify(toYamlDisplayValue(value), {
    lineWidth: 0,
    sortMapEntries: true,
  });
  return (yaml || `${UNDEFINED}\n`).trimEnd().split("\n");
};

/**
 * Build the detailed property document for a plan resource. This compares
 * persisted declared props to desired declared props; it is not cloud drift.
 */
export const formatDeclaredPropertyYaml = (
  oldProps: unknown,
  newProps: unknown,
  action: "create" | "update" | "replace",
): DeclaredPropertyYaml | undefined => {
  const desired = newProps ?? {};
  if (action === "create") {
    return {
      kind: "create",
      lines: ["properties:", ...indent(formatYamlLines(desired))],
    };
  }
  if (
    !havePropsChanged(
      (oldProps ?? {}) as Record<string, unknown>,
      desired as Record<string, unknown>,
    )
  ) {
    return undefined;
  }
  return {
    kind: "change",
    lines: [
      "before:",
      ...indent(formatYamlLines(oldProps ?? {})),
      "after:",
      ...indent(formatYamlLines(desired)),
    ],
  };
};

const indent = (lines: ReadonlyArray<string>): string[] =>
  lines.map((line) => `  ${line}`);
