import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
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

export const DEFAULT_LOCATION = "global";
export const DEFAULT_COLLECTION = "default_collection";
export const DEFAULT_BRANCH = "default_branch";
export const LIST_LOCATIONS = ["global"] as const;
export const MAX_ID_LENGTH = 63;
export const MAX_NAME_LENGTH = MAX_ID_LENGTH;
export const MAX_DOCUMENT_ID_LENGTH = 128;
export const MAX_DISPLAY_NAME_LENGTH = 128;

export class DiscoveryengineOperationFailed extends Data.TaggedError(
  "GCP.Discoveryengine.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class DiscoveryengineOperationPending extends Data.TaggedError(
  "GCP.Discoveryengine.OperationPending",
)<{
  operation: string;
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

export const parentOf = (name: string, collection?: string) => {
  if (collection !== undefined) {
    const marker = `/${collection}/`;
    const index = name.lastIndexOf(marker);
    return index >= 0 ? name.slice(0, index) : name;
  }
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const parentBefore = parentOf;

export const parseResourceName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const dataStoresAt = parts.lastIndexOf("dataStores");
  const collectionsAt = parts.lastIndexOf("collections");
  const collectionId =
    collectionsAt >= 0 && parts[collectionsAt + 1]
      ? parts[collectionsAt + 1]!
      : DEFAULT_COLLECTION;
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    collection: collectionId,
    collectionId,
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
    dataStoreId:
      dataStoresAt >= 0 && parts[dataStoresAt + 1]
        ? parts[dataStoresAt + 1]!
        : "",
    dataStore:
      dataStoresAt >= 0
        ? parts.slice(0, dataStoresAt + 2).join("/")
        : parentOf(name),
    parent:
      collectionAt > 0
        ? parts.slice(0, collectionAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const expandDataStore = (
  value: string,
  project: string,
  location: string,
) =>
  value.includes("/")
    ? value
    : `projects/${project}/locations/${location}/collections/${DEFAULT_COLLECTION}/dataStores/${value}`;

export const rfc1035 = (name: string, maxLength = MAX_ID_LENGTH): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `a${next}`;
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  if (next.length === 0) return "resource";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, maxLength - 1)}0`;
  return next.slice(0, maxLength);
};

export const controlIdOf = (
  name: string,
  maxLength = MAX_ID_LENGTH,
): string => {
  let next = name
    .toLowerCase()
    .replace(/[0-9]/g, (digit) => "abcdefghij"[Number(digit)]!)
    .replace(/[^a-z_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `c${next}`;
  next = next.slice(0, maxLength).replace(/[-_]+$/g, "");
  return next.length > 0 ? next : "control";
};

export const servingConfigIdOf = (
  name: string,
  maxLength = MAX_ID_LENGTH,
): string => {
  let next = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!/^[a-z]/.test(next)) next = `s${next}`;
  next = next.slice(0, maxLength);
  if (next.length < 4) next = `${next}xxxx`.slice(0, 4);
  return next.length > 0 ? next : "scfg";
};

export const sessionIdOf = (
  name: string,
  maxLength = MAX_ID_LENGTH,
): string => {
  let next = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!/^[a-z]/.test(next)) next = `s${next}`;
  next = next.slice(0, maxLength);
  return next.length > 0 ? next : "session";
};

export const identityMappingStoreIdOf = (name: string): string => {
  const body = rfc1035(name, 59);
  const prefixed = body.startsWith("alch") ? body : `alch${body}`;
  return prefixed.slice(0, MAX_ID_LENGTH);
};

export const toPhysical = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  format: (name: string) => string,
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return format(
      yield* createPhysicalName({
        id,
        maxLength,
        lowercase: true,
      }),
    );
  });

const markerOf = (labels: Record<string, string>) =>
  `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
  separator: "\n" | " " = " ",
): string => {
  const marker = markerOf(labels);
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0
    ? `${marker}${separator}${trimmed}`
    : marker;
};

