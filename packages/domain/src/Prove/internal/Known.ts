import * as Array_ from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as BigInt_ from "effect/BigInt";
import * as Boolean_ from "effect/Boolean";
import * as Brand_ from "effect/Brand";
import * as ByteSize_ from "effect/ByteSize";
import * as Chunk_ from "effect/Chunk";
import * as Cron_ from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal_ from "effect/Equal";
import * as Equivalence_ from "effect/Equivalence";
import * as Filter_ from "effect/Filter";
import * as Formatter_ from "effect/Formatter";
import * as Glob_ from "effect/Glob";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Inspectable_ from "effect/Inspectable";
import * as Iterable_ from "effect/Iterable";
import * as JsonPatch_ from "effect/JsonPatch";
import * as JsonPointer_ from "effect/JsonPointer";
import * as LogLevel_ from "effect/LogLevel";
import * as Newtype_ from "effect/Newtype";
import * as NonEmptyIterable_ from "effect/NonEmptyIterable";
import * as Number_ from "effect/Number";
import * as Option from "effect/Option";
import * as Order_ from "effect/Order";
import * as Ordering_ from "effect/Ordering";
import * as Predicate_ from "effect/Predicate";
import * as PrimaryKey_ from "effect/PrimaryKey";
import * as Rational from "effect/Rational";
import * as Record_ from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as RegExp_ from "effect/RegExp";
import * as Result from "effect/Result";
import * as Schema_ from "effect/Schema";
import * as SemVer_ from "effect/SemVer";
import * as SemVerRange_ from "effect/SemVerRange";
import * as Stream from "effect/Stream";
import * as String_ from "effect/String";
import * as Struct_ from "effect/Struct";
import * as Symbol_ from "effect/Symbol";
import * as TextDiff_ from "effect/TextDiff";
import * as Trie_ from "effect/Trie";
import * as Tuple_ from "effect/Tuple";
import * as UndefinedOr_ from "effect/UndefinedOr";
import * as Brands from "./Brands.ts";
import type { V } from "./Value.ts";
import * as Value from "./Value.ts";

/**
 * The modules of Effect whose functions give the same result for the same
 * arguments, change nothing, and read nothing else. A function of one that
 * the prover has no model for is run as it is, on values the code writes.
 */
const PURE: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "effect/Array": Array_,
  "effect/BigDecimal": BigDecimal,
  "effect/BigInt": BigInt_,
  "effect/Boolean": Boolean_,
  "effect/Brand": Brand_,
  "effect/ByteSize": ByteSize_,
  "effect/Chunk": Chunk_,
  "effect/Cron": Cron_,
  "effect/Duration": Duration,
  "effect/Equal": Equal_,
  "effect/Equivalence": Equivalence_,
  "effect/Filter": Filter_,
  "effect/Formatter": Formatter_,
  "effect/Glob": Glob_,
  "effect/HashMap": HashMap,
  "effect/HashSet": HashSet,
  "effect/Inspectable": Inspectable_,
  "effect/Iterable": Iterable_,
  "effect/JsonPatch": JsonPatch_,
  "effect/JsonPointer": JsonPointer_,
  "effect/LogLevel": LogLevel_,
  "effect/Newtype": Newtype_,
  "effect/NonEmptyIterable": NonEmptyIterable_,
  "effect/Number": Number_,
  "effect/Option": Option,
  "effect/Order": Order_,
  "effect/Ordering": Ordering_,
  "effect/Predicate": Predicate_,
  "effect/PrimaryKey": PrimaryKey_,
  "effect/Rational": Rational,
  "effect/Record": Record_,
  "effect/Redacted": Redacted,
  "effect/RegExp": RegExp_,
  "effect/Result": Result,
  "effect/SemVer": SemVer_,
  "effect/SemVerRange": SemVerRange_,
  "effect/String": String_,
  "effect/Struct": Struct_,
  "effect/Symbol": Symbol_,
  "effect/TextDiff": TextDiff_,
  "effect/Trie": Trie_,
  "effect/Tuple": Tuple_,
  "effect/UndefinedOr": UndefinedOr_,
};

/** The modules whose functions are run as they are, where the prover knows every argument. */
export const modules: ReadonlyArray<string> = Object.keys(PURE).sort();

/** The functions of those modules that read the clock when they are not given a time. */
const CLOCKED: ReadonlySet<string> = new Set([
  "effect/Cron:next",
  "effect/Cron:prev",
  "effect/Cron:sequence",
]);

