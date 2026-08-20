import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { deepEqual, havePropsChanged } from "../Diff.ts";
import * as Output from "../Output.ts";
import { isPlainData } from "../Util/data.ts";

const DEFAULT_MAX_VALUE_LENGTH = 120;
// Engine equality treats {} like { x: undefined }, but [] differs from
// [undefined]. Separate sentinels preserve object-key and array-index absence.
const MISSING = Symbol("missing property");
const OMITTED_PROPERTY = Symbol("omitted property");

export type PropertyValue =
  | {
      kind: "literal";
      value: string | number | boolean | null;
      truncated?: true;
    }
  | { kind: "undefined" }
  | { kind: "redacted" }
  | { kind: "known-after-apply" }
  | { kind: "computed" }
  | { kind: "collection"; collection: "array" | "object" }
  | { kind: "opaque" };

export interface PropertyChange {
  kind: "add" | "remove" | "update";
  path: string;
  before?: PropertyValue;
  after?: PropertyValue;
}

export interface PropertyDiffOptions {
  maxValueLength?: number;
}

export interface FormattedPropertyChange {
  kind: "add" | "remove" | "update";
  path: string;
  before: string;
  after: string;
  beforeValue?: PropertyValue;
  afterValue?: PropertyValue;
}

export interface PropertyDiffLayout {
  columns: number;
}

export const NOT_SET_PROPERTY_VALUE = "(not set)";
export const MIN_INLINE_PROPERTY_DIFF_COLUMNS = 96;

/**
 * Diff previously persisted declared input props against the currently
 * desired input props already carried by a plan node. This is not a live
 * cloud-drift comparison. The walk is limited to plain data and never
 * evaluates deferred values.
 */
