import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * A resource Galaxy's API can read but not create was declared in a
 * stack. Reference the existing object with the resource's `lookup`
 * instead; `reason` says why Alchemy cannot manage it.
 */
export class LookupOnlyResource extends Data.TaggedError("StarburstGalaxy.LookupOnlyResource")<{
  readonly type: string;
  readonly reason: string;
}> {
  override get message() {
    return `${this.type} can only be looked up (${this.type}.lookup(...)): ${this.reason}`;
  }
}

/**
 * The lifecycle of a resource that only `lookup` resolves: a declaration
 * fails with {@link LookupOnlyResource}, nothing is ever read into state or
 * deleted, and `list` reports nothing, so `alchemy unsafe nuke` never
 * touches the objects.
 */
export const lookupOnlyLifecycle = (type: string, reason: string) => ({
  read: () => Effect.succeed(undefined),
  reconcile: () => Effect.fail(new LookupOnlyResource({ type, reason })),
  delete: () => Effect.void,
  list: () => Effect.succeed([]),
});
