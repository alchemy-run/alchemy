import * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { requireOrganizationId, StackitEnvironment } from "../Environment.ts";
import { diffLabels, labelRecord } from "../Labels.ts";

/**
 * Longest project/folder name STACKIT accepts without spaces: the name regex
 * is `^[a-zA-ZäüöÄÜÖ0-9]( ?[a-zA-ZäüöÄÜÖß0-9_+&-]){1,40}$`.
 */
export const CONTAINER_NAME_MAX_LENGTH = 41;

/** The user's name, or a deterministic one derived from stack, stage and logical id. */
export const containerName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, maxLength: CONTAINER_NAME_MAX_LENGTH });

/** The parent to deploy into: the prop, else the profile's organization. */
export const desiredParent = Effect.fn(function* (parentId: string | undefined) {
  if (parentId !== undefined) return parentId;
  const env = yield* StackitEnvironment.current;
  return yield* requireOrganizationId(env);
});

/** A Resource Manager list kept returning full pages past {@link MAX_PAGES}. */
export class ResourceManagerPaginationLimit extends Data.TaggedError(
  "Stackit.ResourceManager.PaginationLimit",
)<{ readonly operation: string; readonly message: string }> {}

const PAGE_SIZE = 100;
const MAX_PAGES = 1000;

/**
 * Exhaust an offset/limit-paginated Resource Manager list operation. The
 * response's `limit` is the page size the API actually used (it caps the
 * requested one), so a short page ends the listing.
 */
export const listAll = <Item, E, R>(
  operation: string,
  page: (input: {
    offset: number;
    limit: number;
  }) => Effect.Effect<{ readonly items: ReadonlyArray<Item>; readonly limit: number }, E, R>,
): Effect.Effect<Item[], E | ResourceManagerPaginationLimit, R> =>
  Effect.gen(function* () {
    const all: Item[] = [];
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const response = yield* page({ offset: all.length, limit: PAGE_SIZE });
      all.push(...response.items);
      if (response.items.length === 0 || response.items.length < response.limit) return all;
    }
    return yield* new ResourceManagerPaginationLimit({
      operation,
      message: `${operation} returned more than ${MAX_PAGES} full pages; refusing to keep paginating`,
    });
  });

/** Every folder directly under container `containerParentId`. */
export const listChildFolders = (containerParentId: string) =>
  listAll("ListFolders", ({ offset, limit }) =>
    resourceManager.listFolders({ containerParentId, offset, limit }),
  );

/** Every project directly under container `containerParentId`. */
export const listChildProjects = (containerParentId: string) =>
  listAll("ListProjects", ({ offset, limit }) =>
    resourceManager.listProjects({ containerParentId, offset, limit }),
  );

/**
 * Every folder in the tree below container `rootId` (an organization or
 * folder), breadth first. Fails loudly on any list error.
 */
export const listFolderTree = Effect.fn(function* (rootId: string) {
  const folders: resourceManager.ListFoldersResponseItemsItem[] = [];
  const seen = new Set<string>([rootId]);
  let frontier = [rootId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const parent of frontier) {
      for (const folder of yield* listChildFolders(parent)) {
        if (seen.has(folder.containerId)) continue;
        seen.add(folder.containerId);
        folders.push(folder);
        next.push(folder.containerId);
      }
    }
    frontier = next;
  }
  return folders;
});

/** Whether `desired` (a containerId or UUID) names the observed parent. */
export const isParent = (parent: resourceManager.Parent, desired: string) =>
  parent.containerId === desired || parent.id === desired;

/**
 * The `labels` field of a Resource Manager PATCH that converges observed
 * labels on `desired`, or `undefined` when nothing changed. Changed and new
 * keys carry their value, removed keys `null` (which deletes a label), so
 * the request is correct whether the API merges or replaces the map.
 * Keys in `ignore` are neither set nor removed (create-only labels).
 */
export const labelsUpdate = (
  observed: unknown,
  desired: Record<string, string>,
  ignore: ReadonlyArray<string> = [],
): resourceManager.UpdateLabels | undefined => {
  const keep = (key: string) => !ignore.includes(key);
  const observedLabels = Object.fromEntries(
    Object.entries(labelRecord(observed)).filter(([key]) => keep(key)),
  );
  const desiredLabels = Object.fromEntries(Object.entries(desired).filter(([key]) => keep(key)));
  const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
  if (upsert.length === 0 && removed.length === 0) return undefined;
  return {
    ...desiredLabels,
    ...Object.fromEntries(removed.map((key) => [key, null])),
  };
};
