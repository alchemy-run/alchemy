import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_LOCATION = "us-central1";
const DEFAULT_TYPE = "FIRESTORE_NATIVE";
const DEFAULT_EDITION = "STANDARD";
const DEFAULT_DELETE_PROTECTION = "DELETE_PROTECTION_DISABLED";
const DEFAULT_APP_ENGINE = "DISABLED";
const MAX_DATABASE_ID_LENGTH = 63;
const OWNERSHIP_DOCUMENT = "_alchemy/ownership";

export type DatabaseType =
  | firestore.GoogleFirestoreAdminV1DatabaseTypeEnum
  | (string & {});
export type DatabaseEdition =
  | firestore.GoogleFirestoreAdminV1DatabaseDatabaseEditionEnum
  | (string & {});
export type DatabaseConcurrencyMode =
  | firestore.GoogleFirestoreAdminV1DatabaseConcurrencyModeEnum
  | (string & {});
export type DatabasePointInTimeRecoveryEnablement =
  | firestore.GoogleFirestoreAdminV1DatabasePointInTimeRecoveryEnablementEnum
  | (string & {});
export type DatabaseAppEngineIntegrationMode =
  | firestore.GoogleFirestoreAdminV1DatabaseAppEngineIntegrationModeEnum
  | (string & {});
export type DatabaseDeleteProtectionState =
  | firestore.GoogleFirestoreAdminV1DatabaseDeleteProtectionStateEnum
  | (string & {});
export type DatabaseRealtimeUpdatesMode =
  | firestore.GoogleFirestoreAdminV1DatabaseRealtimeUpdatesModeEnum
  | (string & {});
export type DatabaseDataAccessMode =
  | firestore.GoogleFirestoreAdminV1DatabaseFirestoreDataAccessModeEnum
  | (string & {});

export type DatabaseCmekConfig = {
  /**
   * Cloud KMS CryptoKey used to encrypt the database
   * (`projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`).
   * Must be in the same location as the database. Immutable — changing
   * it replaces the database.
   */
  kmsKeyName?: string;
};

export type DatabaseProps = {
  /**
   * Database id (the `{database}` segment of
   * `projects/{project}/databases/{database}`). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Must be 4-63
   * characters, match `[a-z][a-z0-9-]*[a-z0-9]`, and must not look like a
   * UUID. `"(default)"` is valid for the Standard edition default
   * database. Immutable — changing it replaces the database.
   */
  databaseId?: string;
  /**
   * Location of the database (`us-central1`, `nam5`, `eur3`, …).
   * Immutable — changing it replaces the database. `US-CENTRAL1` is
   * accepted and normalized to `us-central1`.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Database type. Mode changes are only allowed when the database is
   * empty.
   * @default "FIRESTORE_NATIVE"
   */
  type?: DatabaseType;
  /**
   * Database edition. Immutable — changing it replaces the database.
   * @default "STANDARD"
   */
  databaseEdition?: DatabaseEdition;
  /**
   * Default transaction concurrency mode. Defaults to `PESSIMISTIC` for
   * Standard edition and `OPTIMISTIC` for Enterprise.
   */
  concurrencyMode?: DatabaseConcurrencyMode;
  /**
   * Point-in-time recovery. When enabled, version retention is 7 days
   * instead of 1 hour.
   * @default "POINT_IN_TIME_RECOVERY_DISABLED"
   */
  pointInTimeRecoveryEnablement?: DatabasePointInTimeRecoveryEnablement;
  /**
   * App Engine integration mode. `DISABLED` is the API default for
   * databases created with the Firestore API.
   * @default "DISABLED"
   */
  appEngineIntegrationMode?: DatabaseAppEngineIntegrationMode;
  /**
   * Delete protection. Alchemy defaults to disabled so `destroy` can
   * delete the database.
   * @default "DELETE_PROTECTION_DISABLED"
   */
  deleteProtectionState?: DatabaseDeleteProtectionState;
  /**
   * Default Realtime Updates mode. Immutable — changing it replaces the
   * database.
   */
  realtimeUpdatesMode?: DatabaseRealtimeUpdatesMode;
  /**
   * Firestore API data access mode. Defaults to enabled on Standard
   * edition and disabled on Enterprise.
   */
  firestoreDataAccessMode?: DatabaseDataAccessMode;
  /**
   * MongoDB-compatible API data access mode. Always disabled on Standard
   * edition.
   */
  mongodbCompatibleDataAccessMode?: DatabaseDataAccessMode;
  /**
   * Customer-managed encryption. Immutable — changing it replaces the
   * database.
   */
  cmekConfig?: DatabaseCmekConfig;
};

