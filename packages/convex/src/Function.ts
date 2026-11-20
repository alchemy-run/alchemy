import type {
  Auth as ConvexAuth,
  FunctionReference,
  GenericDatabaseReader,
  GenericDatabaseWriter,
  Scheduler as ConvexScheduler,
  UserIdentity,
} from "convex/server";
import { makeFunctionReference } from "convex/server";
import type { GenericId, Value } from "convex/values";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A schema Convex functions use: no services needed to encode or decode it. */
export type Codec = Schema.Codec<any, any, never, never>;

export type FunctionKind = "query" | "mutation" | "action";

/** The database, as a query or mutation reads it. Yield a {@link Table}'s methods rather than this. */
export class Reader extends Context.Service<Reader, GenericDatabaseReader<any>>()(
  "Convex.Reader",
) {}

/** The database, as a mutation writes it. */
export class Writer extends Context.Service<Writer, GenericDatabaseWriter<any>>()(
  "Convex.Writer",
) {}

/** Convex's scheduler, in a mutation or action. See {@link schedule}. */
export class Scheduler extends Context.Service<Scheduler, ConvexScheduler>()("Convex.Scheduler") {}

/** The caller's identity. See {@link identity}. */
export class Auth extends Context.Service<Auth, ConvexAuth>()("Convex.Auth") {}

/** What an action uses to call other functions. See {@link run}. */
export interface RunnerShape {
  readonly runQuery: (reference: FunctionReference<"query", any>, args: any) => Promise<unknown>;
  readonly runMutation: (
    reference: FunctionReference<"mutation", any>,
    args: any,
  ) => Promise<unknown>;
  readonly runAction: (reference: FunctionReference<"action", any>, args: any) => Promise<unknown>;
}

/** Calls other functions from an action. See {@link run}. */
export class Runner extends Context.Service<Runner, RunnerShape>()("Convex.Runner") {}

/**
 * What each kind of function may use. A query only reads; a mutation reads,
 * writes and schedules, all in one transaction; an action calls other
 * functions and schedules. A handler that asks for more doesn't type-check.
 */
export type ServicesOf<Kind extends FunctionKind> = Kind extends "query"
  ? Reader | Auth
  : Kind extends "mutation"
    ? Reader | Writer | Scheduler | Auth
    : Runner | Scheduler | Auth;

type ValueOf<S> = S extends Codec ? S["Type"] : void;
type FailureOf<S> = S extends Codec ? S["Type"] : never;

/**
 * The function a declaration's Layer provides. Besides its declared failure
 * it may fail with `SchemaError`, as a table write or a call does when a
 * value fails its schema's checks; the caller then gets an undeclared error.
 */
export type Handler<
  Kind extends FunctionKind,
  Args extends Codec,
  Returns extends Codec | undefined,
  Error extends Codec | undefined,
> = (
  args: Args["Type"],
) => Effect.Effect<ValueOf<Returns>, FailureOf<Error> | Schema.SchemaError, ServicesOf<Kind>>;

/** What a declaration says about its function: kind, path and schemas. */
export interface FunctionDeclaration<
  Kind extends FunctionKind = FunctionKind,
  Path extends string = string,
  Args extends Codec = Codec,
  Returns extends Codec | undefined = Codec | undefined,
  Error extends Codec | undefined = Codec | undefined,
  Internal extends boolean = boolean,
> {
  readonly kind: Kind;
  /** Where Convex serves it: `<file>:<export>`, such as `messages:list`. */
  readonly path: Path;
  readonly args: Args;
  readonly returns: Returns;
  readonly error: Error;
  /** An internal function can only be called by other functions. */
  readonly internal: Internal;
}

export interface FunctionSpec<
  Args extends Codec,
  Returns extends Codec | undefined,
  Error extends Codec | undefined,
  Internal extends boolean,
> {
  /** The arguments, as an object schema such as `Schema.Struct`. */
  readonly args: Args;
  /** What the function returns. Omit it for a function that returns nothing. */
  readonly returns?: Returns;
  /** What the function fails with. Callers get the decoded value as a typed failure. */
  readonly error?: Error;
  /**
   * Only other functions may call it: not a browser, a Worker or a Lambda.
   * @default false
   */
  readonly internal?: Internal;
}

/** The value a function returns. */
export type Success<F extends FunctionDeclaration> = ValueOf<F["returns"]>;
/** The typed failure a function fails with. */
export type Failure<F extends FunctionDeclaration> = FailureOf<F["error"]>;
/** The arguments a function takes. */
export type Args<F extends FunctionDeclaration> = F["args"]["Type"];

