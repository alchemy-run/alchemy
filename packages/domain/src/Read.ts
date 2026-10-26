import type * as Effect from "effect/Effect";
import type * as Aggregate from "./Aggregate.ts";
import type * as Middleware from "./Middleware.ts";
import type * as Rejection from "./Rejection.ts";

/** How a client reads a View or an aggregate. */
export type Mode = "get" | "watch" | "events" | "list";

/**
 * A client's read, as `validate` sees it: what is being read and how. The
 * client's own filters are not part of it: they only narrow what a permitted
 * read returns, so access never depends on analyzing them.
 */
export interface Request<Ref> {
  readonly mode: Mode;
  /** The key being read: a view key, or an aggregate instance. */
  readonly key: Ref;
}

/**
 * The read contract of a View or aggregate exposed in an Api: the middleware
 * that guards it, the rejections a read may fail with, and `validate`, which
 * judges each read. Like a Command, a View is a security boundary: to show an
 * audience different data, make another View.
 */
export interface Contract<
  Ref,
  St,
  Ms extends Middleware.List,
  Rejects extends ReadonlyArray<Rejection.Any>,
  Key = string,
> {
  /**
   * What the read answers, for the people and agents who call it. Surfaces
   * built from an Api (tool lists, CLI help, API docs) show it. Read it back
   * with `Domain.descriptionOf`.
   */
  readonly description?: string;
  /**
   * Example reads, in wire form: the key as a client sends it. Read them back
   * with `Domain.examplesOf`.
   */
  readonly examples?: ReadonlyArray<Example<Key>>;
  /**
   * Middleware that guards reads when an Api exposes them, in order. What it
   * provides is what `validate` may read.
   */
  readonly middleware?: Ms;
  /** The rejections a read may fail with; they reach the client typed. */
  readonly rejects?: Rejects;
  /**
   * Judge a read from who is asking (what `middleware` provides), the key and
   * that key's state. Runs on every `get` and `list`, and on every change
   * while a client watches: failing ends the watch with that rejection.
   * Without it, anyone who reaches the Api may read every key.
   */
  readonly validate?: (
    request: Request<Ref>,
    state: St,
  ) => Effect.Effect<void, Aggregate.Inst<Rejects[number]>, Middleware.Provides<Ms>>;
}

/** An example read: the key, in wire form. */
export interface Example<Key = string> {
  readonly key: Key;
}

/** The read contract a View or aggregate declares, widened. @internal */
export interface AnyContract {
  readonly description?: string;
  readonly examples?: ReadonlyArray<Example<unknown>>;
  readonly middleware?: Middleware.List;
  readonly rejects?: ReadonlyArray<Rejection.Any>;
  readonly validate?: (request: never, state: never) => Effect.Effect<void, unknown, unknown>;
}
