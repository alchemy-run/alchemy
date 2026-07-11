import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { diffTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";

/**
 * Image Builder rejects deletion of a resource that another resource still
 * references (e.g. a component referenced by a not-yet-deleted recipe, or a
 * recipe referenced by a pipeline) with `ResourceDependencyException`.
 * During a replacement the engine deletes the displaced resources without
 * ordering guarantees, so retry through the window while the dependents are
 * deleted (bounded).
 */
export const retryWhileDependedOn = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ResourceDependencyException",
    schedule: Schedule.fixed("5 seconds").pipe(
      Schedule.both(Schedule.recurs(12)),
    ),
  });

/**
 * Convert an Image Builder wire tag map (values may be undefined) into a
 * plain string record.
 */
export const toTagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

/**
 * Read the observed tags of an Image Builder resource. Tag reads are
 * best-effort — a failure (e.g. a race with deletion) reports no tags.
 */
export const readImageBuilderTags = Effect.fn(function* (arn: string) {
  const response = yield* imagebuilder
    .listTagsForResource({ resourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.tags);
});

/**
 * Sync tags on an Image Builder resource: diff the OBSERVED cloud tags
 * against the desired set and apply only the delta.
 */
export const syncImageBuilderTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readImageBuilderTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* imagebuilder.tagResource({
      resourceArn: arn,
      tags: Object.fromEntries(upsert.map((tag) => [tag.Key, tag.Value])),
    });
  }
  if (removed.length > 0) {
    yield* imagebuilder.untagResource({ resourceArn: arn, tagKeys: removed });
  }
});

/**
 * Construct the deterministic ARN of an Image Builder resource in the
 * ambient account/region. Image Builder lowercases resource names in ARNs.
 *
 * @param resourceType e.g. `image-recipe`, `infrastructure-configuration`
 * @param resourcePath the name (plus `/{version}` segments where relevant)
 */
export const imageBuilderArn = Effect.fn(function* (
  resourceType: string,
  resourcePath: string,
) {
  const { accountId, region } = yield* AWSEnvironment.current;
  return `arn:aws:imagebuilder:${region}:${accountId}:${resourceType}/${resourcePath.toLowerCase()}`;
});

/**
 * Structural drift check between the desired value the user specified and
 * the observed cloud value. `undefined` desired values are "unspecified"
 * (no drift — the service fills defaults we must not fight). Objects are
 * compared as subsets: every key the user specified must match; extra
 * observed keys (server defaults) are ignored. Arrays compare length +
 * element-wise.
 */
export const driftedFrom = (observed: unknown, desired: unknown): boolean => {
  if (desired === undefined) return false;
  if (observed === undefined) return true;
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed) || observed.length !== desired.length) {
      return true;
    }
    return desired.some((item, index) => driftedFrom(observed[index], item));
  }
  if (typeof desired === "object" && desired !== null) {
    if (typeof observed !== "object" || observed === null) return true;
    return Object.entries(desired).some(([key, value]) =>
      driftedFrom((observed as Record<string, unknown>)[key], value),
    );
  }
  return observed !== desired;
};