const declare =
  <Kind extends FunctionKind>(kind: Kind) =>
  <Self>() =>
  <
    const Path extends string,
    Args extends Codec,
    Returns extends Codec | undefined = undefined,
    Error extends Codec | undefined = undefined,
    const Internal extends boolean = false,
  >(
    path: Path,
    spec: FunctionSpec<Args, Returns, Error, Internal>,
  ) =>
    Object.assign(
      Context.Service<Self, Handler<Kind, Args, Returns, Error>>()(`Convex.Function/${path}`),
      {
        kind,
        path,
        args: spec.args,
        returns: spec.returns as Returns,
        error: spec.error as Error,
        internal: (spec.internal ?? false) as Internal,
      } satisfies FunctionDeclaration<Kind, Path, Args, Returns, Error, Internal>,
    );

/**
 * Declare a Convex query: its path, arguments, result and failure. A query
 * only reads, and Convex reruns it for subscribers when what it read changes.
 *
 * The declaration holds no code, so a browser, Worker or Lambda can import
 * it to call the function. Implement it with a Layer, and serve it from a
 * file in `convex/` with {@link serve}.
 *
 * ### Declaring a Function
 * **Example:** A query with typed arguments and result
 * ```typescript
 * export class ListMessages extends Convex.Query<ListMessages>()("messages:list", {
 *   args: Schema.Struct({ channel: Schema.String }),
 *   returns: Schema.Array(Messages.Document),
 * }) {}
 * ```
 *
 * ### Implementing It
 * **Example:** Read a table in the handler
 * ```typescript
 * export const ListMessagesLive = Layer.succeed(ListMessages,
 *   Effect.fn(function* ({ channel }) {
 *     return yield* Messages.query((q) =>
 *       q.withIndex("by_channel", (r) => r.eq("channel", channel)),
 *     ).collect;
 *   }),
 * );
 * ```
 *
 * ### Serving It
 * The path is the file in `convex/` and the export name.
 *
 * **Example:** `convex/messages.ts`
 * ```typescript
 * export const list = Convex.serve(ListMessages, ListMessagesLive);
 * ```
 *
 * @primitive
 * @product Functions
 */
export const Query = declare("query");

/**
 * Declare a Convex mutation. A mutation reads and writes the database in one
 * transaction: a failure rolls every write back, and so does a conflict,
 * after which Convex runs it again. Side effects go through {@link schedule},
 * which commits with the writes.
 *
 * ### Declaring a Function
 * **Example:** A mutation with a typed failure
 * ```typescript
 * export class EmptyBody extends Schema.TaggedError<EmptyBody>()("EmptyBody", {}) {}
 *
 * export class AddMessage extends Convex.Mutation<AddMessage>()("messages:add", {
 *   args: Schema.Struct({ channel: Schema.String, body: Schema.String }),
 *   returns: Convex.Id("messages"),
 *   error: EmptyBody,
 * }) {}
 * ```
 *
 * ### Implementing It
 * **Example:** Insert, then schedule a follow-up
 * ```typescript
 * export const AddMessageLive = Layer.succeed(AddMessage,
 *   Effect.fn(function* ({ channel, body }) {
 *     if (body === "") return yield* new EmptyBody();
 *     const id = yield* Messages.insert({ channel, body });
 *     yield* Convex.schedule(Notify, { id });
 *     return id;
 *   }),
 * );
 * ```
 *
 * @primitive
 * @product Functions
 */
export const Mutation = declare("mutation");

/**
 * Declare a Convex action. An action may call the outside world, and calls
 * queries and mutations with {@link run}. It is not a transaction: each
 * `run` commits on its own.
 *
 * ### Declaring a Function
 * **Example:** An internal action a mutation schedules
 * ```typescript
 * export class Notify extends Convex.Action<Notify>()("messages:notify", {
 *   args: Schema.Struct({ id: Convex.Id("messages") }),
 *   internal: true,
 * }) {}
 * ```
 *
 * @primitive
 * @product Functions
 */
export const Action = declare("action");

const referenceTo = (fn: FunctionDeclaration) => makeFunctionReference<FunctionKind>(fn.path);

/** A thrown `ConvexError`, recognised by name like Convex's own client does. */
export const convexErrorData = (error: unknown): Option.Option<unknown> =>
  typeof error === "object" &&
  error !== null &&
  (error as { name?: unknown }).name === "ConvexError" &&
  "data" in error
    ? Option.some((error as { data: unknown }).data)
    : Option.none();