const compactMarkerOf = (labels: Record<string, string>) =>
  `[alc ${labels[alchemyLabelKeys.stack]}|${labels[alchemyLabelKeys.stage]}|${labels[alchemyLabelKeys.id]}]`;

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
): string => {
  const marker = compactMarkerOf(labels);
  const trimmed = text?.trim();
  if (!trimmed) return marker.slice(0, maxLength);
  const combined = `${trimmed} ${marker}`;
  if (combined.length <= maxLength) return combined;
  const budget = maxLength - marker.length - 1;
  if (budget <= 0) return marker.slice(0, maxLength);
  return `${trimmed.slice(0, budget)} ${marker}`.slice(0, maxLength);
};

const parseOwnershipMarker = (text: string) => {
  const labels: Record<string, string> = {};
  const end = text.indexOf("]");
  if (end < 0) return { labels, rest: text, end: -1 };
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  return { labels, rest: text.slice(end + 1), end };
};

const parseCompactMarker = (text: string) => {
  const end = text.indexOf("]");
  if (!text.startsWith("[alc ") || end < 0) {
    return { labels: {} as Record<string, string>, rest: text };
  }
  const parts = text.slice("[alc ".length, end).split("|");
  const labels: Record<string, string> = {};
  if (parts[0]) labels[alchemyLabelKeys.stack] = parts[0];
  if (parts[1]) labels[alchemyLabelKeys.stage] = parts[1];
  if (parts[2]) labels[alchemyLabelKeys.id] = parts[2];
  return { labels, rest: text.slice(end + 1) };
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text) return { labels: {}, text };
  const compactAt = text.indexOf("[alc ");
  const verboseAt = text.indexOf("[alchemy ");
  if (verboseAt >= 0 && (compactAt < 0 || verboseAt <= compactAt)) {
    const before = text.slice(0, verboseAt).trim();
    const parsed = parseOwnershipMarker(text.slice(verboseAt));
    const after = parsed.rest.replace(/^[\s\n]+/, "");
    const combined = [before, after]
      .filter((part) => part.length > 0)
      .join(" ");
    return {
      labels: parsed.labels,
      text: combined.length > 0 ? combined : undefined,
    };
  }
  if (compactAt >= 0) {
    const before = text.slice(0, compactAt).trim();
    const parsed = parseCompactMarker(text.slice(compactAt));
    const after = parsed.rest.replace(/^[\s\n]+/, "");
    const combined = [before, after]
      .filter((part) => part.length > 0)
      .join(" ");
    return {
      labels: parsed.labels,
      text: combined.length > 0 ? combined : undefined,
    };
  }
  return { labels: {}, text };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const { labels } = parseOwnership(text);
    return yield* hasAlchemyLabels(id, labels);
  });

export const internalLabels = (id: string) => createInternalLabels(id);

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

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  fingerprint([...(left ?? [])].sort()) ===
  fingerprint([...(right ?? [])].sort());

