import * as Arr from "effect/Array";
import * as BigInt_ from "effect/BigInt";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Base64 from "effect/encoding/Base64";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import type { SqlError } from "effect/sql/SqlError";
import { DefinitionError, UndeclaredDecision } from "./DefinitionError.ts";

export { DefinitionError } from "./DefinitionError.ts";

/**
 * The schema of a command's or a query's `input`. With no fields it is an
 * empty record, not `Schema.Struct({})`: an empty Struct accepts any value
 * but `null`, and its JSON Schema has no `type`, so an agent calling the tool
 * may send the string `"{}"`. The empty record is a JSON object with no
 * properties. The declared type stays `Schema.Struct<F>`.
 *
 * @internal
 */
export const inputSchema = <F extends Schema.Struct.Fields>(fields: F | undefined) =>
  (fields === undefined || Object.keys(fields).length === 0
    ? Schema.Record(Schema.String, Schema.Never)
    : Schema.Struct(fields)) as unknown as Schema.Struct<F>;

const tags = new WeakMap<object, string>();

/**
 * The `_tag` a rejection class declares: the literal its schema gives
 * `_tag`, so any tagged error class can be a rejection.
 *
 * @internal
 */
export const rejectionTag = (rejection: Schema.Top): string => {
  const cached = tags.get(rejection);
  if (cached !== undefined) return cached;
  const encoded = SchemaAST.toEncoded(rejection.ast);
  const tag = SchemaAST.isObjects(encoded)
    ? encoded.propertySignatures.find((property) => property.name === "_tag")?.type
    : undefined;
  const value = tag && SchemaAST.isLiteral(tag) ? String(tag.literal) : "";
  tags.set(rejection, value);
  return value;
};

/** What `decide` returned, once its Effect (if any) ran. @internal */
export type Settled =
  | { readonly _tag: "Decided"; readonly decision: unknown }
  | { readonly _tag: "Failed"; readonly cause: Cause.Cause<unknown> };

/**
 * Settle an effectful decision. A rejection is a `YieldableError`, so it is
 * an Effect too: running it fails with the rejection itself, which is the
 * decision. Any other failure, such as a defect, stays a failure.
 *
 * @internal
 */
export const settle = (exit: Exit.Exit<unknown, unknown>): Settled => {
  if (Exit.isSuccess(exit)) return { _tag: "Decided", decision: exit.value };
  const rejection = Cause.findErrorOption(exit.cause);
  return Option.isSome(rejection)
    ? { _tag: "Decided", decision: rejection.value }
    : { _tag: "Failed", cause: exit.cause };
};

/** A decision, judged against the command's declaration. @internal */
export type Judged =
  | { readonly _tag: "Accepted"; readonly events: ReadonlyArray<{ readonly _tag: string }> }
  | { readonly _tag: "Rejected"; readonly rejection: { readonly _tag: string } }
  | { readonly _tag: "Undeclared"; readonly error: DefinitionError };

/**
 * Judge a settled decision: the events to commit, the rejection, or the
 * {@link DefinitionError} for an event or rejection the command does not
 * declare.
 *
 * @internal
 */
export const judge = (
  aggregateName: string,
  command: {
    readonly tag: string;
    readonly events: ReadonlyArray<{ readonly tag: string }>;
    readonly rejects: ReadonlyArray<Schema.Top>;
  },
  decision: unknown,
): Judged => {
  if (!Array.isArray(decision)) {
    const rejection = decision as { readonly _tag: string };
    if (!command.rejects.some((r) => rejectionTag(r) === rejection?._tag)) {
      return {
        _tag: "Undeclared",
        error: new DefinitionError({
          reason: new UndeclaredDecision({
            aggregate: aggregateName,
            command: command.tag,
            returned: String(rejection?._tag),
            list: "rejects",
          }),
        }),
      };
    }
    return { _tag: "Rejected", rejection };
  }
  for (const event of decision as ReadonlyArray<{ readonly _tag: string }>) {
    if (!command.events.some((e) => e.tag === event._tag)) {
      return {
        _tag: "Undeclared",
        error: new DefinitionError({
          reason: new UndeclaredDecision({
            aggregate: aggregateName,
            command: command.tag,
            returned: event._tag,
            list: "events",
          }),
        }),
      };
    }
  }
  return { _tag: "Accepted", events: decision };
};

type AnyHandler = (...args: ReadonlyArray<unknown>) => unknown;
type HandlerMap = { readonly [key: string]: AnyHandler | Record<string, AnyHandler | undefined> };

/** The id a ref or a Schema key value addresses. @internal */
export const targetId = (target: unknown): string =>
  typeof target === "object" && target !== null && "id" in target
    ? String((target as { readonly id: unknown }).id)
    : String(target);

/** One input for a view's evolve. @internal */
export interface LocalViewInput {
  readonly name: string;
  readonly event: { readonly _tag: string };
  /** A ref for an aggregate source, the key value for a Schema-keyed view. */
  readonly source: unknown;
  readonly state?: unknown;
  readonly envelope: { readonly at: unknown };
  readonly key?: unknown;
}

