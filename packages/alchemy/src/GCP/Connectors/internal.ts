import * as connectorsv1 from "@distilled.cloud/gcp/unstable/connectors_v1";
import * as connectors from "@distilled.cloud/gcp/connectors_v2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const DEFAULT_LOCATION = "us-central1";
export const ALCHEMY_FIELD_MARKER = "alchemy";

export type EntityFields = Record<string, unknown>;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

const segmentAfter = (parts: readonly string[], key: string) => {
  const index = parts.lastIndexOf(key);
  return index >= 0 && parts[index + 1] ? parts[index + 1]! : "";
};

export const parseEntityName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return {
    project: segmentAfter(parts, "projects"),
    location: segmentAfter(parts, "locations") || DEFAULT_LOCATION,
    connection: segmentAfter(parts, "connections"),
    entityType: segmentAfter(parts, "entityTypes"),
    entityId: segmentAfter(parts, "entities") || lastSegment(name),
    parent: parentOf(name),
  };
};

export const entityTypeNameOf = (
  project: string,
  location: string,
  connection: string,
  entityType: string,
) => {
  if (entityType.includes("/")) return entityType.replace(/\/+$/, "");
  const connectionName = connection.includes("/")
    ? connection.replace(/\/+$/, "")
    : `projects/${project}/locations/${location}/connections/${connection}`;
  return `${connectionName}/entityTypes/${entityType}`;
};

export const entityNameOf = (parent: string, entityId: string) =>
  `${parent.replace(/\/+$/, "")}/entities/${entityId}`;

const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
};

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

export const isAlchemyFieldKey = (key: string) =>
  key === ALCHEMY_FIELD_MARKER || key.startsWith("alchemy-");

export const userFields = (
  fields: EntityFields | null | undefined,
): EntityFields =>
  Object.fromEntries(
    Object.entries(fields ?? {}).filter(([key]) => !isAlchemyFieldKey(key)),
  );

export const ownershipFromFields = (
  fields: EntityFields | null | undefined,
): Record<string, string> => {
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (
      key.startsWith("alchemy-") &&
      typeof value === "string" &&
      value.length > 0
    ) {
      labels[key] = value;
    }
  }
  return labels;
};

export const stampFields = (
  ownership: Record<string, string>,
  fields: EntityFields | undefined,
): EntityFields => ({
  ...userFields(fields),
  [alchemyLabelKeys.stack]: ownership[alchemyLabelKeys.stack],
  [alchemyLabelKeys.stage]: ownership[alchemyLabelKeys.stage],
  [alchemyLabelKeys.id]: ownership[alchemyLabelKeys.id],
  [ALCHEMY_FIELD_MARKER]: "true",
});

export const hasAlchemyEntityFields = (
  fields: EntityFields | null | undefined,
) => {
  const entries = fields ?? {};
  return (
    entries[ALCHEMY_FIELD_MARKER] === "true" ||
    Object.keys(entries).some((key) => key.startsWith("alchemy-"))
  );
};

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (
  id: string,
  fields: EntityFields | null | undefined,
) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const observed = ownershipFromFields(fields);
    if (Object.keys(observed).length === 0) return false;
    if (yield* hasAlchemyLabels(id, observed)) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        observed[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        observed[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        observed[alchemyLabelKeys.id] ?? "",
      )
    );
  });

const emptyList = <A>() => Effect.succeed([] as A[]);

export const retryTransient = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "TooManyRequests" ||
        error._tag === "InternalServerError" ||
        error._tag === "BadGateway" ||
        error._tag === "ServiceUnavailable" ||
        error._tag === "GatewayTimeout",
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
  );

export const getEntity = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : connectors
        .getProjectsLocationsConnectionsEntityTypesEntities({ name })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed(undefined),
          ),
        );

export const listEntityTypes = (parent: string) =>
  parent.length === 0
    ? emptyList<connectors.EntityType>()
    : connectors.listProjectsLocationsConnectionsEntityTypes
        .pages({ parent, pageSize: 100 })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.types ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag(["NotFound", "Forbidden", "Unauthorized"], () =>
            emptyList<connectors.EntityType>(),
          ),
        );

export const listEntities = (parent: string) =>
  parent.length === 0
    ? emptyList<connectors.Entity>()
    : connectors.listProjectsLocationsConnectionsEntityTypesEntities
        .pages({ parent, pageSize: 200 })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.entities ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag(["NotFound", "Forbidden", "Unauthorized"], () =>
            emptyList<connectors.Entity>(),
          ),
        );

const listConnectionsAt = (parent: string) =>
  connectorsv1.listProjectsLocationsConnections
    .pages({ parent, pageSize: 100, view: "BASIC" })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.connections ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag(["NotFound", "Forbidden", "Unauthorized"], () =>
        emptyList<connectorsv1.Connection>(),
      ),
    );

export const listConnections = (project: string) =>
  Effect.gen(function* () {
    const wildcard = yield* listConnectionsAt(
      `projects/${project}/locations/-`,
    );
    if (wildcard.length > 0) return wildcard;
    return yield* listConnectionsAt(
      `projects/${project}/locations/${DEFAULT_LOCATION}`,
    );
  });

const entityTypeParent = (
  connectionName: string,
  type: connectors.EntityType,
) => {
  const name = type.name ?? "";
  if (name.includes("/entityTypes/")) return name;
  if (name.length === 0) return "";
  return `${connectionName}/entityTypes/${lastSegment(name)}`;
};

export const listOwnedEntities = (project: string) =>
  Effect.gen(function* () {
    const connections = yield* listConnections(project);
    const connectionNames = connections
      .map((connection) => connection.name)
      .filter((name): name is string => (name ?? "").length > 0);
    const typePages = yield* Effect.forEach(
      connectionNames,
      (connectionName) =>
        listEntityTypes(connectionName).pipe(
          Effect.map((types) =>
            types
              .map((type) => entityTypeParent(connectionName, type))
              .filter((parent) => parent.length > 0),
          ),
        ),
      { concurrency: 4 },
    );
    const parents = typePages.flat();
    const entityPages = yield* Effect.forEach(parents, listEntities, {
      concurrency: 4,
    });
    return entityPages
      .flat()
      .filter((entity) => hasAlchemyEntityFields(entity.fields));
  });

export const findOwnedEntity = (parent: string, id: string) =>
  Effect.gen(function* () {
    const entities = yield* listEntities(parent);
    for (const entity of entities) {
      if (yield* ownedByAlchemy(id, entity.fields)) {
        return entity;
      }
    }
    return undefined;
  });
