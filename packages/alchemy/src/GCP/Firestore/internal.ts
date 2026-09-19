import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const DEFAULT_LOCATION = "us-central1";
export const MAX_ID_LENGTH = 63;
export const DATABASE_OWNERSHIP_DOCUMENT = "_alchemy/ownership";

export class OperationFailed extends Data.TaggedError(
  "GCP.Firestore.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class OperationPending extends Data.TaggedError(
  "GCP.Firestore.OperationPending",
)<{
  operation: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parseDatabaseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const after = (segment: string) => {
    const at = parts.lastIndexOf(segment);
    return at >= 0 && parts[at + 1] ? parts[at + 1]! : "";
  };
  const project = after("projects");
  const databaseId = after("databases");
  return {
    project,
    databaseId: databaseId || lastSegment(name),
    collectionGroup: after("collectionGroups"),
    indexId: after("indexes"),
    backupScheduleId: after("backupSchedules"),
    userCredsId: after("userCreds"),
  };
};

export const databaseIdOf = (value: string) =>
  value.includes("/databases/")
    ? parseDatabaseName(value).databaseId
    : lastSegment(value);

export const databaseResourceName = (project: string, databaseId: string) =>
  `projects/${project}/databases/${databaseId}`;

export const databaseNameOf = (project: string, database: string) => {
  if (database.includes("/databases/")) {
    const parsed = parseDatabaseName(database);
    return databaseResourceName(parsed.project || project, parsed.databaseId);
  }
  return databaseResourceName(project, lastSegment(database));
};

export const rfc1035 = (name: string, maxLength = MAX_ID_LENGTH): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `f${next}`;
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  if (next.length === 0) next = "firestore";
  if (next.length < 4) {
    next = `${next}xxxx`.slice(0, maxLength).replace(/-+$/g, "");
  }
  if (!/[a-z0-9]$/.test(next)) {
    next = `${next.slice(0, maxLength - 1)}0`;
  }
  return next.slice(0, maxLength);
};

export const toResourceId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength,
        lowercase: true,
      }),
      maxLength,
    );
  });

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const stringFromMap = (
  map: firestore.DocumentMap | undefined,
  key: string,
): string | undefined => {
  const value = map?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const labelsFromFields = (
  fields: firestore.ValueMap | undefined,
): Record<string, string> => {
  const labels: Record<string, string> = {};
  const stack = fields?.alchemy_stack?.stringValue;
  const stage = fields?.alchemy_stage?.stringValue;
  const id = fields?.alchemy_id?.stringValue;
  if (stack) labels[alchemyLabelKeys.stack] = stack;
  if (stage) labels[alchemyLabelKeys.stage] = stage;
  if (id) labels[alchemyLabelKeys.id] = id;
  return labels;
};

const fieldsFromLabels = (
  labels: Record<string, string>,
  extra?: firestore.ValueMap,
): firestore.ValueMap => ({
  alchemy_stack: { stringValue: labels[alchemyLabelKeys.stack] ?? "" },
  alchemy_stage: { stringValue: labels[alchemyLabelKeys.stage] ?? "" },
  alchemy_id: { stringValue: labels[alchemyLabelKeys.id] ?? "" },
  ...extra,
});

export const databaseOwnershipName = (databaseName: string) =>
  `${databaseName}/documents/${DATABASE_OWNERSHIP_DOCUMENT}`;

export const childOwnershipName = (
  databaseName: string,
  collection: string,
  documentId: string,
) => `${databaseName}/documents/${collection}/${documentId}`;

export const getDatabaseOwnershipLabels = (databaseName: string) =>
  firestore
    .getProjectsDatabasesDocuments({
      name: databaseOwnershipName(databaseName),
    })
    .pipe(
      Effect.map((document) => labelsFromFields(document.fields)),
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed<Record<string, string>>({}),
      ),
    );

export const parentOwned = (databaseName: string) =>
  getDatabaseOwnershipLabels(databaseName).pipe(
    Effect.map((labels) =>
      Object.keys(labels).some((key) => key.startsWith("alchemy-")),
    ),
  );

export const getDatabaseByName = (name: string) =>
  firestore.getProjectsDatabases({ name }).pipe(
    Effect.map((database) =>
      database.deleteTime !== undefined ? undefined : database,
    ),
    Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed(undefined)),
  );

export const listOwnedDatabaseNames = (project: string) =>
  Effect.gen(function* () {
    const page = yield* firestore.listProjectsDatabases({
      parent: `projects/${project}`,
    });
    const databases = (page.databases ?? []).filter(
      (
        database,
      ): database is firestore.GoogleFirestoreAdminV1Database & {
        name: string;
      } => database.deleteTime === undefined && database.name !== undefined,
    );
    const owned = yield* Effect.forEach(
      databases,
      (database) =>
        parentOwned(database.name).pipe(
          Effect.map((owned) => (owned ? database.name : undefined)),
        ),
      { concurrency: 8 },
    );
    return owned.filter((name): name is string => name !== undefined);
  });

