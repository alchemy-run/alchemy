import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
} from "../Labels.ts";

export const DEFAULT_LOCATION = "us-central1";
export const MAX_ID_LENGTH = 63;
export const MAX_ENTITY_ID_LENGTH = 256;

export class DataplexNotResolved extends Data.TaggedError(
  "GCP.Dataplex.NotResolved",
)<{
  name: string;
}> {}

export class DataplexStillExists extends Data.TaggedError(
  "GCP.Dataplex.StillExists",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const parseResourceName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
    parent:
      collectionAt > 0
        ? parts.slice(0, collectionAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const expandParent = (
  value: string,
  project: string,
  location: string,
  collection: string,
) => {
  if (value.includes("/")) return value;
  return `projects/${project}/locations/${location}/${collection}/${value}`;
};

export const rfc1035 = (name: string, maxLength = MAX_ID_LENGTH): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `a${next}`;
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  if (next.length === 0) return "dataplex";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, maxLength - 1)}0`;
  return next.slice(0, maxLength);
};

export const snakeId = (
  name: string,
  maxLength = MAX_ENTITY_ID_LENGTH,
): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(next)) next = `e${next}`;
  next = next.slice(0, maxLength).replace(/_+$/g, "");
  if (next.length === 0) return "entity";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, maxLength - 1)}0`;
  return next.slice(0, maxLength);
};

export const toPhysicalRfc1035 = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return rfc1035(explicit, maxLength);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({ id, maxLength, lowercase: true }),
      maxLength,
    );
  });

export const toPhysicalSnake = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ENTITY_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return snakeId(explicit, maxLength);
    if (existing !== undefined) return existing;
    return snakeId(
      yield* createPhysicalName({
        id,
        maxLength,
        lowercase: true,
        delimiter: "_",
      }),
      maxLength,
    );
  });

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

export const ownedLabels = (id: string, labels: Record<string, string>) =>
  hasAlchemyLabels(id, labels);

const markerOf = (labels: Record<string, string>) =>
  `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;

export const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = markerOf(labels);
  return description ? `${marker}\n${description}` : marker;
};

export const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseDescription(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const createOwnership = (id: string) => createInternalLabels(id);

export const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, canonical(item)] as const)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries);
  }
  return undefined;
};

export const fingerprint = (value: unknown): string =>
  JSON.stringify(canonical(value) ?? null);

export const sameJson = (left: unknown, right: unknown) =>
  fingerprint(left) === fingerprint(right);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify([...(left ?? [])].sort()) ===
  JSON.stringify([...(right ?? [])].sort());

export const isPendingState = (state: string | undefined) =>
  state === "CREATING" ||
  state === "DELETING" ||
  state === "UPDATING" ||
  state === "STATE_UNSPECIFIED" ||
  state === undefined ||
  state === "";

export const collectPages = <Page, Item, E, R>(
  stream: Stream.Stream<Page, E, R>,
  pick: (page: Page) => readonly Item[] | undefined,
) =>
  stream.pipe(
    Stream.flatMap((page) => Stream.fromIterable(pick(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

const emptyOnMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A[], E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error) => error._tag === "NotFound" || error._tag === "Forbidden",
      () => Effect.succeed([] as A[]),
    ),
  );

export const listLakes = (project: string, location: string) =>
  emptyOnMissing(
    collectPages(
      dataplex.listProjectsLocationsLakes.pages({
        parent: locationParent(project, location),
        pageSize: 1000,
      }),
      (page) => page.lakes,
    ),
  );

export const listGlossaries = (project: string, location: string) =>
  emptyOnMissing(
    collectPages(
      dataplex.listProjectsLocationsGlossaries.pages({
        parent: locationParent(project, location),
        pageSize: 1000,
      }),
      (page) => page.glossaries,
    ),
  );

export const listTerms = (glossary: string) =>
  emptyOnMissing(
    collectPages(
      dataplex.listProjectsLocationsGlossariesTerms.pages({
        parent: glossary,
        pageSize: 1000,
      }),
      (page) => page.terms,
    ),
  );

export const listTasks = (lake: string) =>
  emptyOnMissing(
    collectPages(
      dataplex.listProjectsLocationsLakesTasks.pages({
        parent: lake,
        pageSize: 1000,
      }),
      (page) => page.tasks,
    ),
  );

export const listZones = (lake: string) =>
  emptyOnMissing(
    collectPages(
      dataplex.listProjectsLocationsLakesZones.pages({
        parent: lake,
        pageSize: 1000,
      }),
      (page) => page.zones,
    ),
  );

export const listAssets = (zone: string) =>
  emptyOnMissing(
    collectPages(
      dataplex.listProjectsLocationsLakesZonesAssets.pages({
        parent: zone,
        pageSize: 1000,
      }),
      (page) => page.assets,
    ),
  );

export const listEntities = (
  zone: string,
  view: dataplex.ListProjectsLocationsLakesZonesEntitiesViewEnum,
) =>
  emptyOnMissing(
    collectPages(
      dataplex.listProjectsLocationsLakesZonesEntities.pages({
        parent: zone,
        view,
        pageSize: 500,
      }),
      (page) => page.entities,
    ),
  );

export const listPartitions = (entity: string) =>
  emptyOnMissing(
    collectPages(
      dataplex.listProjectsLocationsLakesZonesEntitiesPartitions.pages({
        parent: entity,
        pageSize: 500,
      }),
      (page) => page.partitions,
    ),
  );

export const listMetadataFeeds = (project: string, location: string) =>
  emptyOnMissing(
    collectPages(
      dataplex.listProjectsLocationsMetadataFeeds.pages({
        parent: locationParent(project, location),
        pageSize: 1000,
      }),
      (page) => page.metadataFeeds,
    ),
  );

export const listChildResources = <A, E, R>(
  lakes: readonly dataplex.GoogleCloudDataplexV1Lake[],
  list: (lakeName: string) => Effect.Effect<A[], E, R>,
) =>
  Effect.forEach(
    lakes.filter((lake) => (lake.name ?? "").length > 0),
    (lake) => list(lake.name!),
    { concurrency: 4 },
  ).pipe(Effect.map((groups) => groups.flat()));

export const replaceIfChanged = (
  previous: string | undefined,
  next: string | undefined,
) => previous !== undefined && next !== undefined && previous !== next;
