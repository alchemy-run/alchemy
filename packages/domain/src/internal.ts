import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { Scope } from "effect/Scope";

/**
 * Capture the services `R` for later use, minus the `Scope`: a captured
 * construction-time scope must never replace the scope of a later request or
 * event (finalizers would attach to the wrong lifetime, and on workerd the
 * work would be pinned to another request's I/O context).
 *
 * @internal
 */
export const captureContext = <R = never>(): Effect.Effect<
  Context.Context<Exclude<R, Scope>>,
  never,
  R
> =>
  Effect.map(
    Effect.context<R>(),
    (context) => Context.omit(Scope)(context) as Context.Context<Exclude<R, Scope>>,
  );

/**
 * A domain definition error (duplicate tag, missing `keyOf`, …), raised while
 * the kernel is built, or when a handler returns something its declaration
 * does not allow.
 */
export class DefinitionError extends Data.TaggedError("DefinitionError")<{
  readonly message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}

/** What `decide` returned, once its Effect (if any) ran. @internal */
export type Settled =
  | { readonly _tag: "Decided"; readonly decision: unknown }
  | { readonly _tag: "Failed"; readonly cause: Cause.Cause<unknown> };

/**
 * Settle an effectful decision. A rejection is a `YieldableError`, so it is
 * an Effect too: running it fails with the rejection itself, which is the
 * decision. Any other failure (a missing service, a defect) stays a failure.
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
    readonly rejects: ReadonlyArray<{ readonly tag: string }>;
  },
  decision: unknown,
): Judged => {
  if (!Array.isArray(decision)) {
    const rejection = decision as { readonly _tag: string };
    if (!command.rejects.some((r) => r.tag === rejection?._tag)) {
      return {
        _tag: "Undeclared",
        error: new DefinitionError(
          `${aggregateName}.decide.${command.tag} returned '${rejection?._tag}', which ${command.tag} does not declare in rejects`,
        ),
      };
    }
    return { _tag: "Rejected", rejection };
  }
  for (const event of decision as ReadonlyArray<{ readonly _tag: string }>) {
    if (!command.events.some((e) => e.tag === event._tag)) {
      return {
        _tag: "Undeclared",
        error: new DefinitionError(
          `${aggregateName}.decide.${command.tag} returned '${event._tag}', which ${command.tag} does not declare in events`,
        ),
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
