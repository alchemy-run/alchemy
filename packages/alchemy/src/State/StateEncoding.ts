import * as Redacted from "effect/Redacted";
import { isResource } from "../Resource.ts";

/**
 * JSON marker used to tag a `Redacted<T>` value when writing state.
 * The reviver recognises objects with exactly this key and rebuilds
 * the `Redacted` wrapper on read.
 */
export const REDACTED_MARKER = "__redacted__";

/**
 * Recursively encode a state value for JSON serialisation.
 *
 * - `Redacted<T>` values are wrapped as `{ [REDACTED_MARKER]: <inner> }`
 *   so the actual string is persisted rather than the `<redacted>`
 *   placeholder produced by the default `toJSON`.
 * - `Resource` instances are flattened to `{ id, type, props, attr }`
 *   so persisted state matches the schema used by the loader.
 * - Plain objects and arrays are walked structurally.
 */
export const encodeState = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (Redacted.isRedacted(value)) {
    return {
      [REDACTED_MARKER]: encodeState(Redacted.value(value)),
    };
  }
  if (isResource(value)) {
    return {
      id: value.LogicalId,
      type: value.Type,
      props: encodeState(value.Props),
      attr: encodeState(value.Attributes),
    };
  }
  if (Array.isArray(value)) return value.map(encodeState);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = encodeState(v);
    }
    return result;
  }
  return value;
};

/**
 * JSON reviver that rebuilds `Redacted<T>` values that were written
 * through {@link encodeState}. Intended for use with `JSON.parse`.
 */
export const reviveState = (_key: string, value: unknown): unknown => {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    REDACTED_MARKER in value
  ) {
    return Redacted.make((value as Record<string, unknown>)[REDACTED_MARKER]);
  }
  return value;
};

/**
 * Recursively walk an already-decoded value and rebuild `Redacted<T>`
 * instances from `{ [REDACTED_MARKER]: <inner> }` envelopes. Mirror
 * image of {@link encodeState} for callers that hold a parsed JS
 * value rather than a JSON string (e.g. the HTTP state-store client,
 * which receives values pre-parsed by `HttpApiClient`).
 */
export const reviveStateRecursive = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(reviveStateRecursive);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] === REDACTED_MARKER) {
    return Redacted.make(reviveStateRecursive(obj[REDACTED_MARKER]));
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = reviveStateRecursive(v);
  }
  return result;
};