export const diffDeclaredProperties = (
  oldProps: unknown,
  newProps: unknown,
  options: PropertyDiffOptions = {},
): PropertyChange[] => {
  const maxValueLength = Math.max(
    0,
    options.maxValueLength ?? DEFAULT_MAX_VALUE_LENGTH,
  );
  const changes: PropertyChange[] = [];
  // Track current ancestor paths instead of all visited objects: cycles stop
  // safely, while shared objects are still diffed at every declared path.
  const oldAncestors = new WeakSet<object>();
  const newAncestors = new WeakSet<object>();

  const record = (change: PropertyChange) => changes.push(change);

  const walk = (oldValue: unknown, newValue: unknown, path: string): void => {
    // Keep the two absence kinds separate until equality is decided: a missing
    // object key and an out-of-range array index do not serialize the same way.
    const oldMissing = oldValue === MISSING;
    const newMissing = newValue === MISSING;
    const oldOmitted = oldValue === OMITTED_PROPERTY;
    const newOmitted = newValue === OMITTED_PROPERTY;
    // Example: {} -> { x: undefined } is not a declared change, while the
    // equivalent array case is handled below as an added index.
    if (
      (oldOmitted && (newOmitted || newValue === undefined)) ||
      (newOmitted && oldValue === undefined) ||
      (oldMissing && newMissing)
    ) {
      return;
    }
    // From here both sentinels mean "not set" for add/remove classification.
    const oldAbsent = oldMissing || oldOmitted;
    const newAbsent = newMissing || newOmitted;
    // Only arrays and plain objects are safe to recurse into. Date, Effect,
    // Output, SDK objects, and class instances remain leaves.
    const oldPlain = !oldAbsent && isPlainData(oldValue);
    const newPlain = !newAbsent && isPlainData(newValue);
    // Example: value.self = value must stop at self instead of producing
    // self.self.self forever.
    const oldCycle = oldPlain && oldAncestors.has(oldValue as object);
    const newCycle = newPlain && newAncestors.has(newValue as object);
    // Matching cycles cannot contain a serializable child difference here.
    if (oldCycle && newCycle) return;
    // If only one side cycles, report that path opaquely rather than walking an
    // unsafe structure or pretending both sides match.
    if (oldCycle || newCycle) {
      record(makeChange(oldValue, newValue, path, maxValueLength));
      return;
    }
    // Example: 512 -> 512 stops here. Equal plain containers still need a walk
    // so a nested Output or Redacted value is classified at its declared path.
    if (
      !oldAbsent &&
      !newAbsent &&
      !oldPlain &&
      !newPlain &&
      valuesEqual(oldValue, newValue)
    ) {
      return;
    }
    // Arrays pair with arrays and objects with objects. A change from [] to {}
    // is one container update, not a comparison between indexes and keys.
    const sameCollectionKind =
      oldPlain &&
      newPlain &&
      Array.isArray(oldValue) === Array.isArray(newValue);

    // When a container is added or removed, walk its children so { a: 1 }
    // becomes a change at a instead of an unhelpful change at the whole object.
    if (
      (sameCollectionKind || oldAbsent || newAbsent) &&
      (oldPlain || newPlain)
    ) {
      const collection = (oldPlain ? oldValue : newValue) as
        | Record<string, unknown>
        | unknown[];
      if (oldPlain) oldAncestors.add(oldValue as object);
      if (newPlain) newAncestors.add(newValue as object);
      // An added/removed container may contain only undefined-equivalent
      // leaves. Report the container if its walk produces no child changes.
      try {
        if (Array.isArray(collection)) {
          // Arrays intentionally diff by index; move/LCS inference is out of scope.
          const oldArray = Array.isArray(oldValue) ? oldValue : [];
          const newArray = Array.isArray(newValue) ? newValue : [];
          const length = Math.max(oldArray.length, newArray.length);
          const before = changes.length;
          // An empty added array has no child index that could carry its change.
          if (length === 0 && (oldAbsent || newAbsent)) {
            record(makeChange(oldValue, newValue, path, maxValueLength));
            return;
          }
          // Example: ["a"] -> ["a", "b"] compares [0], then adds [1].
          for (let index = 0; index < length; index++) {
            walk(
              index < oldArray.length ? oldArray[index] : MISSING,
              index < newArray.length ? newArray[index] : MISSING,
              appendIndex(path, index),
            );
          }
          // Example: adding [undefined] has a real array slot even if walking
          // its value produced no scalar change.
          if ((oldAbsent || newAbsent) && changes.length === before) {
            record(makeChange(oldValue, newValue, path, maxValueLength));
          }
          return;
        }

        const oldRecord = oldPlain ? (oldValue as Record<string, unknown>) : {};
        const newRecord = newPlain ? (newValue as Record<string, unknown>) : {};
        // The sorted key union makes { b: 1, a: 2 } render as a then b,
        // independently of construction or insertion order.
        const keys = [
          ...new Set([...Object.keys(oldRecord), ...Object.keys(newRecord)]),
        ].sort(compareStrings);
        const before = changes.length;
        // An empty added object has no child key that could carry its change.
        if (keys.length === 0 && (oldAbsent || newAbsent)) {
          record(makeChange(oldValue, newValue, path, maxValueLength));
          return;
        }
        // Example: { env: { MODE: "dev" } } builds the path env.MODE.
        for (const key of keys) {
          walk(
            Object.hasOwn(oldRecord, key) ? oldRecord[key] : OMITTED_PROPERTY,
            Object.hasOwn(newRecord, key) ? newRecord[key] : OMITTED_PROPERTY,
            appendKey(path, key),
          );
        }
        // Example: adding { config: { x: undefined } } still adds config as an
        // empty serialized object, even though x itself is omission-equivalent.
        if ((oldAbsent || newAbsent) && changes.length === before) {
          record(makeChange(oldValue, newValue, path, maxValueLength));
        }
        return;
      } finally {
        if (oldPlain) oldAncestors.delete(oldValue as object);
        if (newPlain) newAncestors.delete(newValue as object);
      }
    }

    // Scalars, opaque leaves, and collection-type changes end as one row here.
    record(makeChange(oldValue, newValue, path, maxValueLength));
  };

  walk(oldProps ?? {}, newProps ?? {}, "");
  return changes;
};

export const formatPropertyValue = (value: PropertyValue): string => {
  switch (value.kind) {
    case "literal":
      return typeof value.value === "string"
        ? JSON.stringify(value.value) + (value.truncated ? "…" : "")
        : String(value.value);
    case "undefined":
      return "undefined";
    case "redacted":
      return "(redacted)";
    case "known-after-apply":
      return "(known after apply)";
    case "computed":
      return "(computed)";
    case "collection":
      return value.collection === "array" ? "[…]" : "{…}";
    case "opaque":
      return "(opaque)";
  }
};

export const toFormattedPropertyChange = (
  change: PropertyChange,
): FormattedPropertyChange => ({
  kind: change.kind,
  path: change.path,
  before: change.before
    ? formatPropertyValue(change.before)
    : NOT_SET_PROPERTY_VALUE,
  after: change.after
    ? formatPropertyValue(change.after)
    : NOT_SET_PROPERTY_VALUE,
  beforeValue: change.before,
  afterValue: change.after,
});

export const propertyDiffLayout = (
  changes: FormattedPropertyChange[],
  columns: number,
): PropertyDiffLayout | undefined => {
  // Example: wide terminals show `old -> new` inline; narrow terminals return
  // no layout so the caller can stack the two values on separate lines.
  if (columns < MIN_INLINE_PROPERTY_DIFF_COLUMNS || changes.length === 0) {
    return undefined;
  }
  return { columns };
};

