import * as forecast from "@distilled.cloud/aws/forecast";
import * as Effect from "effect/Effect";
import { diffTags } from "../../Tags.ts";

/**
 * Coerce a Forecast wire tag list (`{ Key, Value }[]`, values may be
 * `Redacted`) into a plain `Record<string, string>`.
 */
export const toTagRecord = (
  tags: forecast.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? []).map((t) => [String(t.Key), String(t.Value)] as const),
  );

/**
 * Read the observed tags of a Forecast resource by ARN. Tag reads are
 * best-effort — a failure (e.g. a race with deletion) reports no tags.
 */
export const readForecastTags = Effect.fn(function* (arn: string) {
  const response = yield* forecast
    .listTagsForResource({ ResourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.Tags);
});

/**
 * Sync tags on a Forecast resource: diff the OBSERVED cloud tags against the
 * desired set and apply only the delta.
 */
export const syncForecastTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readForecastTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* forecast.tagResource({
      ResourceArn: arn,
      Tags: upsert.map((t) => ({ Key: t.Key, Value: t.Value })),
    });
  }
  if (removed.length > 0) {
    yield* forecast.untagResource({ ResourceArn: arn, TagKeys: removed });
  }
});
