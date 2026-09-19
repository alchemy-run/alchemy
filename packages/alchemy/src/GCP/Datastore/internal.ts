import * as datastore from "@distilled.cloud/gcp/datastore_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { alchemyLabelKeys, createInternalLabels } from "../Labels.ts";

export const DEFAULT_ANCESTOR = "NONE";
export const DEFAULT_DIRECTION = "ASCENDING";
export const OWNERSHIP_KIND = "AlchemyIndexOwnership";
export const MAX_KIND_LENGTH = 63;

export class OperationFailed extends Data.TaggedError(
  "GCP.Datastore.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class OperationPending extends Data.TaggedError(
  "GCP.Datastore.OperationPending",
)<{
  operation: string;
}> {}

export class IndexNotResolved extends Data.TaggedError(
  "GCP.Datastore.IndexNotResolved",
)<{
  indexId: string;
}> {}

export class IndexStillExists extends Data.TaggedError(
  "GCP.Datastore.IndexStillExists",
)<{
  indexId: string;
}> {}

export const stringFromMap = (
  map: datastore.DocumentMap | undefined,
  key: string,
): string | undefined => {
  const value = map?.[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (value !== null && typeof value === "object") {
    const record = value as { stringValue?: unknown };
    if (
      typeof record.stringValue === "string" &&
      record.stringValue.length > 0
    ) {
      return record.stringValue;
    }
  }
  return undefined;
};

export const normalizeEnum = (value: string | undefined, fallback: string) => {
  const next = (value ?? fallback).toUpperCase();
  return next.endsWith("_UNSPECIFIED") ? fallback : next;
};

export const rfc1035Kind = (name: string, maxLength = MAX_KIND_LENGTH) => {
  let next = name
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[A-Za-z]/.test(next)) next = `K${next}`;
  next = next.slice(0, maxLength).replace(/_+$/g, "");
  if (next.length === 0) next = "Kind";
  return next.slice(0, maxLength);
};

export const toKind = (
  id: string,
  kind: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (kind !== undefined && kind.length > 0) return kind;
    if (existing !== undefined && existing.length > 0) return existing;
    return rfc1035Kind(
      yield* createPhysicalName({
        id,
        maxLength: MAX_KIND_LENGTH,
        lowercase: false,
      }),
    );
  });

export type IndexedProperty = {
  /** Property name to index. */
  name: string;
  /**
   * Sort direction.
   * @default "ASCENDING"
   */
  direction?:
    | datastore.GoogleDatastoreAdminV1IndexedPropertyDirectionEnum
    | (string & {});
};

export const propertyOf = (
  property: IndexedProperty | datastore.GoogleDatastoreAdminV1IndexedProperty,
): IndexedProperty => ({
  name: property.name ?? "",
  direction: normalizeEnum(property.direction, DEFAULT_DIRECTION),
});

export const propertiesKey = (
  properties:
    | readonly IndexedProperty[]
    | readonly datastore.GoogleDatastoreAdminV1IndexedProperty[]
    | undefined,
) => JSON.stringify((properties ?? []).map(propertyOf));

export const desiredBody = (input: {
  kind: string;
  ancestor?: string;
  properties: IndexedProperty[];
}): datastore.GoogleDatastoreAdminV1Index => ({
  kind: input.kind,
  ancestor: normalizeEnum(input.ancestor, DEFAULT_ANCESTOR),
  properties: input.properties.map(propertyOf),
});

export const matchesDesired = (
  index: datastore.GoogleDatastoreAdminV1Index,
  input: {
    kind: string;
    ancestor?: string;
    properties: IndexedProperty[];
  },
) => {
  const desired = desiredBody(input);
  return (
    (index.kind ?? "") === desired.kind &&
    normalizeEnum(index.ancestor, DEFAULT_ANCESTOR) ===
      normalizeEnum(desired.ancestor, DEFAULT_ANCESTOR) &&
    propertiesKey(index.properties ?? []) ===
      propertiesKey(desired.properties ?? [])
  );
};

export const toAttrs = (
  index: datastore.GoogleDatastoreAdminV1Index,
  project: string,
) => {
  const indexId = index.indexId ?? "";
  return {
    name:
      indexId.length > 0
        ? `projects/${index.projectId ?? project}/indexes/${indexId}`
        : `projects/${index.projectId ?? project}/indexes`,
    indexId,
    project: index.projectId ?? project,
    kind: index.kind ?? "",
    ancestor: index.ancestor,
    state: index.state,
    properties: (index.properties ?? []).map(propertyOf),
  };
};

export const getById = (projectId: string, indexId: string) =>
  datastore
    .getProjectsIndexes({ projectId, indexId })
    .pipe(
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed(undefined),
      ),
    );

export const listIndexes = (projectId: string) =>
  datastore.listProjectsIndexes
    .pages({
      projectId,
    })
    .pipe(
      Stream.runCollect,
      Effect.map((pages) =>
        Array.from(pages).flatMap((page) => page.indexes ?? []),
      ),
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed([] as datastore.GoogleDatastoreAdminV1Index[]),
      ),
    );