/**
 * What a pure module of the library gives under a name, as the runtime loads
 * it: `undefined` for a module that is not one of those, and for a function
 * that reads the clock.
 */
export const hostOf = (module: string, path: ReadonlyArray<string>): unknown => {
  if (!Object.hasOwn(PURE, module) || CLOCKED.has(`${module}:${path.join(".")}`)) return undefined;
  let found: unknown = PURE[module];
  for (const key of path) {
    if ((typeof found !== "object" && typeof found !== "function") || found === null)
      return undefined;
    found = (found as Readonly<Record<string, unknown>>)[key];
  }
  return found;
};

/**
 * What `effect/Schema` gives under a name. A schema is built, never run: the
 * prover calls none of these on an input, and builds a schema from them only
 * where it knows every part.
 */
export const schemaOf = (module: string, path: ReadonlyArray<string>): unknown => {
  if (module !== "effect/Schema") return undefined;
  let found: unknown = Schema_;
  for (const key of path) {
    if ((typeof found !== "object" && typeof found !== "function") || found === null)
      return undefined;
    found = (found as Readonly<Record<string, unknown>>)[key];
  }
  return found;
};

/**
 * The schema, or the check of one, each value the prover does not look inside
 * stands for: a schema built from it is then built from the real one.
 */
export const schemas = new WeakMap<object, unknown>();

// A function the library gave back, as the value the prover calls, and the other way.
const functions = new WeakMap<object, (...args: ReadonlyArray<unknown>) => unknown>();

const literal = (text: string): number | undefined => {
  const match = /^(?:(\d+)|\(- (\d+)\))$/.exec(text);
  return match ? (match[1] !== undefined ? Number(match[1]) : -Number(match[2])) : undefined;
};

const isPlain = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * The real value of one the prover knows all of: `undefined` when any part
 * of it depends on an input, or is something only the prover has.
 */
