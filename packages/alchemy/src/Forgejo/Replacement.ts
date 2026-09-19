/**
 * Identity-change detection shared by the Forgejo providers' `diff`.
 *
 * Not exported from `index.ts` — this is internal scaffolding, not part of
 * the provider's public surface.
 */

import * as Effect from "effect/Effect";
import { isResolved, type ReplaceDiff } from "../Diff.ts";
import type { Input } from "../Input.ts";

/**
 * A `diff` handler that replaces the resource when any of `keys` changed.
 *
 * Forgejo addresses most resources by a composite of owner, repository, and
 * name. No edit endpoint can move a resource across that composite, so a
 * change to one of those props names a different object rather than an update
 * to this one — the only way to honor it is to replace.
 *
 * Every provider needs the same two guards before it may compare: `news`
 * arrives as `Input<Props>` during plan and has to be narrowed with
 * {@link isResolved} before any property is read, and `olds` is absent on a
 * create, where there is nothing to have changed from.
 */
export const replaceWhenChanged =
  <P extends object>(...keys: readonly (keyof P & string)[]) =>
  (input: {
    readonly news: Input<P>;
    readonly olds: P;
  }): Effect.Effect<ReplaceDiff | undefined> => {
    const { news, olds } = input;
    if (olds === undefined || !isResolved<P>(news)) {
      return Effect.succeed(undefined);
    }
    return Effect.succeed(
      keys.some((key) => news[key] !== olds[key])
        ? ({ action: "replace" } as const)
        : undefined,
    );
  };
