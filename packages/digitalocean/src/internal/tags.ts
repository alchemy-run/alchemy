import * as DO from "@distilled.cloud/digitalocean";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ignoreNotFound } from "./notFound.ts";
import { generationTagFor, isAlchemyTag, ownershipTagFor } from "./ownership.ts";

/** Resource kinds the tag API can tag. */
export type TaggableResourceType = "droplet" | "database" | "image" | "volume" | "volume_snapshot";

/** Fails when a user tag uses the reserved `alchemy:` prefix. */
export const rejectReservedTags = <E>(
  tags: ReadonlyArray<string> | undefined,
  onReserved: (tag: string) => E,
) =>
  Option.match(Arr.findFirst(tags ?? [], isAlchemyTag), {
    onNone: () => Effect.void,
    onSome: (tag) => Effect.fail(onReserved(tag)),
  });

/** The ownership tag of the logical resource and the tag of this generation. */
export const alchemyTagsFor = Effect.fn(function* (fqn: string, instanceId: string) {
  const ownershipTag = yield* ownershipTagFor(fqn);
  return [ownershipTag, generationTagFor(instanceId)];
});

/** User tags plus the alchemy tags, without repeats. */
export const desiredTagsFor = Effect.fn(function* (
  tags: ReadonlyArray<string> | undefined,
  fqn: string,
  instanceId: string,
) {
  const alchemyTags = yield* alchemyTagsFor(fqn, instanceId);
  return Arr.dedupe([...(tags ?? []), ...alchemyTags]);
});

const resourceRef = (resourceType: TaggableResourceType, resourceId: string | number) => ({
  resource_id: String(resourceId),
  resource_type: resourceType,
});

// The assign endpoint answers 404 for a tag that does not exist yet.
const assignTag = (tag: string, resource: ReturnType<typeof resourceRef>) => {
  const assignment = DO.assignTagResources({ tag_id: tag, resources: [resource] });
  return assignment.pipe(
    Effect.catchTag("NotFound", () => DO.createTag({ name: tag }).pipe(Effect.andThen(assignment))),
  );
};

/**
 * Deletes a tag that no resource carries any more. DigitalOcean keeps a tag
 * after the last resource is untagged or destroyed. Deleting a tag removes it
 * from every resource, so a tag in use is left alone.
 */
export const deleteTagIfUnused = Effect.fn(function* (tag: string) {
  const observed = yield* DO.getTag({ tag_id: tag }).pipe(
    Effect.map((response) => Option.some(response.tag)),
    Effect.catchTag("NotFound", () => Effect.succeedNone),
  );
  if (Option.isNone(observed)) return;
  if ((observed.value.resources?.count ?? 0) > 0) return;
  yield* ignoreNotFound(DO.deleteTag({ tag_id: tag }));
});

export const deleteTagsIfUnused = (tags: ReadonlyArray<string>) =>
  Effect.forEach(tags, deleteTagIfUnused, { concurrency: "unbounded", discard: true });

const unassignTag = Effect.fn(function* (tag: string, resource: ReturnType<typeof resourceRef>) {
  yield* ignoreNotFound(DO.unassignTagResources({ tag_id: tag, resources: [resource] }));
  if (isAlchemyTag(tag)) yield* deleteTagIfUnused(tag);
});

/**
 * Converges a resource's tags on `desired`. The observed tags are the
 * baseline, so an adopted resource loses tags Alchemy was not asked to keep.
 * An alchemy tag that no resource carries afterwards is deleted.
 */
export const syncTags = (
  resourceType: TaggableResourceType,
  resourceId: string | number,
  observed: ReadonlyArray<string>,
  desired: ReadonlyArray<string>,
) => {
  const resource = resourceRef(resourceType, resourceId);
  return Effect.all(
    [
      ...Arr.difference(desired, observed).map((tag) => assignTag(tag, resource)),
      ...Arr.difference(observed, desired).map((tag) => unassignTag(tag, resource)),
    ],
    { concurrency: "unbounded", discard: true },
  );
};