/** Decode a function's typed failure from a `ConvexError`'s data, or die. */
export const decodeFailure = <F extends FunctionDeclaration>(
  fn: F,
  data: unknown,
  cause: unknown,
): Effect.Effect<never, Failure<F>> =>
  fn.error === undefined
    ? Effect.die(cause)
    : Schema.decodeUnknownEffect(fn.error)(data).pipe(
        Effect.matchEffect({
          onFailure: () => Effect.die(cause),
          onSuccess: (failure) => Effect.fail(failure as Failure<F>),
        }),
      );

/** Decode a function's result, or die: the deployed code returned another shape. */
export const decodeSuccess = <F extends FunctionDeclaration>(
  fn: F,
  value: unknown,
): Effect.Effect<Success<F>> =>
  fn.returns === undefined
    ? Effect.succeed(undefined as Success<F>)
    : (Schema.decodeUnknownEffect(fn.returns)(value).pipe(Effect.orDie) as Effect.Effect<
        Success<F>
      >);

/** Encode a call's arguments. A value that fails the schema's checks fails the call. */
export const encodeArgs = <F extends FunctionDeclaration>(fn: F, args: Args<F>) =>
  Schema.encodeEffect(fn.args)(args) as Effect.Effect<Record<string, Value>, Schema.SchemaError>;

/**
 * Call a query, mutation or action from an action, typed by its declaration.
 * Each call is its own transaction.
 *
 * **Example:** Read, then write, from an action
 * ```typescript
 * const messages = yield* Convex.run(ListMessages, { channel: "general" });
 * yield* Convex.run(AddMessage, { channel: "general", body: "summary" });
 * ```
 */
export const run = Effect.fn(function* <F extends FunctionDeclaration>(fn: F, args: Args<F>) {
  const runner = yield* Runner;
  const encoded = yield* encodeArgs(fn, args);
  const reference = referenceTo(fn);
  const value = yield* Effect.tryPromise({
    try: () =>
      fn.kind === "query"
        ? runner.runQuery(reference as FunctionReference<"query">, encoded)
        : fn.kind === "mutation"
          ? runner.runMutation(reference as FunctionReference<"mutation">, encoded)
          : runner.runAction(reference as FunctionReference<"action">, encoded),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      Option.match(convexErrorData(cause), {
        onNone: () => Effect.die(cause),
        onSome: (data) => decodeFailure(fn, data, cause),
      }),
    ),
  );
  return yield* decodeSuccess(fn, value);
}) as <F extends FunctionDeclaration>(
  fn: F,
  args: Args<F>,
) => Effect.Effect<Success<F>, Failure<F> | Schema.SchemaError, Runner>;

export interface ScheduleOptions {
  /** How long to wait. @default 0 */
  readonly after?: Duration.Input;
  /** When to run it. Overrides `after`. */
  readonly at?: Date;
}

/**
 * Run a mutation or action later. From a mutation it is scheduled only if the
 * mutation commits, so it is how a transaction starts a side effect.
 *
 * **Example:** Notify once the message is stored
 * ```typescript
 * const id = yield* Messages.insert({ channel, body });
 * yield* Convex.schedule(Notify, { id });
 * ```
 */
export const schedule = Effect.fn(function* <F extends FunctionDeclaration<"mutation" | "action">>(
  fn: F,
  args: Args<F>,
  options: ScheduleOptions = {},
) {
  const scheduler = yield* Scheduler;
  const encoded = yield* encodeArgs(fn, args);
  const reference = referenceTo(fn) as FunctionReference<"mutation" | "action">;
  return yield* Effect.promise(() =>
    options.at !== undefined
      ? scheduler.runAt(options.at, reference, encoded)
      : scheduler.runAfter(Duration.toMillis(options.after ?? 0), reference, encoded),
  );
}) as <F extends FunctionDeclaration<"mutation" | "action">>(
  fn: F,
  args: Args<F>,
  options?: ScheduleOptions,
) => Effect.Effect<GenericId<"_scheduled_functions">, Schema.SchemaError, Scheduler>;

/**
 * The caller's identity, from the JWT its client sent, or `None` for an
 * anonymous call. Convex checks the token against the deployment's auth
 * providers before the function runs.
 *
 * **Example:** Require a signed-in caller
 * ```typescript
 * const user = yield* Convex.identity;
 * if (Option.isNone(user)) return yield* new NotSignedIn();
 * ```
 */
export const identity: Effect.Effect<Option.Option<UserIdentity>, never, Auth> = Effect.gen(
  function* () {
    const auth = yield* Auth;
    return Option.fromNullishOr(yield* Effect.promise(() => auth.getUserIdentity()));
  },
);