export type Database = Resource<
  "GCP.Firestore.Database",
  DatabaseProps,
  {
    /** Full resource name `projects/{project}/databases/{database}`. */
    name: string;
    /** Database id (last path segment). */
    databaseId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, `nam5`, …). */
    location: string;
    /** Database type (`FIRESTORE_NATIVE`, `DATASTORE_MODE`). */
    type: string;
    /** Database edition (`STANDARD`, `ENTERPRISE`). */
    databaseEdition: string | undefined;
    /** Default concurrency mode. */
    concurrencyMode: string | undefined;
    /** Point-in-time recovery enablement. */
    pointInTimeRecoveryEnablement: string | undefined;
    /** App Engine integration mode. */
    appEngineIntegrationMode: string | undefined;
    /** Delete protection state. */
    deleteProtectionState: string | undefined;
    /** Realtime Updates mode. */
    realtimeUpdatesMode: string | undefined;
    /** Firestore API data access mode. */
    firestoreDataAccessMode: string | undefined;
    /** MongoDB-compatible API data access mode. */
    mongodbCompatibleDataAccessMode: string | undefined;
    /** CMEK key, if any. */
    kmsKeyName: string | undefined;
    /** System-generated UUID4. */
    uid: string | undefined;
    /** Datastore key prefix, if any. */
    keyPrefix: string | undefined;
    /** Whether this database is eligible for the free tier. */
    freeTier: boolean | undefined;
    /** Version retention period (e.g. `"3600s"`). */
    versionRetentionPeriod: string | undefined;
    /** Earliest PITR timestamp, if available. */
    earliestVersionTime: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Server etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Firestore database.
 *
 * Firestore databases have no labels field, so Alchemy stamps ownership
 * into a `_alchemy/ownership` document for `list` / `pnpm nuke:gcp`.
 * Changing `databaseId`, `location`, `databaseEdition`, CMEK, or
 * Realtime Updates mode replaces the database.
 *
 * Create, update, and delete are long-running operations — provisioning
 * a named database typically takes tens of seconds.
 *
 * ### Creating a Database
 * **Example:** Generated name
 * ```typescript
 * const database = yield* GCP.Firestore.Database("App", {});
 * ```
 *
 * **Example:** Explicit id, location, and concurrency
 * ```typescript
 * const database = yield* GCP.Firestore.Database("App", {
 *   databaseId: "app-data",
 *   location: "us-central1",
 *   type: "FIRESTORE_NATIVE",
 *   concurrencyMode: "OPTIMISTIC",
 * });
 * ```
 *
 * ### Reading and Writing Documents
 * **Example:** Upsert and read a document
 * ```typescript
 * const patchDocument = yield* GCP.Firestore.PatchDocument(database);
 * yield* patchDocument({
 *   documentPath: "users/alice",
 *   body: { fields: { name: { stringValue: "Alice" } } },
 * });
 * const getDocument = yield* GCP.Firestore.GetDocument(database);
 * const doc = yield* getDocument({ documentPath: "users/alice" });
 * ```
 *
 * @resource
 * @product GCP
 * @category Firestore
 */
export const Database = Resource<Database>("GCP.Firestore.Database");

export class DatabaseNotResolved extends Data.TaggedError(
  "GCP.Firestore.DatabaseNotResolved",
)<{
  name: string;
}> {}

export class DatabaseOperationFailed extends Data.TaggedError(
  "GCP.Firestore.DatabaseOperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class DatabaseOperationPending extends Data.TaggedError(
  "GCP.Firestore.DatabaseOperationPending",
)<{
  operation: string;
}> {}