export const stampChildOwnership = (
  databaseName: string,
  collection: string,
  labels: Record<string, string>,
  resourceName: string,
) => {
  const documentId = labels[alchemyLabelKeys.id] ?? "resource";
  return firestore
    .patchProjectsDatabasesDocuments({
      name: childOwnershipName(databaseName, collection, documentId),
      body: {
        fields: fieldsFromLabels(labels, {
          name: { stringValue: resourceName },
        }),
      },
    })
    .pipe(
      Effect.retry({
        while: (error) =>
          error._tag === "NotFound" ||
          error._tag === "Conflict" ||
          error._tag === "BadRequest",
        times: 8,
        schedule: Schedule.spaced("2 seconds"),
      }),
      Effect.catchTag(
        ["NotFound", "Forbidden", "BadRequest"],
        () => Effect.void,
      ),
    );
};

export const getChildOwnershipName = (
  databaseName: string,
  collection: string,
  labels: Record<string, string>,
) => {
  const documentId = labels[alchemyLabelKeys.id] ?? "resource";
  return firestore
    .getProjectsDatabasesDocuments({
      name: childOwnershipName(databaseName, collection, documentId),
    })
    .pipe(
      Effect.map((document) => document.fields?.name?.stringValue),
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed(undefined),
      ),
    );
};

export const listChildOwnershipNames = (
  databaseName: string,
  collection: string,
) =>
  firestore
    .listProjectsDatabasesDocuments({
      parent: `${databaseName}/documents`,
      collectionId: collection,
      pageSize: 1000,
    })
    .pipe(
      Effect.map((page) =>
        (page.documents ?? [])
          .map((document) => document.fields?.name?.stringValue)
          .filter((name): name is string => typeof name === "string"),
      ),
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed([] as string[]),
      ),
    );

export const deleteChildOwnership = (
  databaseName: string,
  collection: string,
  labels: Record<string, string>,
) => {
  const documentId = labels[alchemyLabelKeys.id] ?? "resource";
  return firestore
    .deleteProjectsDatabasesDocuments({
      name: childOwnershipName(databaseName, collection, documentId),
    })
    .pipe(Effect.catchTag(["NotFound", "Forbidden"], () => Effect.void));
};

export const ownedById = (id: string, labels: Record<string, string>) =>
  hasAlchemyLabels(id, labels);

const isAlreadyExists = (error: firestore.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").includes("ALREADY_EXISTS") ||
  (error?.message ?? "").toLowerCase().includes("already exists");

const isNotFoundStatus = (error: firestore.Status | undefined) => {
  if (error === undefined) return false;
  if (error.code === 5) return true;
  return (error?.message ?? "").toLowerCase().includes("not found");
};

export const waitForOperation = (
  operation: firestore.GoogleLongrunningOperation,
  options?: { notFoundOk?: boolean; alreadyExistsOk?: boolean },
): Effect.Effect<
  firestore.GoogleLongrunningOperation,
  | OperationFailed
  | OperationPending
  | firestore.GetProjectsDatabasesOperationsError,
  firestore.GcpOpContext
> =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error) {
        if (
          options?.alreadyExistsOk === true &&
          isAlreadyExists(operation.error)
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
      return yield* new OperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = firestore.getProjectsDatabasesOperations({ name });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed({
                name,
                done: true,
              } satisfies firestore.GoogleLongrunningOperation),
            ),
          )
        : getOperation.pipe(
            Effect.retry({
              while: (error) => error._tag === "NotFound",
              times: 5,
              schedule: Schedule.exponential("250 millis"),
            }),
          );

    const poll: Effect.Effect<
      firestore.GoogleLongrunningOperation,
      | OperationFailed
      | OperationPending
      | firestore.GetProjectsDatabasesOperationsError,
      firestore.GcpOpContext
    > = resolved.pipe(
      Effect.filterOrFail(
        (current) => current.done === true,
        () => new OperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const status = current.error;
        if (!status) {
          return Effect.succeed(current);
        }
        if (options?.alreadyExistsOk === true && isAlreadyExists(status)) {
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
    );

    return yield* poll.pipe(
      Effect.retry({
        while: (error) => error._tag === "GCP.Firestore.OperationPending",
        times: 10,
        schedule: Schedule.spaced("5 seconds"),
      }),
    );
  });

export const retryConcurrentChanges = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export { alchemyLabelKeys, createInternalLabels };
