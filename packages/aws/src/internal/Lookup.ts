import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * A lookup by a non-unique key (an EC2 `Name` tag) matched more than one
 * resource. Look the resource up by its id instead.
 */
export class AmbiguousLookupError extends Data.TaggedError("AmbiguousLookupError")<{
  message: string;
  /** The resource type looked up, e.g. `AWS.EC2.Vpc`. */
  type: string;
  /** The ids of every resource that matched. */
  ids: string[];
}> {}

/**
 * The one resource among `matches`, `undefined` when there is none, or an
 * {@link AmbiguousLookupError} naming every match when there are several.
 */
export const single = <A>(
  type: string,
  key: string,
  matches: readonly A[],
  idOf: (match: A) => string | undefined,
): Effect.Effect<A | undefined, AmbiguousLookupError> =>
  matches.length <= 1
    ? Effect.succeed(matches[0])
    : Effect.fail(
        new AmbiguousLookupError({
          message: `${matches.length} ${type} resources match ${key}; look one up by its id`,
          type,
          ids: matches.map((match) => idOf(match) ?? "unknown"),
        }),
      );

/** An EC2 `describe*` filter on the `Name` tag. */
export const nameTagFilter = (name: string) => ({ Name: "tag:Name", Values: [name] });