export const real = (v: V): { readonly value: unknown } | undefined => {
  const all = (items: ReadonlyArray<V>): ReadonlyArray<unknown> | undefined => {
    const out: Array<unknown> = [];
    for (const item of items) {
      const made = real(item);
      if (!made) return undefined;
      out.push(made.value);
    }
    return out;
  };
  switch (v._tag) {
    case "Num":
    case "Big":
    case "Str":
    case "Bool":
      return { value: v.value };
    case "Null":
      return { value: null };
    case "Undef":
      return { value: undefined };
    case "Host":
      return { value: v.value };
    case "Opaque":
      return schemas.has(v) ? { value: schemas.get(v) } : undefined;
    case "Lib": {
      const host = v.host ?? hostOf(v.module, v.path) ?? schemaOf(v.module, v.path);
      return host === undefined ? undefined : { value: host };
    }
    case "Native": {
      const fn = functions.get(v);
      return fn && { value: fn };
    }
    case "Time": {
      const millis = literal(v.millis.text);
      const time = millis === undefined ? Option.none() : DateTime.make(millis);
      return Option.isSome(time) ? { value: time.value } : undefined;
    }
    case "Arr": {
      const items = all(v.items);
      return items && { value: [...items] };
    }
    case "Obj": {
      const one = (field: V | undefined) => (field ? real(field) : undefined);
      switch (v.brand?.kind) {
        case undefined: {
          const out: Record<string, unknown> = {};
          for (const [key, field] of Object.entries(v.fields)) {
            const made = real(field);
            if (!made) return undefined;
            out[key] = made.value;
          }
          return { value: out };
        }
        case "Option": {
          const option = Value.optionOf(v)!;
          if (option._tag === "None") return { value: Option.none() };
          const held = real(option.value);
          return held && { value: Option.some(held.value) };
        }
        case "Result": {
          const result = Brands.resultOf(v)!;
          const held = real(result._tag === "Success" ? result.success : result.failure);
          return (
            held && {
              value:
                result._tag === "Success" ? Result.succeed(held.value) : Result.fail(held.value),
            }
          );
        }
        case "Duration": {
          const millis = one(v.fields.millis);
          return typeof millis?.value === "number"
            ? { value: Duration.millis(millis.value) }
            : undefined;
        }
        case "BigDecimal": {
          const decimal = Brands.decimalOf(v);
          return decimal && Brands.isKnown(decimal) ? { value: decimal } : undefined;
        }
        case "Rational": {
          const fraction = Brands.rationalOf(v);
          return fraction && Brands.isFraction(fraction) ? { value: fraction } : undefined;
        }
        case "Redacted": {
          const held = one(v.fields.value);
          return held && { value: Redacted.make(held.value) };
        }
        case "HashSet": {
          const items = one(Brands.setOf(v));
          return Array.isArray(items?.value)
            ? { value: HashSet.fromIterable(items.value) }
            : undefined;
        }
        case "HashMap": {
          const entries = one(Brands.mapOf(v));
          return Array.isArray(entries?.value)
            ? { value: HashMap.fromIterable(entries.value as Array<readonly [unknown, unknown]>) }
            : undefined;
        }
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
};

/**
 * What the library gave, as a value the prover holds: `undefined` for an
 * effect, a stream or a promise, which are not values of a pure function.
 * `name` is how a message names what could not be seen into.
 */
export const known = (value: unknown, name: string): V | undefined => {
  switch (typeof value) {
    case "number":
      return Value.num(value);
    case "string":
      return Value.str(value);
    case "boolean":
      return Value.bool(value);
    case "bigint":
      return { _tag: "Big", value };
    case "undefined":
      return Value.undef;
    case "function": {
      const fn = value as (...args: ReadonlyArray<unknown>) => unknown;
      const made: V = {
        _tag: "Native",
        name,
        call: (args, site) => {
          const out = applied(fn, args, name);
          return out
            ? Effect.succeed(out)
            : Effect.fail(
                Value.notTranslated(
                  site,
                  `calls ${name} on a value an input holds, which the prover has no model for`,
                  true,
                ),
              );
        },
      };
      functions.set(made, fn);
      return made;
    }
    default:
      break;
  }
  if (value === null) return Value.nil;
  const object = value as object;
  // An error is a value the library made, whatever else it can be used as.
  if ("stack" in object && "message" in object) return { _tag: "Host", value, name };
  if (
    Effect.isEffect(object) ||
    Stream.isStream(object) ||
    typeof (object as { readonly then?: unknown }).then === "function"
  )
    return undefined;
  if (Option.isOption(object)) {
    if (Option.isNone(object)) return Value.none;
    const held = known(object.value, name);
    return held && Value.some(held);
  }
  if (Result.isResult(object)) {
    const held = known(Result.isSuccess(object) ? object.success : object.failure, name);
    return held && (Result.isSuccess(object) ? Brands.success(held) : Brands.failure(held));
  }
  if (BigDecimal.isBigDecimal(object)) return Brands.decimal(object);
  if (Rational.isRational(object)) return Brands.rational(object);
  if (Redacted.isRedacted(object)) return undefined;
  if (Duration.isDuration(object)) {
    const millis = Duration.toMillis(object);
    return Number.isSafeInteger(millis)
      ? Brands.duration(Value.num(millis))
      : { _tag: "Host", value, name };
  }
  if (DateTime.isDateTime(object))
    return DateTime.isUtc(object)
      ? {
          _tag: "Time",
          millis: { sort: "Int", text: object.pipe(DateTime.toEpochMillis, literalOf) },
        }
      : { _tag: "Host", value, name };
  const each = (items: Iterable<unknown>): Array<V> | undefined => {
    const out: Array<V> = [];
    for (const item of items) {
      const made = known(item, name);
      if (!made) return undefined;
      out.push(made);
    }
    return out;
  };
  if (HashSet.isHashSet(object)) {
    const items = each(object);
    return items && Brands.hashSet({ _tag: "Arr", items });
  }
  if (HashMap.isHashMap(object)) {
    const entries = each(object);
    return entries && Brands.hashMap({ _tag: "Arr", items: entries });
  }
  if (Array.isArray(object)) {
    const items = each(object);
    return items && { _tag: "Arr", items };
  }
  if (isPlain(object)) {
    const fields: Record<string, V> = {};
    for (const [key, field] of Object.entries(object)) {
      const made = known(field, name);
      if (!made) return undefined;
      fields[key] = made;
    }
    return Value.obj(fields);
  }
  // Anything else the library made is a value the prover passes along and gives back to it.
  return { _tag: "Host", value, name };
};

const literalOf = (n: number): string => (n < 0 ? `(- ${-n})` : `${n}`);

/**
 * A pure function of the library on values the prover knows all of: what the
 * real function gives. `undefined` when an argument depends on an input, or
 * the function throws or gives something that is not a plain value.
 */
export const applied = (
  fn: (...args: ReadonlyArray<unknown>) => unknown,
  args: ReadonlyArray<V>,
  name: string,
): V | undefined => {
  const given: Array<unknown> = [];
  for (const arg of args) {
    const made = real(arg);
    if (!made) return undefined;
    given.push(made.value);
  }
  try {
    return known(fn(...given), name);
  } catch {
    return undefined;
  }
};
