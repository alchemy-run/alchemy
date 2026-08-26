import * as translate from "@distilled.cloud/gcp/translate_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const DEFAULT_LOCATION = "us-central1";
/** Adaptive MT and AutoML models are regional; glossaries also allow `global`. */
export const LIST_LOCATIONS = ["us-central1", "global"] as const;
export const MODEL_LIST_LOCATIONS = ["us-central1"] as const;
export const MAX_DISPLAY_NAME_LENGTH = 32;
export const MAX_DESCRIPTION_LENGTH = 2048;
export const MAX_ID_LENGTH = 63;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.Translate.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.Translate.ResourceStillExists",
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

export const locationParent = (project: string, location: string | undefined) =>
  `projects/${project}/locations/${normalizeLocation(location)}`;

export const locationParentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const locationsAt = parts.lastIndexOf("locations");
  if (locationsAt >= 0 && parts[locationsAt + 1]) {
    return parts.slice(0, locationsAt + 2).join("/");
  }
  return parts.slice(0, Math.max(0, parts.length - 2)).join("/");
};

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
  if (value.includes("/")) return value.replace(/\/+$/, "");
  return `${locationParent(project, location)}/${collection}/${value}`;
};

export const resourceNameOf = (
  parent: string,
  collection: string,
  id: string,
) => {
  if (id.length === 0) return "";
  if (id.includes(`/${collection}/`)) return id.replace(/\/+$/, "");
  return `${parent}/${collection}/${lastSegment(id)}`;
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

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

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousLocation?: string;
  nextLocation?: string;
  previousParent?: string;
  nextParent?: string;
  extra?: boolean;
}) => {
  const previousLocation =
    input.previousLocation !== undefined
      ? normalizeLocation(input.previousLocation)
      : undefined;
  const nextLocation =
    input.nextLocation !== undefined
      ? normalizeLocation(input.nextLocation)
      : undefined;
  const replace =
    (input.extra ?? false) ||
    (input.previousId !== undefined &&
      input.nextId !== undefined &&
      input.nextId !== input.previousId) ||
    (previousLocation !== undefined &&
      nextLocation !== undefined &&
      previousLocation !== nextLocation) ||
    (input.previousParent !== undefined &&
      input.nextParent !== undefined &&
      input.previousParent !== input.nextParent);
  if (!replace) return undefined;
  const samePhysical =
    (previousLocation === undefined || previousLocation === nextLocation) &&
    (input.previousParent === undefined ||
      input.previousParent === input.nextParent) &&
    input.previousId !== undefined &&
    input.nextId === input.previousId;
  return {
    action: "replace" as const,
    deleteFirst: samePhysical,
  };
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined && explicit.length > 0) {
      return lastSegment(explicit);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing;
    }
    return yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
  });

const sanitizePart = (value: string) => {
  const cleaned = value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return cleaned.length > 0 ? cleaned : "x";
};

const restrictedMarkerOf = (stack: string, stage: string, id: string) =>
  `alc_${stack}_${stage}_${id}`;

const shrinkRestricted = (
  labels: Record<string, string>,
  user: string,
  maxLength: number,
) => {
  let stack = sanitizePart(labels[alchemyLabelKeys.stack] ?? "x");
  let stage = sanitizePart(labels[alchemyLabelKeys.stage] ?? "x");
  let id = sanitizePart(labels[alchemyLabelKeys.id] ?? "x");
  let extra = user;
  const build = () => {
    const marker = restrictedMarkerOf(stack, stage, id);
    return extra.length > 0 ? `${marker}_${extra}` : marker;
  };
  let marker = build();
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (id.length >= stack.length && id.length >= stage.length) {
      id = id.slice(0, -1);
    } else if (stage.length >= stack.length) {
      stage = stage.slice(0, -1);
    } else {
      stack = stack.slice(0, -1);
    }
    marker = build();
  }
  while (marker.length > maxLength && extra.length > 0) {
    extra = extra.slice(0, -1);
    marker = build();
  }
  return marker.slice(0, maxLength);
};

/**
 * Adaptive MT datasets and custom models only accept display names of
 * A-Z, a-z, 0-9, and underscore, max 32 characters. Ownership is packed
 * as `alc_{stack}_{stage}_{id}` so `list` / nuke can still find them.
 */
export const encodeRestrictedDisplayName = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
): string =>
  shrinkRestricted(labels, text ? sanitizePart(text) : "", maxLength);

export const parseRestrictedDisplayName = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("alc_")) {
    return { labels: {}, text };
  }
  const parts = text.slice("alc_".length).split("_");
  const labels: Record<string, string> = {};
  if (parts[0]) labels[alchemyLabelKeys.stack] = parts[0]!;
  if (parts[1]) labels[alchemyLabelKeys.stage] = parts[1]!;
  if (parts[2]) labels[alchemyLabelKeys.id] = parts[2]!;
  const rest = parts.slice(3).join("_");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const compactMarkerOf = (stack: string, stage: string, id: string) =>
  `[alc ${stack} ${stage} ${id}]`;

