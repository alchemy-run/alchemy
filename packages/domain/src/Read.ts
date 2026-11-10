import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Aggregate from "./Aggregate.ts";
import type * as Middleware from "./Middleware.ts";
import type * as Rejection from "./Rejection.ts";

/** How a client reads a View or a Stream. */
export type Mode = "get" | "watch" | "events" | "list";

/**
 * What `watch` sends: the key's state and the cursor it is valid at, the
 * `seq` of the last event the key had when the state was read (`0` before any).
 */
export interface Snapshot<S> {
  readonly state: S;
  /** Pass as `after` to `events` to receive every later event, once. */
  readonly cursor: number;
}

/**
 * The frame `events` sends once it has sent the key's history: every event up
 * to `cursor` was delivered (or filtered out), and what follows is live. A
 * read that reconnects sends it again after the events it missed.
 */
export const CaughtUp = Schema.TaggedStruct("CaughtUp", {
  /** The `seq` of the last event of the history (`0` for none); resume `events` after it. */
  cursor: Schema.Number,
});
export type CaughtUp = typeof CaughtUp.Type;

/** Is a frame of `events` the {@link CaughtUp} marker? */
export const isCaughtUp = <A extends object>(frame: A | CaughtUp): frame is CaughtUp =>
  "_tag" in frame && frame._tag === "CaughtUp";

/**
 * Is a frame of `events` an event, not the {@link CaughtUp} marker? Drops the
 * marker from a feed: `Stream.filter(Domain.Read.isEvent)`.
 */
export const isEvent = <A extends object>(frame: A | CaughtUp): frame is Exclude<A, CaughtUp> =>
  !isCaughtUp(frame);

/**
 * A client's read, as `validate` sees it: what is being read and how. The
 * client's own filters are not part of it: they only narrow what a permitted
 * read returns, so access never depends on analyzing them.
 */
export interface Request<Ref> {
  readonly mode: Mode;
  /** The key being read. */
  readonly key: Ref;
}

/**
 * The read contract of a View or Stream exposed in an Api: the middleware
 * that guards it and the rejections a read may fail with. Like a Command, a
 * View is a security boundary: to show an audience different data, make
 * another View. Who may read which key is judged by `validate`, on the
 * View's or Stream's own Layer (see {@link Validate}).
 */
export interface Contract<
  Ms extends Middleware.List,
  Rejects extends ReadonlyArray<Rejection.Any>,
> {
  /**
   * Middleware that guards reads when an Api exposes them, in order. What it
   * provides is what `validate` may read.
   */
  readonly middleware?: Ms;
  /**
   * The rejections a read may fail with; they reach the client typed.
   * Declaring any (or any middleware) requires the View's or Stream's Layer,
   * whose `validate` decides who may read each key.
   */
  readonly rejects?: Rejects;
}

/** The read contract a View or Stream declares, widened. @internal */
export interface AnyContract {
  readonly middleware?: Middleware.List;
  readonly rejects?: ReadonlyArray<Rejection.Any>;
}

/**
 * Judge a read from who is asking (what the middleware provides), the key
 * and that key's state. Runs on every `get`, `snapshot` and `list`, and on
 * every change while a client watches: failing ends the watch with that
 * rejection. Resolve what it reads (a permissions store, say) while building
 * its Layer; it may only need what the middleware provides at run time.
 */
export type Validate<
  Ref,
  St,
  Ms extends Middleware.List,
  Rejects extends ReadonlyArray<Rejection.Any>,
> = (
  request: Request<Ref>,
  state: St,
) => Effect.Effect<
  void,
  Aggregate.InstanceOf<Rejects[number]>,
  Middleware.Provides<Ms> | RuntimeContext
>;

/** What a View's or Stream's Layer provides: its `validate`. @internal */
export interface Implementation {
  readonly validate: AnyValidate;
}

/** Type-level identity of a View's or Stream's Layer in an Effect's requirements. */
export interface ValidatorKey<Name extends string> {
  readonly "~alchemy/Domain/Read/Validator": Name;
}

/** The middleware a read's declaration lists, or none. */
export type MiddlewareOf<D> = D extends { readonly middleware?: infer Ms }
  ? NonNullable<Ms> extends Middleware.List
    ? NonNullable<Ms>
    : readonly []
  : readonly [];

/** The rejections a read's declaration lists, or none. */
export type RejectsOf<D> = D extends { readonly rejects?: infer Rs }
  ? NonNullable<Rs> extends ReadonlyArray<Rejection.Any>
    ? NonNullable<Rs>
    : readonly []
  : readonly [];

/** A read's `validate`, widened, as the engine calls it. @internal */
export type AnyValidate = (
  request: Request<unknown>,
  state: unknown,
) => Effect.Effect<void, unknown>;

/**
 * Whether a read's declaration needs its Layer: it guards reads with
 * middleware, or declares rejections. Without either, anyone who reaches the
 * Api may read every key, and there is nothing to judge.
 */
export type Guarded<D> = D extends {
  readonly middleware?: infer Ms;
  readonly rejects?: infer Rs;
}
  ? [NonNullable<Ms>] extends [readonly []]
    ? [NonNullable<Rs>] extends [readonly []]
      ? false
      : true
    : true
  : false;

/** Whether a declared read contract needs its Layer, at run time. @internal */
export const isGuarded = (contract: AnyContract): boolean =>
  (contract.middleware?.length ?? 0) > 0 || (contract.rejects?.length ?? 0) > 0;
