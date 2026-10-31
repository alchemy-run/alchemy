import * as notifications from "@distilled.cloud/aws/notifications";
import { createInternalTags, diffTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import { withGlobalRegion } from "../Region.ts";

/**
 * AWS User Notifications is managed from a single control-plane region.
 * Every management API call must target the partition's global region
 * (`us-east-1` in `aws`) regardless of the ambient stack region (other
 * regions reject with "API ...Activity cannot be called in us-west-2. Use
 * us-east-1 instead"), so we pin the region on every distilled operation.
 */
export const pinNotificationsRegion = withGlobalRegion;

/**
 * Read the observed tags on a User Notifications resource, tolerating a
 * not-yet-visible resource (returns `{}`).
 */
export const readNotificationsTags = Effect.fn(function* (arn: string) {
  return yield* pinNotificationsRegion(
    notifications.listTagsForResource({ arn }).pipe(
      Effect.map((r) => (r.tags ?? {}) as Record<string, string>),
      Effect.catchTag(["ResourceNotFoundException", "ValidationException"], () =>
        Effect.succeed({} as Record<string, string>),
      ),
    ),
  );
});

/**
 * Converge the tags on a User Notifications resource to the desired user
 * tags merged with the internal Alchemy ownership tags, diffing against
 * OBSERVED cloud tags so adoption converges.
 */
export const syncNotificationsTags = Effect.fn(function* (
  arn: string,
  id: string,
  userTags: Record<string, string> | undefined,
) {
  const internalTags = yield* createInternalTags(id);
  const desired = { ...userTags, ...internalTags };
  const observed = yield* readNotificationsTags(arn);
  const { upsert, removed } = diffTags(observed, desired);
  if (upsert.length > 0) {
    yield* pinNotificationsRegion(
      notifications.tagResource({
        arn,
        tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
      }),
    );
  }
  if (removed.length > 0) {
    yield* pinNotificationsRegion(notifications.untagResource({ arn, tagKeys: removed }));
  }
});