const shrinkMarker = (
  labels: Record<string, string>,
  maxLength: number,
  build: (stack: string, stage: string, id: string) => string,
) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = build(stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = build(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DESCRIPTION_LENGTH,
): string => {
  const marker =
    maxLength < 54
      ? shrinkMarker(labels, maxLength, compactMarkerOf)
      : shrinkMarker(labels, maxLength, markerOf);
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return marker;
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (text?.startsWith("[alc ")) {
    const end = text.indexOf("]");
    if (end < 0) return { labels: {}, text };
    const parts = text.slice("[alc ".length, end).trim().split(/\s+/);
    const labels: Record<string, string> = {};
    if (parts[0]) labels[alchemyLabelKeys.stack] = parts[0]!;
    if (parts[1]) labels[alchemyLabelKeys.stage] = parts[1]!;
    if (parts[2]) labels[alchemyLabelKeys.id] = parts[2]!;
    const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
    return { labels, text: rest.length > 0 ? rest : undefined };
  }
  if (!text?.startsWith("[alchemy ")) {
    return parseRestrictedDisplayName(text);
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const retryTransient = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "TooManyRequests" || error._tag === "UnknownGCPError",
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
  );

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<void, E | ResourceStillExists, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new ResourceStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Translate.ResourceStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.asVoid,
  );

export const collectPages = <Page, Item, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk) as Item[]),
  );

const emptyList = <A>() => Effect.succeed<A[]>([]);

export const listLocationParents = (
  project: string,
  locations: readonly string[] = LIST_LOCATIONS,
) => locations.map((location) => locationParent(project, location));

export const listAdaptiveMtDatasetsAt = (parent: string) =>
  parent.length === 0
    ? emptyList<translate.AdaptiveMtDataset>()
    : collectPages(
        translate.listProjectsLocationsAdaptiveMtDatasets.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.adaptiveMtDatasets,
      ).pipe(
        Effect.catchTag(["NotFound", "Forbidden"], () =>
          emptyList<translate.AdaptiveMtDataset>(),
        ),
      );

export const listModelsAt = (parent: string) =>
  parent.length === 0
    ? emptyList<translate.Model>()
    : collectPages(
        translate.listProjectsLocationsModels.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.models,
      ).pipe(
        Effect.catchTag(["NotFound", "Forbidden"], () =>
          emptyList<translate.Model>(),
        ),
      );

export const listGlossariesAt = (parent: string) =>
  parent.length === 0
    ? emptyList<translate.Glossary>()
    : collectPages(
        translate.listProjectsLocationsGlossaries.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.glossaries,
      ).pipe(
        Effect.catchTag(["NotFound", "Forbidden"], () =>
          emptyList<translate.Glossary>(),
        ),
      );

export const listGlossaryEntriesAt = (parent: string) =>
  parent.length === 0
    ? emptyList<translate.GlossaryEntry>()
    : collectPages(
        translate.listProjectsLocationsGlossariesGlossaryEntries.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.glossaryEntries,
      ).pipe(
        Effect.catchTag(["NotFound", "Forbidden"], () =>
          emptyList<translate.GlossaryEntry>(),
        ),
      );

export const listProjectAdaptiveMtDatasets = (project: string) =>
  Effect.gen(function* () {
    const parents = listLocationParents(project, MODEL_LIST_LOCATIONS);
    const groups = yield* Effect.forEach(parents, listAdaptiveMtDatasetsAt, {
      concurrency: 2,
    });
    const seen = new Set<string>();
    const datasets: translate.AdaptiveMtDataset[] = [];
    for (const dataset of groups.flat()) {
      const name = dataset.name ?? "";
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      datasets.push(dataset);
    }
    return datasets;
  });

export const listProjectModels = (project: string) =>
  Effect.gen(function* () {
    const parents = listLocationParents(project, MODEL_LIST_LOCATIONS);
    const groups = yield* Effect.forEach(parents, listModelsAt, {
      concurrency: 2,
    });
    const seen = new Set<string>();
    const models: translate.Model[] = [];
    for (const model of groups.flat()) {
      const name = model.name ?? "";
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      models.push(model);
    }
    return models;
  });

export const listProjectGlossaryEntries = (project: string) =>
  Effect.gen(function* () {
    const parents = listLocationParents(project);
    const glossaries = (yield* Effect.forEach(parents, listGlossariesAt, {
      concurrency: 2,
    })).flat();
    const groups = yield* Effect.forEach(
      glossaries.map((glossary) => glossary.name ?? ""),
      listGlossaryEntriesAt,
      { concurrency: 2 },
    );
    const seen = new Set<string>();
    const entries: translate.GlossaryEntry[] = [];
    for (const entry of groups.flat()) {
      const name = entry.name ?? "";
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      entries.push(entry);
    }
    return entries;
  });

export const findOwnedByDisplayName = <
  T extends { name?: string; displayName?: string },
>(
  id: string,
  items: readonly T[],
) =>
  Effect.gen(function* () {
    for (const item of items) {
      if (yield* ownedByAlchemy(id, item.displayName)) return item;
    }
    return undefined as T | undefined;
  });

export const findOwnedByDescription = <
  T extends { name?: string; description?: string },
>(
  id: string,
  items: readonly T[],
) =>
  Effect.gen(function* () {
    for (const item of items) {
      if (yield* ownedByAlchemy(id, item.description)) return item;
    }
    return undefined as T | undefined;
  });
