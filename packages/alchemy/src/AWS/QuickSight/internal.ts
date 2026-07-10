import * as quicksight from "@distilled.cloud/aws/quicksight";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { diffTags } from "../../Tags.ts";

/**
 * A QuickSight resource whose asynchronous create/update has not converged
 * to a terminal status yet.
 */
export class QuickSightNotSettled extends Data.TaggedError(
  "QuickSightNotSettled",
)<{
  readonly resourceId: string;
  readonly status: string | undefined;
}> {}

/**
 * A QuickSight resource whose asynchronous create/update converged to a
 * `*_FAILED` status.
 */
export class QuickSightOperationFailed extends Data.TaggedError(
  "QuickSightOperationFailed",
)<{
  readonly resourceId: string;
  readonly status: string;
  readonly reason: string | undefined;
}> {}

const isInProgress = (status: string | undefined): boolean =>
  status === "CREATION_IN_PROGRESS" || status === "UPDATE_IN_PROGRESS";

const isFailed = (status: string | undefined): boolean =>
  status === "CREATION_FAILED" || status === "UPDATE_FAILED";

/**
 * Poll a QuickSight resource until its `ResourceStatus` reaches a terminal
 * value. `*_IN_PROGRESS` retries (bounded); `*_FAILED` fails immediately.
 * Creation/update of most QuickSight resources settles within a few seconds
 * (data-source connectivity validation can take longer) — budget ~2.5 min.
 */
export const waitForSettled = <
  A extends { status?: string },
  E extends { readonly _tag: string },
  R,
>(
  resourceId: string,
  read: Effect.Effect<A | undefined, E, R>,
): Effect.Effect<A | undefined, E | QuickSightOperationFailed, R> =>
  read.pipe(
    Effect.flatMap((observed) => {
      if (observed === undefined) return Effect.succeed(undefined);
      if (isFailed(observed.status)) {
        return Effect.fail(
          new QuickSightOperationFailed({
            resourceId,
            status: observed.status!,
            reason: undefined,
          }),
        );
      }
      if (isInProgress(observed.status)) {
        return Effect.fail(
          new QuickSightNotSettled({ resourceId, status: observed.status }),
        );
      }
      return Effect.succeed(observed);
    }),
    Effect.retry({
      while: (e) => e._tag === "QuickSightNotSettled",
      schedule: Schedule.fixed("5 seconds").pipe(
        Schedule.both(Schedule.recurs(30)),
      ),
    }),
    // The retry loop only re-raises QuickSightNotSettled; once the bounded
    // schedule is exhausted, fall back to one final read so the caller sees
    // the real (still-converging) resource rather than a spurious "gone".
    Effect.catchTag("QuickSightNotSettled", () => read),
  );

/**
 * Convert a QuickSight wire tag list into a plain record.
 */
export const toTagRecord = (
  tags: ReadonlyArray<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

/**
 * Read the observed tags of a QuickSight resource by ARN. Best-effort — a
 * failure (e.g. a race with deletion) reports no tags.
 */
export const readQuickSightTags = Effect.fn(function* (arn: string) {
  const response = yield* quicksight
    .listTagsForResource({ ResourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.Tags);
});

/**
 * Sync tags on a QuickSight resource: diff OBSERVED cloud tags against the
 * desired set and apply only the delta.
 */
export const syncQuickSightTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readQuickSightTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* quicksight.tagResource({ ResourceArn: arn, Tags: upsert });
  }
  if (removed.length > 0) {
    yield* quicksight.untagResource({ ResourceArn: arn, TagKeys: removed });
  }
});

/**
 * Convert a desired tag record into the wire tag list for create calls.
 * QuickSight requires a non-empty `Tags` list when supplied, so an empty
 * record maps to `undefined`.
 */
export const toWireTags = (
  tags: Record<string, string>,
): quicksight.Tag[] | undefined => {
  const entries = Object.entries(tags);
  return entries.length > 0
    ? entries.map(([Key, Value]) => ({ Key, Value }))
    : undefined;
};