/**
 * Apply one input to one key of a view, with the view's own `keyOf` and
 * `evolve`, as the kernel applies a delivery: each route whose `keyOf`
 * reaches the key runs its handler. An input that reaches no route of the
 * key leaves the state as it is.
 *
 * @internal
 */
export const evolveView = (
  view: {
    readonly definition: {
      readonly state?: unknown;
      readonly initial?: unknown;
      readonly keyOf?: unknown;
      readonly evolve?: unknown;
    };
  },
  state: unknown,
  input: LocalViewInput,
): unknown => {
  const def = view.definition;
  if (def.state === undefined) return null;
  const tag = input.event._tag;
  const keyOf = def.keyOf as HandlerMap | undefined;
  const evolve = def.evolve as HandlerMap | undefined;
  const routing = {
    event: input.event,
    source: input.source,
    state: input.state,
    envelope: input.envelope,
  };
  const custom = keyOf?.[tag] ?? keyOf?.[input.name];
  let key: unknown;
  let routes: ReadonlyArray<string | undefined>;
  // A route returns a ref for an aggregate key, or the value of a Schema key.
  const reaches = (reached: unknown) =>
    reached !== undefined && key !== undefined && targetId(reached) === targetId(key);
  if (typeof custom === "function") {
    const reached = custom(routing);
    key = input.key ?? reached;
    routes = reaches(reached) ? [undefined] : [];
  } else if (custom) {
    key = input.key;
    routes = Object.entries(custom).flatMap(([route, fn]) =>
      reaches(fn?.(routing)) ? [route] : [],
    );
  } else {
    key = input.key ?? input.source;
    routes = reaches(input.source) ? [undefined] : [];
  }
  let current = state;
  for (const route of routes) {
    const handler = evolve?.[tag] ?? evolve?.[input.name];
    const fn =
      typeof handler === "function" ? handler : route !== undefined ? handler?.[route] : undefined;
    if (!fn) continue;
    current =
      fn(current ?? def.initial, input.event, {
        key,
        source: input.source,
        state: input.state,
        envelope: input.envelope,
        at: input.envelope.at,
      }) ?? null;
  }
  return current;
};

/**
 * A JSON value that is an object. Shallow: the value is JSON already.
 *
 * @internal
 */
export const isJsonObject = (json: Schema.Json | undefined): json is Schema.JsonObject =>
  Predicate.isReadonlyObject(json) && !Array.isArray(json);

/**
 * The value at a dotted path of a JSON object, or `undefined`.
 *
 * @internal
 */
export const jsonAt = (object: Schema.JsonObject, path: string): Schema.Json | undefined =>
  Arr.reduce(path.split("."), Option.some<Schema.Json>(object), (value, part) =>
    Option.flatMap(value, (json) =>
      isJsonObject(json) ? Option.fromNullishOr(json[part]) : Option.none(),
    ),
  ).pipe(Option.getOrUndefined);

/**
 * A driver's value as JSON: a `Date` is its ISO string, a `bigint` a number
 * when it fits exactly (else its digits), bytes their base64, and lists and
 * objects element by element. The matcher is built once.
 *
 * @internal
 */
export const toJson: (value: unknown) => Schema.Json = Match.type<unknown>().pipe(
  Match.when(Predicate.isNullish, () => null),
  Match.when(Predicate.isString, (string) => string),
  Match.when(Predicate.isBoolean, (boolean) => boolean),
  Match.when(Predicate.isNumber, (number) => (Number.isFinite(number) ? number : String(number))),
  Match.when(Predicate.isBigInt, (bigint) =>
    Option.getOrElse(BigInt_.toNumber(bigint), () => bigint.toString()),
  ),
  Match.when(Predicate.isDate, (date) => DateTime.formatIso(DateTime.fromDateUnsafe(date))),
  Match.when(Predicate.isUint8Array, Base64.encode),
  Match.when(Array.isArray, (values) => Arr.map(values, (value) => toJson(value))),
  Match.when(Predicate.isReadonlyObject, (object) => Rec.map(object, (value) => toJson(value))),
  Match.orElse(String),
);

/**
 * A driver's row as JSON.
 *
 * @internal
 */
export const rowToJson = (row: Readonly<Record<string, unknown>>): Schema.JsonObject =>
  Rec.map(row, (value) => toJson(value));

/**
 * What a failure says, for an error's detail.
 *
 * @internal
 */
export const detailOf = (cause: unknown): string =>
  Predicate.hasProperty(cause, "message") ? String(cause.message) : String(cause);

/**
 * Whether a SQL failure is the statement's own fault: a syntax error or a
 * violated constraint, which running it again cannot fix. Every other reason
 * (a connection, credentials, a deadlock, a timeout, a driver that names no
 * reason) may pass.
 *
 * @internal
 */
export const isStatementFault = (error: SqlError): boolean =>
  Match.value(error.reason).pipe(
    Match.tags({
      SqlSyntaxError: () => true,
      UniqueViolation: () => true,
      ConstraintError: () => true,
    }),
    Match.orElse(() => false),
  );