export class DatabaseStillExists extends Data.TaggedError(
  "GCP.Firestore.DatabaseStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

const normalizeEnum = (value: string | undefined, fallback: string) => {
  const next = (value ?? fallback).toUpperCase();
  return next.endsWith("_UNSPECIFIED") ? fallback : next;
};

const normalizeType = (value: string | undefined) =>
  normalizeEnum(value, DEFAULT_TYPE);

const normalizeEdition = (value: string | undefined) =>
  normalizeEnum(value, DEFAULT_EDITION);

const resourceName = (project: string, databaseId: string) =>
  `projects/${project}/databases/${databaseId}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const databasesAt = parts.lastIndexOf("databases");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    databaseId:
      databasesAt >= 0 && parts[databasesAt + 1]
        ? parts[databasesAt + 1]!
        : lastSegment(name),
  };
};

const ownershipName = (databaseName: string) =>
  `${databaseName}/documents/${OWNERSHIP_DOCUMENT}`;

const toDatabaseId = (
  id: string,
  databaseId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (databaseId !== undefined) return databaseId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_DATABASE_ID_LENGTH,
      lowercase: true,
    });
    let named = /^[a-z]/.test(generated) ? generated : `f${generated}`;
    named = named.replace(/-+$/g, "").slice(0, MAX_DATABASE_ID_LENGTH);
    named = named.replace(/-+$/g, "");
    if (named.length < 4) {
      named = `${named}dbxx`.slice(0, MAX_DATABASE_ID_LENGTH);
    }
    return named;
  });

const toAttrs = (
  database: firestore.GoogleFirestoreAdminV1Database,
  project: string,
): Database["Attributes"] => {
  const name = database.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    databaseId: parsed.databaseId,
    project: parsed.project || project,
    location: normalizeLocation(database.locationId),
    type: normalizeType(database.type),
    databaseEdition: database.databaseEdition,
    concurrencyMode: database.concurrencyMode,
    pointInTimeRecoveryEnablement: database.pointInTimeRecoveryEnablement,
    appEngineIntegrationMode: database.appEngineIntegrationMode,
    deleteProtectionState: database.deleteProtectionState,
    realtimeUpdatesMode: database.realtimeUpdatesMode,
    firestoreDataAccessMode: database.firestoreDataAccessMode,
    mongodbCompatibleDataAccessMode: database.mongodbCompatibleDataAccessMode,
    kmsKeyName: database.cmekConfig?.kmsKeyName,
    uid: database.uid,
    keyPrefix: database.keyPrefix,
    freeTier: database.freeTier,
    versionRetentionPeriod: database.versionRetentionPeriod,
    earliestVersionTime: database.earliestVersionTime,
    createTime: database.createTime,
    updateTime: database.updateTime,
    etag: database.etag,
  };
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
): firestore.ValueMap => ({
  alchemy_stack: { stringValue: labels[alchemyLabelKeys.stack] ?? "" },
  alchemy_stage: { stringValue: labels[alchemyLabelKeys.stage] ?? "" },
  alchemy_id: { stringValue: labels[alchemyLabelKeys.id] ?? "" },
});

const getOwnershipLabels = (databaseName: string) =>
  firestore
    .getProjectsDatabasesDocuments({
      name: ownershipName(databaseName),
    })
    .pipe(
      Effect.map((document) => labelsFromFields(document.fields)),
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed({} as Record<string, string>),
      ),
    );

const sameOwnership = (
  left: Record<string, string>,
  right: Record<string, string>,
) =>
  left[alchemyLabelKeys.stack] === right[alchemyLabelKeys.stack] &&
  left[alchemyLabelKeys.stage] === right[alchemyLabelKeys.stage] &&
  left[alchemyLabelKeys.id] === right[alchemyLabelKeys.id];

const stampOwnership = (databaseName: string, labels: Record<string, string>) =>
  firestore
    .patchProjectsDatabasesDocuments({
      name: ownershipName(databaseName),
      body: { fields: fieldsFromLabels(labels) },
    })
    .pipe(
      Effect.retry({
        while: (error) =>
          error._tag === "NotFound" ||
          error._tag === "Conflict" ||
          error._tag === "BadRequest",
        times: 8,
        schedule: Schedule.spaced("3 seconds"),
      }),
    );

const getByName = (name: string) =>
  firestore.getProjectsDatabases({ name }).pipe(
    Effect.map((database) =>
      database.deleteTime !== undefined ? undefined : database,
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const isAlreadyExists = (error: firestore.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").includes("ALREADY_EXISTS") ||
  (error?.message ?? "").toLowerCase().includes("already exists");

const isNotFoundStatus = (error: firestore.Status | undefined) => {
  if (error === undefined) return false;
  if (error.code === 5) return true;
  return (error.message ?? "").toLowerCase().includes("not found");
};

const waitForOperation = (
  operation: firestore.GoogleLongrunningOperation,
  options?: { notFoundOk?: boolean; alreadyExistsOk?: boolean },
) =>
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
        return yield* new DatabaseOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      return yield* new DatabaseOperationFailed({
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

    return yield* resolved.pipe(
      Effect.filterOrFail(
        (current) => current.done === true,
        () => new DatabaseOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const status = current.error;
        if (status) {
          if (options?.alreadyExistsOk === true && isAlreadyExists(status)) {
            return Effect.succeed(current);
          }
          if (options?.notFoundOk === true && isNotFoundStatus(status)) {
            return Effect.succeed(current);
          }
          return Effect.fail(
            new DatabaseOperationFailed({
              operation: name,
              message: status.message ?? "operation failed",
            }),
          );
        }
        return Effect.succeed(current);
      }),
      Effect.retry({
        while: (error) =>
          error._tag === "GCP.Firestore.DatabaseOperationPending",
        times: 10,
        schedule: Schedule.spaced("8 seconds"),
      }),
    );
  });

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((database) =>
      database
        ? Effect.succeed(database)
        : Effect.fail(new DatabaseNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Firestore.DatabaseNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((database) =>
      database === undefined
        ? Effect.void
        : Effect.fail(new DatabaseStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Firestore.DatabaseStillExists",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

const retryConcurrentChanges = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 8,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const enumChanged = (
  desired: string | undefined,
  observed: string | undefined,
) => {
  if (desired === undefined) return false;
  return normalizeEnum(observed, desired) !== normalizeEnum(desired, desired);
};

export const DatabaseProvider = () =>
  Provider.succeed(Database, {
    stables: [
      "name",
      "databaseId",
      "project",
      "location",
      "uid",
      "createTime",
      "keyPrefix",
      "databaseEdition",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousId = olds?.databaseId ?? output?.databaseId;
      const nextId = news.databaseId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(news.location ?? output?.location);
      const previousEdition = normalizeEdition(
        olds?.databaseEdition ?? output?.databaseEdition,
      );
      const nextEdition = normalizeEdition(
        news.databaseEdition ?? output?.databaseEdition,
      );
      const previousKms =
        olds?.cmekConfig?.kmsKeyName ?? output?.kmsKeyName ?? "";
      const nextKms = news.cmekConfig?.kmsKeyName ?? previousKms;
      const previousRealtime = (
        olds?.realtimeUpdatesMode ??
        output?.realtimeUpdatesMode ??
        ""
      ).toUpperCase();
      const nextRealtime = (
        news.realtimeUpdatesMode ??
        output?.realtimeUpdatesMode ??
        previousRealtime
      ).toUpperCase();

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousEdition !== nextEdition ||
        previousKms !== nextKms ||
        (news.realtimeUpdatesMode !== undefined &&
          previousRealtime !== nextRealtime);

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousId !== undefined &&
          nextId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const databaseId = yield* toDatabaseId(
        id,
        olds?.databaseId,
        output?.databaseId,
      );
      const name = output?.name ?? resourceName(env.project, databaseId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const labels = yield* getOwnershipLabels(name);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const page = yield* firestore.listProjectsDatabases({
          parent: `projects/${env.project}`,
        });
        const databases = (page.databases ?? []).filter(
          (database) => database.deleteTime === undefined && database.name,
        );
        const owned = yield* Effect.forEach(
          databases,
          (database) =>
            getOwnershipLabels(database.name!).pipe(
              Effect.map((labels) =>
                Object.keys(labels).some((key) => key.startsWith("alchemy-"))
                  ? toAttrs(database, env.project)
                  : undefined,
              ),
            ),
          { concurrency: 8 },
        );
        return owned.filter(
          (database): database is Database["Attributes"] =>
            database !== undefined,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const databaseId = yield* toDatabaseId(
        id,
        news.databaseId,
        output?.databaseId,
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const type = normalizeType(news.type);
      const name = resourceName(env.project, databaseId);
      const desiredProtection =
        news.deleteProtectionState ?? DEFAULT_DELETE_PROTECTION;
      const desiredLabels = yield* createInternalLabels(id);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* firestore
          .createProjectsDatabases({
            parent: `projects/${env.project}`,
            databaseId,
            body: {
              locationId: location,
              type,
              databaseEdition: news.databaseEdition
                ? normalizeEdition(news.databaseEdition)
                : undefined,
              concurrencyMode: news.concurrencyMode,
              pointInTimeRecoveryEnablement: news.pointInTimeRecoveryEnablement,
              appEngineIntegrationMode:
                news.appEngineIntegrationMode ?? DEFAULT_APP_ENGINE,
              deleteProtectionState: desiredProtection,
              realtimeUpdatesMode: news.realtimeUpdatesMode,
              firestoreDataAccessMode: news.firestoreDataAccessMode,
              mongodbCompatibleDataAccessMode:
                news.mongodbCompatibleDataAccessMode,
              cmekConfig: news.cmekConfig?.kmsKeyName
                ? { kmsKeyName: news.cmekConfig.kmsKeyName }
                : undefined,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new DatabaseNotResolved({ name });
      }

      const mask: string[] = [];
      const patchBody: firestore.GoogleFirestoreAdminV1Database = {};

      if (enumChanged(type, current.type)) {
        patchBody.type = type;
        mask.push("type");
      }
      if (enumChanged(news.concurrencyMode, current.concurrencyMode)) {
        patchBody.concurrencyMode = news.concurrencyMode;
        mask.push("concurrencyMode");
      }
      if (
        enumChanged(
          news.pointInTimeRecoveryEnablement,
          current.pointInTimeRecoveryEnablement,
        )
      ) {
        patchBody.pointInTimeRecoveryEnablement =
          news.pointInTimeRecoveryEnablement;
        mask.push("pointInTimeRecoveryEnablement");
      }
      if (
        enumChanged(
          news.appEngineIntegrationMode,
          current.appEngineIntegrationMode,
        )
      ) {
        patchBody.appEngineIntegrationMode = news.appEngineIntegrationMode;
        mask.push("appEngineIntegrationMode");
      }
      if (enumChanged(desiredProtection, current.deleteProtectionState)) {
        patchBody.deleteProtectionState = desiredProtection;
        mask.push("deleteProtectionState");
      }
      if (
        enumChanged(
          news.firestoreDataAccessMode,
          current.firestoreDataAccessMode,
        )
      ) {
        patchBody.firestoreDataAccessMode = news.firestoreDataAccessMode;
        mask.push("firestoreDataAccessMode");
      }
      if (
        enumChanged(
          news.mongodbCompatibleDataAccessMode,
          current.mongodbCompatibleDataAccessMode,
        )
      ) {
        patchBody.mongodbCompatibleDataAccessMode =
          news.mongodbCompatibleDataAccessMode;
        mask.push("mongodbCompatibleDataAccessMode");
      }

      if (mask.length > 0) {
        const patched = yield* retryConcurrentChanges(
          firestore.patchProjectsDatabases({
            name,
            updateMask: mask.join(","),
            body: patchBody,
          }),
        );
        yield* waitForOperation(patched);
        current = yield* waitUntilExists(name);
      }

      const observedOwnership = yield* getOwnershipLabels(name);
      if (!sameOwnership(observedOwnership, desiredLabels)) {
        yield* stampOwnership(name, desiredLabels);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const current = yield* getByName(output.name);
      if (current === undefined) return;

      if (
        normalizeEnum(
          current.deleteProtectionState,
          DEFAULT_DELETE_PROTECTION,
        ) === "DELETE_PROTECTION_ENABLED"
      ) {
        const patched = yield* retryConcurrentChanges(
          firestore.patchProjectsDatabases({
            name: output.name,
            updateMask: "deleteProtectionState",
            body: {
              deleteProtectionState: DEFAULT_DELETE_PROTECTION,
            },
          }),
        );
        yield* waitForOperation(patched);
      }

      yield* retryConcurrentChanges(
        firestore.deleteProjectsDatabases({ name: output.name }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      // Soft-delete: GET reports `deleteTime` long before the LRO is done.
      yield* waitUntilGone(output.name);
    }),
  });