export const formatPropertyPath = (path: string): string =>
  truncatePropertyCell(path, 36);

export const fitPropertyChangeValues = (
  change: FormattedPropertyChange,
  layout: PropertyDiffLayout,
): { before: string; after: string } => {
  const valueColumns =
    layout.columns - formatPropertyPath(change.path).length - 6;
  const beforeWidth = Math.min(
    48,
    Math.max(1, Math.floor((valueColumns - 3) / 2)),
  );
  const before = truncatePropertyCell(change.before, beforeWidth);
  const after = truncatePropertyCell(
    change.after,
    Math.max(1, valueColumns - before.length - 3),
  );
  return { before, after };
};

export const fitCreatedPropertyValue = (
  change: FormattedPropertyChange,
  columns: number,
): string =>
  truncatePropertyCell(
    change.after,
    Math.max(1, columns - formatPropertyPath(change.path).length - 6),
  );

const truncatePropertyCell = (value: string, width: number): string =>
  value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;

const makeChange = (
  oldValue: unknown,
  newValue: unknown,
  path: string,
  maxValueLength: number,
): PropertyChange => {
  const oldMissing = oldValue === MISSING || oldValue === OMITTED_PROPERTY;
  const newMissing = newValue === MISSING || newValue === OMITTED_PROPERTY;
  // Example: missing -> 1 is add, 1 -> missing is remove, and 1 -> 2 is update.
  return {
    kind: oldMissing ? "add" : newMissing ? "remove" : "update",
    path: path || "(root)",
    before: oldMissing ? undefined : toPropertyValue(oldValue, maxValueLength),
    after: newMissing ? undefined : toPropertyValue(newValue, maxValueLength),
  };
};

const valuesEqual = (oldValue: unknown, newValue: unknown): boolean => {
  if (Output.isExpr(oldValue) || Output.isExpr(newValue)) {
    // Example: "old-id" -> resource.id stays changed and renders as
    // known-after-apply. Reuse the engine rule without resolving the Output.
    return (
      oldValue === newValue &&
      !havePropsChanged(
        { value: oldValue } as Record<string, unknown>,
        { value: newValue } as Record<string, unknown>,
      )
    );
  }
  if (
    Effect.isEffect(oldValue) ||
    Effect.isEffect(newValue) ||
    typeof oldValue === "function" ||
    typeof newValue === "function"
  ) {
    // Example: two references to the same callback are unchanged; different
    // callbacks are opaque changes. Neither callback or Effect is executed.
    return oldValue === newValue;
  }
  if (typeof oldValue === "bigint" || typeof newValue === "bigint") {
    // Example: 1n -> 2n must compare safely because JSON.stringify rejects BigInt.
    return oldValue === newValue;
  }
  // Scalars and safe leaves use the engine's existing equality semantics.
  return deepEqual(oldValue, newValue);
};

const toPropertyValue = (
  value: unknown,
  maxValueLength: number,
): PropertyValue => {
  // Order is security-sensitive: redact first, then recognize Outputs before
  // Effects because Output expressions are yieldable Effects.
  if (Redacted.isRedacted(value)) return { kind: "redacted" };
  if (Output.isExpr(value)) return { kind: "known-after-apply" };
  if (Effect.isEffect(value) || typeof value === "function") {
    return { kind: "computed" };
  }
  if (value === undefined) return { kind: "undefined" };
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return { kind: "literal", value };
  }
  if (typeof value === "string") {
    // Keep the complete change list, but bound an individual value such as a
    // large policy document so one row cannot dominate the terminal.
    return value.length > maxValueLength
      ? {
          kind: "literal",
          value: value.slice(0, maxValueLength),
          truncated: true,
        }
      : { kind: "literal", value };
  }
  if (isPlainData(value)) {
    return {
      kind: "collection",
      collection: Array.isArray(value) ? "array" : "object",
    };
  }
  return { kind: "opaque" };
};

const appendIndex = (path: string, index: number): string =>
  `${path}[${index}]`;

const appendKey = (path: string, key: string): string => {
  // Example: env.MODE uses dots, while env["feature.flag"] quotes a key whose
  // punctuation would otherwise make the path ambiguous.
  const segment = /^[A-Za-z_$][\w$]*$/.test(key)
    ? key
    : `[${JSON.stringify(key)}]`;
  if (!path) return segment;
  return segment.startsWith("[") ? `${path}${segment}` : `${path}.${segment}`;
};

const compareStrings = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
