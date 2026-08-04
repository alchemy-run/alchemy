import * as Predicate from "effect/Predicate";
import * as EffectRecord from "effect/Record";
import * as Redacted from "effect/Redacted";

export type Primitive =
  | never
  | undefined
  | null
  | boolean
  | number
  | string
  | bigint
  | symbol;

export const isPrimitive = (value: any): value is Primitive =>
  value === undefined ||
  value === null ||
  typeof value === "boolean" ||
  typeof value === "number" ||
  typeof value === "string" ||
  typeof value === "symbol" ||
  typeof value === "bigint";

export const isPlainObject = (
  value: unknown,
): value is Record<string, unknown> => {
  if (!Predicate.isObject(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
};

/**
 * Is `value` plain data the engine's deep walkers may traverse — an array,
 * or an object whose prototype is `Object.prototype`/`null`?
 *
 * Everything else (class instances: effect's Effect/Layer/Context, Dates,
 * SDK config objects, functions, ...) is a LEAF for every deep walker in
 * the engine. The engine cannot meaningfully evaluate, diff, or persist
 * *through* a foreign class instance — rebuilding one entry-by-entry strips
 * its prototype — and walking one is not safe: effect ≥4.0.0-beta.103's
 * Context is self-referential (`cacheRoot` points back at itself), which
 * sent the naive walk-everything traversal into unbounded recursion
 * (#1082). Resources and Outputs are detected structurally *before* this
 * gate, so dependencies declared in plain props are unaffected.
 */
export const isPlainData = (
  value: unknown,
): value is Record<string, unknown> | unknown[] => {
  if (Array.isArray(value)) return true;
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export const stripFields = <T>(value: T, empty: null | undefined): T => {
  if (Array.isArray(value)) {
    return value.map((item) => stripFields(item, empty)) as T;
  }
  if (!isPlainObject(value)) return value;
  return EffectRecord.map(
    EffectRecord.filter(value, (entry) => entry !== empty),
    (entry) => stripFields(entry, empty),
  ) as T;
};

export const stripNullFields = <T>(value: T): T => stripFields(value, null);

export const stripUndefinedFields = <T>(value: T): T =>
  stripFields(value, undefined);

type UnwrapRedacted<T> =
  T extends Redacted.Redacted<infer U>
    ? U
    : T extends Record<string, any>
      ? { [K in keyof T]: UnwrapRedacted<T[K]> }
      : T extends Array<infer U>
        ? Array<UnwrapRedacted<U>>
        : T;

export const unwrapRedacted = <T>(value: T): UnwrapRedacted<T> => {
  if (Redacted.isRedacted(value)) {
    return Redacted.value(value) as UnwrapRedacted<T>;
  }
  if (Array.isArray(value)) {
    return value.map(unwrapRedacted) as UnwrapRedacted<T>;
  }
  if (!isPlainObject(value)) return value as UnwrapRedacted<T>;
  return EffectRecord.map(value, unwrapRedacted) as UnwrapRedacted<T>;
};
