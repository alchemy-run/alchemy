import * as oam from "@distilled.cloud/aws/oam";
import * as Effect from "effect/Effect";
import { createInternalTags, diffTags } from "../../Tags.ts";

/**
 * Read the observed tags on an OAM sink or link, tolerating a
 * not-yet-visible resource (returns `{}`).
 */
export const readOamTags = Effect.fn(function* (resourceArn: string) {
  return yield* oam.listTagsForResource({ ResourceArn: resourceArn }).pipe(
    Effect.map((r) => (r.Tags ?? {}) as Record<string, string>),
    Effect.catchTag(["ResourceNotFoundException", "ValidationException"], () =>
      Effect.succeed({} as Record<string, string>),
    ),
  );
});

/**
 * Converge the tags on an OAM sink or link to the desired user tags merged
 * with the internal Alchemy ownership tags, diffing against OBSERVED cloud
 * tags so adoption converges.
 */
export const syncOamTags = Effect.fn(function* (
  resourceArn: string,
  id: string,
  userTags: Record<string, string> | undefined,
) {
  const internalTags = yield* createInternalTags(id);
  const desired = { ...(userTags ?? {}), ...internalTags };
  const observed = yield* readOamTags(resourceArn);
  const { upsert, removed } = diffTags(observed, desired);
  if (upsert.length > 0) {
    yield* oam.tagResource({
      ResourceArn: resourceArn,
      Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
    });
  }
  if (removed.length > 0) {
    yield* oam.untagResource({ ResourceArn: resourceArn, TagKeys: removed });
  }
});