export const parseJsonObject = (
  json: string | undefined,
): Record<string, unknown> | undefined => {
  if (json === undefined || json.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

export const injectJsonOwnership = (
  json: string | undefined,
  labels: Record<string, string>,
  title: string,
): string => {
  const obj = parseJsonObject(json) ?? {};
  const description =
    typeof obj.description === "string" ? obj.description : undefined;
  obj.description = encodeOwnership(labels, description);
  if (obj.title === undefined) obj.title = title;
  return JSON.stringify(obj);
};

export const jsonHasOwnership = (json: string | undefined): boolean => {
  const obj = parseJsonObject(json);
  return hasOwnershipMarker(
    typeof obj?.description === "string" ? obj.description : json,
  );
};

export const injectSchemaOwnership = (
  jsonSchema: string | undefined,
  labels: Record<string, string>,
): string => {
  const obj = parseJsonObject(jsonSchema) ?? {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
    },
  };
  if (obj.$schema === undefined) {
    obj.$schema = "https://json-schema.org/draft/2020-12/schema";
  }
  return JSON.stringify(obj);
};

export const schemaHasOwnership = (jsonSchema: string | undefined): boolean => {
  const obj = parseJsonObject(jsonSchema);
  return hasOwnershipMarker(
    typeof obj?.description === "string"
      ? obj.description
      : typeof obj?.$comment === "string"
        ? obj.$comment
        : jsonSchema,
  );
};

export const targetSiteUriOf = (
  labels: Record<string, string>,
  provided?: string,
): string => {
  if (provided !== undefined) return provided;
  return `www.example.com/alchemy/${labels[alchemyLabelKeys.stack]}/${labels[alchemyLabelKeys.stage]}/${labels[alchemyLabelKeys.id]}`;
};

export const targetSiteHasOwnership = (uri: string | undefined) =>
  (uri ?? "").includes("/alchemy/");

const alreadyExists = (error: discoveryengine.GoogleRpcStatus | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toUpperCase().includes("ALREADY_EXISTS");

const isNotFoundStatus = (error: discoveryengine.GoogleRpcStatus | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

export const resourceNameFromOperation = (
  operation: discoveryengine.GoogleLongrunningOperation,
): string | undefined => {
  const response = operation.response;
  const responseName = response?.name;
  if (typeof responseName === "string" && responseName.length > 0) {
    return responseName;
  }
  const metadata = operation.metadata;
  const target = metadata?.target;
  if (typeof target === "string" && target.length > 0) {
    return target;
  }
  return undefined;
};

export const waitForOperation = (
  operation: discoveryengine.GoogleLongrunningOperation,
  options?: { notFoundOk?: boolean },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error) {
        if (alreadyExists(operation.error)) return operation;
        if (options?.notFoundOk === true && isNotFoundStatus(operation.error)) {
          return operation;
        }
        return yield* new DiscoveryengineOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      if (options?.notFoundOk === true) return operation;
      return yield* new DiscoveryengineOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = discoveryengine.getProjectsLocationsOperations({
      name,
    });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<discoveryengine.GoogleLongrunningOperation>({
                name,
                done: true,
              }),
            ),
          )
        : getOperation.pipe(
            Effect.retry({
              while: (error) => error._tag === "NotFound",
              times: 5,
              schedule: Schedule.exponential("250 millis"),
            }),
          );

    return yield* resolved.pipe(
      Effect.filterOrFail(
        (current) => current.done === true,
        () => new DiscoveryengineOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const error = current.error;
        if (!error) return Effect.succeed(current);
        if (alreadyExists(error)) return Effect.succeed(current);
        if (options?.notFoundOk === true && isNotFoundStatus(error)) {
          return Effect.succeed(current);
        }
        return Effect.fail(
          new DiscoveryengineOperationFailed({
            operation: name,
            message: error.message ?? "operation failed",
          }),
        );
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.Discoveryengine.OperationPending",
        times: 10,
        schedule: Schedule.spaced("5 seconds"),
      }),
    );
  });

export const listDataStores = (project: string) =>
  Effect.forEach(
    LIST_LOCATIONS,
    (location) =>
      discoveryengine.listProjectsLocationsDataStores
        .pages({
          parent: locationParent(project, location),
          pageSize: 50,
        })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.dataStores ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => Effect.succeed([])),
          Effect.catchTag("Forbidden", () => Effect.succeed([])),
        ),
    { concurrency: 2 },
  ).pipe(Effect.map((groups) => groups.flat()));

export const normalizeCollection = (collection: string | undefined) =>
  lastSegment(collection ?? DEFAULT_COLLECTION);

export const collectionParent = (
  project: string,
  location: string,
  collectionId: string,
) => `${locationParent(project, location)}/collections/${collectionId}`;

export const dataStoreName = (
  project: string,
  location: string,
  collectionId: string,
  dataStoreId: string,
) =>
  `${collectionParent(project, location, collectionId)}/dataStores/${dataStoreId}`;

export const dataStoreIdOf = (value: string) => lastSegment(value);

export const servingConfigId = servingConfigIdOf;

export const toResourceId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return rfc1035(explicit);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_ID_LENGTH,
        lowercase: true,
      }),
    );
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const ownedBy = ownedByAlchemy;