const alreadyExists = (error: datastore.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").includes("ALREADY_EXISTS") ||
  (error?.message ?? "").toLowerCase().includes("already exists");

const isNotFoundStatus = (error: datastore.Status | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

export const waitForOperation = (
  operation: datastore.GoogleLongrunningOperation,
  options?: { notFoundOk?: boolean; alreadyExistsOk?: boolean },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error) {
        if (
          options?.alreadyExistsOk === true &&
          alreadyExists(operation.error)
        ) {
          return operation;
        }
        if (options?.notFoundOk === true && isNotFoundStatus(operation.error)) {
          return operation;
        }
        return yield* new OperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      if (options?.notFoundOk === true) {
        return operation;
      }
      return yield* new OperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = datastore.getProjectsOperations({ name });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed({
                name,
                done: true,
              } satisfies datastore.GoogleLongrunningOperation),
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
        () => new OperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const status = current.error;
        if (!status) {
          return Effect.succeed(current);
        }
        if (options?.alreadyExistsOk === true && alreadyExists(status)) {
          return Effect.succeed(current);
        }
        if (options?.notFoundOk === true && isNotFoundStatus(status)) {
          return Effect.succeed(current);
        }
        return Effect.fail(
          new OperationFailed({
            operation: name,
            message: status.message ?? "operation failed",
          }),
        );
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.Datastore.OperationPending",
        times: 10,
        schedule: Schedule.spaced("5 seconds"),
      }),
    );
  });

export const indexIdFromOperation = (
  operation: datastore.GoogleLongrunningOperation | undefined,
): string | undefined => {
  if (operation === undefined) return undefined;
  return (
    stringFromMap(operation.response, "indexId") ??
    stringFromMap(operation.metadata, "indexId") ??
    stringFromMap(operation.metadata, "index")
  );
};

export const waitUntilExists = (projectId: string, indexId: string) =>
  getById(projectId, indexId).pipe(
    Effect.flatMap((index) =>
      index
        ? Effect.succeed(index)
        : Effect.fail(new IndexNotResolved({ indexId })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Datastore.IndexNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const waitUntilGone = (projectId: string, indexId: string) =>
  getById(projectId, indexId).pipe(
    Effect.filterOrFail(
      (index) => index === undefined,
      () => new IndexStillExists({ indexId }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Datastore.IndexStillExists",
      times: 24,
      schedule: Schedule.spaced("5 seconds"),
    }),
    Effect.asVoid,
  );

export const waitUntilDeletable = (projectId: string, indexId: string) =>
  getById(projectId, indexId).pipe(
    Effect.filterOrFail(
      (index) => index === undefined || index.state !== "DELETING",
      () => new IndexNotResolved({ indexId }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Datastore.IndexNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const ownershipKey = (
  projectId: string,
  documentId: string,
): datastore.Key => ({
  partitionId: { projectId },
  path: [{ kind: OWNERSHIP_KIND, name: documentId }],
});

const stringProp = (value: string): datastore.Value => ({
  stringValue: value,
  excludeFromIndexes: true,
});

export const stampOwnership = (
  projectId: string,
  labels: Record<string, string>,
  indexId: string,
) => {
  const documentId = labels[alchemyLabelKeys.id] ?? "resource";
  return datastore
    .commitProjects({
      projectId,
      body: {
        mode: "NON_TRANSACTIONAL",
        mutations: [
          {
            upsert: {
              key: ownershipKey(projectId, documentId),
              properties: {
                indexId: stringProp(indexId),
                alchemy_stack: stringProp(labels[alchemyLabelKeys.stack] ?? ""),
                alchemy_stage: stringProp(labels[alchemyLabelKeys.stage] ?? ""),
                alchemy_id: stringProp(labels[alchemyLabelKeys.id] ?? ""),
              },
            },
          },
        ],
      },
    })
    .pipe(
      Effect.retry({
        while: (error) =>
          error._tag === "Conflict" || error._tag === "BadRequest",
        times: 4,
        schedule: Schedule.spaced("1 second"),
      }),
      Effect.catchTag(
        ["NotFound", "Forbidden", "BadRequest", "Conflict"],
        () => Effect.void,
      ),
      Effect.asVoid,
    );
};

export const getOwnedIndexId = (
  projectId: string,
  labels: Record<string, string>,
) => {
  const documentId = labels[alchemyLabelKeys.id] ?? "resource";
  return datastore
    .lookupProjects({
      projectId,
      body: {
        keys: [ownershipKey(projectId, documentId)],
      },
    })
    .pipe(
      Effect.map(
        (response) =>
          response.found?.[0]?.entity?.properties?.indexId?.stringValue,
      ),
      Effect.catchTag(["NotFound", "Forbidden", "BadRequest"], () =>
        Effect.succeed(undefined),
      ),
    );
};

export const listOwnedIndexIds = (projectId: string) =>
  datastore
    .runQueryProjects({
      projectId,
      body: {
        query: {
          kind: [{ name: OWNERSHIP_KIND }],
        },
      },
    })
    .pipe(
      Effect.map((response) =>
        (response.batch?.entityResults ?? [])
          .map((row) => row.entity?.properties?.indexId?.stringValue)
          .filter((indexId): indexId is string => typeof indexId === "string"),
      ),
      Effect.catchTag(["NotFound", "Forbidden", "BadRequest"], () =>
        Effect.succeed([] as string[]),
      ),
    );

export const deleteOwnership = (
  projectId: string,
  labels: Record<string, string>,
) => {
  const documentId = labels[alchemyLabelKeys.id] ?? "resource";
  return datastore
    .commitProjects({
      projectId,
      body: {
        mode: "NON_TRANSACTIONAL",
        mutations: [
          {
            delete: ownershipKey(projectId, documentId),
          },
        ],
      },
    })
    .pipe(
      Effect.catchTag(
        ["NotFound", "Forbidden", "BadRequest", "Conflict"],
        () => Effect.void,
      ),
      Effect.asVoid,
    );
};

export { alchemyLabelKeys, createInternalLabels };
