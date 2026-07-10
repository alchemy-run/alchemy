import * as personalize from "@distilled.cloud/aws/personalize";
import * as Effect from "effect/Effect";
import { diffTags } from "../../Tags.ts";

/**
 * Coerce a Personalize wire tag list (`{ tagKey, tagValue }[]`, values may be
 * `Redacted`) into a plain `Record<string, string>`.
 */
export const toTagRecord = (
  tags: personalize.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? []).map((t) => [String(t.tagKey), String(t.tagValue)] as const),
  );

/**
 * Read the observed tags of a Personalize resource by ARN. Tag reads are
 * best-effort — a failure (e.g. a race with deletion) reports no tags.
 */
export const readPersonalizeTags = Effect.fn(function* (arn: string) {
  const response = yield* personalize
    .listTagsForResource({ resourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.tags);
});

/**
 * Sync tags on a Personalize resource: diff the OBSERVED cloud tags against
 * the desired set and apply only the delta.
 */
export const syncPersonalizeTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readPersonalizeTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* personalize.tagResource({
      resourceArn: arn,
      tags: upsert.map((t) => ({ tagKey: t.Key, tagValue: t.Value })),
    });
  }
  if (removed.length > 0) {
    yield* personalize.untagResource({ resourceArn: arn, tagKeys: removed });
  }
});