export const sameJson = (left: unknown, right: unknown) =>
  fingerprint(left) === fingerprint(right);

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

export const labelsFromList = (labels: readonly string[] | undefined) => {
  for (const label of labels ?? []) {
    if (label.startsWith("[alchemy ")) {
      return parseOwnership(label).labels;
    }
  }
  return {} as Record<string, string>;
};

export const listFromLabels = (
  ownership: Record<string, string>,
  labels: readonly string[] | undefined,
) => [encodeOwnership(ownership, undefined), ...(labels ?? [])];

export const userLabelList = (labels: readonly string[] | undefined) =>
  (labels ?? []).filter((label) => !label.startsWith("[alchemy "));

const listAtParent = (parent: string) =>
  discoveryengine.listProjectsLocationsDataStores
    .pages({ parent, pageSize: 50 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.dataStores ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
      Effect.catchTag("Forbidden", () => Effect.succeed([])),
    );

export const listDataStoresAt = listAtParent;

export const listProjectDataStores = (project: string) =>
  Effect.gen(function* () {
    const seen = new Set<string>();
    const stores: discoveryengine.GoogleCloudDiscoveryengineV1DataStore[] = [];
    const locationStores = yield* listDataStores(project);
    const collectionStores = yield* listCollectionDataStores(project);
    for (const store of [...locationStores, ...collectionStores]) {
      const name = store.name ?? "";
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      stores.push(store);
    }
    return stores;
  });

export const listEngines = (project: string) =>
  Effect.gen(function* () {
    const seen = new Set<string>();
    const engines: discoveryengine.GoogleCloudDiscoveryengineV1Engine[] = [];
    for (const location of LIST_LOCATIONS) {
      const parent = collectionParent(project, location, DEFAULT_COLLECTION);
      const page =
        yield* discoveryengine.listProjectsLocationsCollectionsEngines
          .pages({ parent, pageSize: 50 })
          .pipe(
            Stream.flatMap((response) =>
              Stream.fromIterable(response.engines ?? []),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
            Effect.catchTag("Forbidden", () => Effect.succeed([])),
          );
      for (const engine of page) {
        const name = engine.name ?? "";
        if (name.length === 0 || seen.has(name)) continue;
        seen.add(name);
        engines.push(engine);
      }
    }
    return engines;
  });

export const branchParent = (dataStore: string, branchId = DEFAULT_BRANCH) =>
  `${dataStore}/branches/${branchId}`;

export const siteSearchEngineParent = (dataStore: string) =>
  `${dataStore}/siteSearchEngine`;

export const ownershipToken = (labels: Record<string, string>) =>
  `alc-${labels[alchemyLabelKeys.id] ?? "x"}`.slice(0, MAX_DISPLAY_NAME_LENGTH);

export const parseJsonOwnership = (json: string | undefined) => {
  const obj = parseJsonObject(json);
  const description =
    typeof obj?.description === "string" ? obj.description : undefined;
  const title = typeof obj?.title === "string" ? obj.title : undefined;
  const parsed = parseOwnership(description ?? title);
  return { labels: parsed.labels, json, title: parsed.text ?? title };
};

export const parseSchemaOwnership = (jsonSchema: string | undefined) => {
  const obj = parseJsonObject(jsonSchema);
  const comment =
    typeof obj?.$comment === "string"
      ? obj.$comment
      : typeof obj?.description === "string"
        ? obj.description
        : jsonSchema;
  return parseOwnership(comment);
};

export const listCollectionDataStores = (project: string) =>
  Effect.forEach(
    LIST_LOCATIONS,
    (location) =>
      discoveryengine.listProjectsLocationsCollectionsDataStores
        .pages({
          parent: collectionParent(project, location, DEFAULT_COLLECTION),
          pageSize: 50,
        })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.dataStores ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => Effect.succeed([])),
          Effect.catchTag("Forbidden", () => Effect.succeed([])),
        ),
    { concurrency: 2 },
  ).pipe(Effect.map((groups) => groups.flat()));
