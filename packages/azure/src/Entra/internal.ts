import type { MicrosoftGraphOpError } from "@distilled.cloud/microsoft-graph";
import * as directory from "@distilled.cloud/microsoft-graph/directory";
import { createInternalTags, hasAlchemyTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Microsoft Graph `tags` are a set of strings, not a key/value map. Alchemy
 * writes its ownership tags as `alchemy::stack=<stack>`,
 * `alchemy::stage=<stage>` and `alchemy::id=<id>` next to the user's tags.
 */
const INTERNAL_PREFIX = "alchemy::";

/** The Alchemy ownership tags for `id`, as Graph tag strings. */
export const ownershipTags = Effect.fn(function* (id: string) {
  const tags = yield* createInternalTags(id);
  return Object.entries(tags).map(([key, value]) => `${key}=${value}`);
});

/** The user's tags plus the Alchemy ownership tags, sorted and deduplicated. */
export const desiredGraphTags = Effect.fn(function* (id: string, tags: readonly string[] = []) {
  const internal = yield* ownershipTags(id);
  return [...new Set([...userGraphTags(tags), ...internal])].sort();
});

/** The ownership tags in `tags` as a key/value record. */
const internalRecord = (tags: readonly string[] | null | undefined) =>
  Object.fromEntries(
    (tags ?? []).flatMap((tag) => {
      if (!tag.startsWith(INTERNAL_PREFIX)) return [];
      const at = tag.indexOf("=");
      return at === -1 ? [] : [[tag.slice(0, at), tag.slice(at + 1)] as const];
    }),
  );

/** Whether `tags` carry this stack/stage/id's ownership tags. */
export const isOwnedGraph = (id: string, tags: readonly string[] | null | undefined) =>
  hasAlchemyTags(id, internalRecord(tags));

/** Whether `tags` carry any Alchemy ownership tag (used by `list`). */
export const hasAnyAlchemyGraphTag = (tags: readonly string[] | null | undefined) =>
  (tags ?? []).some((tag) => tag.startsWith(`${INTERNAL_PREFIX}stack=`));

/** User-facing tags (ownership tags removed). */
export const userGraphTags = (tags: readonly string[] | null | undefined): string[] =>
  (tags ?? []).filter((tag) => !tag.startsWith(INTERNAL_PREFIX));

/** Whether two tag sets hold the same strings. */
export const sameGraphTags = (
  observed: readonly string[] | null | undefined,
  desired: readonly string[],
) => {
  const a = new Set(observed ?? []);
  return a.size === new Set(desired).size && desired.every((tag) => a.has(tag));
};

/** `$filter` for objects Alchemy tagged (needs `consistencyLevel: "eventual"`). */
export const ALCHEMY_TAG_FILTER = "tags/any(t:startswith(t,'alchemy::stack='))";

/** `$filter` for objects tagged with the logical id `id`. */
export const idTagFilter = (id: string) =>
  `tags/any(t:t eq '${`${INTERNAL_PREFIX}id=${id}`.replaceAll("'", "''")}')`;

/**
 * Directory writes replicate asynchronously: for a few seconds after a
 * create, reads and writes of the new object (or of its application) fail
 * with these tags. Retried for up to 30 s.
 */
export const REPLICATION_LAG = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "ResourceNotFound" || e._tag === "NoBackingApplicationObject",
  schedule: Schedule.spaced("2 seconds"),
  times: 15,
} as const;

/**
 * Read an object Alchemy created and recorded: a `ResourceNotFound` within
 * the first ~30 s can be replication lag, not a deletion, so retry it
 * before reporting the object missing. Treating lag as "gone" would create
 * a duplicate.
 */
export const readRecorded = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E | MicrosoftGraphOpError, R>,
) =>
  orUndefinedIfGone(
    effect.pipe(
      Effect.retry({
        while: (e) => e._tag === "ResourceNotFound",
        schedule: Schedule.spaced("3 seconds"),
        times: 10,
      }),
    ),
  );

/** Map Graph's `ResourceNotFound` to `undefined`. */
export const orUndefinedIfGone = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E | MicrosoftGraphOpError, R>,
) => Effect.catchTag(effect, "ResourceNotFound", () => Effect.succeed(undefined));

/** A directory object was still readable after repeated deletes. */
export class DirectoryObjectDeleteTimedOut extends Data.TaggedError(
  "Azure.Entra.DirectoryObjectDeleteTimedOut",
)<{
  readonly objectId: string;
  readonly message: string;
}> {}

/**
 * Delete a directory object until reads stop returning it. A delete can
 * answer `ResourceNotFound` from a replica that has not seen the object
 * yet, so the delete is re-sent while the object is still readable (every
 * 3 s, for up to 2 minutes).
 */
export const deleteUntilGone = <A, R1, R2>(options: {
  readonly name: string;
  readonly objectId: string;
  readonly get: Effect.Effect<A | undefined, MicrosoftGraphOpError, R1>;
  readonly remove: Effect.Effect<unknown, MicrosoftGraphOpError, R2>;
}) =>
  Effect.gen(function* () {
    const once = Effect.gen(function* () {
      if ((yield* options.get) === undefined) return "gone" as const;
      yield* orUndefinedIfGone(options.remove);
      return "pending" as const;
    });
    const last = yield* once.pipe(
      Effect.repeat({
        until: (state) => state === "gone",
        schedule: Schedule.spaced("3 seconds"),
        times: 40,
      }),
    );
    if (last !== "gone") {
      return yield* new DirectoryObjectDeleteTimedOut({
        objectId: options.objectId,
        message: `${options.name} is still readable after repeated deletes`,
      });
    }
  });

/**
 * {@link deleteUntilGone}, then purge the object from the directory's
 * deleted items so it does not count toward the tenant quota for 30 days.
 */
export const deleteAndPurge = <A, R1, R2>(options: {
  readonly name: string;
  readonly objectId: string;
  readonly get: Effect.Effect<A | undefined, MicrosoftGraphOpError, R1>;
  readonly remove: Effect.Effect<unknown, MicrosoftGraphOpError, R2>;
}) =>
  Effect.gen(function* () {
    yield* deleteUntilGone(options);
    // The soft-deleted object shows up in deleted items a moment later.
    yield* orUndefinedIfGone(
      directory
        .deleteDeletedItems({ directoryObjectId: options.objectId })
        .pipe(Effect.retry({ ...REPLICATION_LAG, times: 5 })),
    );
  });
