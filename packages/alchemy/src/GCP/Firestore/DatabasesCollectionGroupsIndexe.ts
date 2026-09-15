import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalLabels,
  databaseIdOf,
  databaseNameOf,
  deleteChildOwnership,
  jsonEqual,
  lastSegment,
  listChildOwnershipNames,
  listOwnedDatabaseNames,
  parseDatabaseName,
  parentOwned,
  stampChildOwnership,
  stringFromMap,
} from "./internal.ts";

const OWNERSHIP_COLLECTION = "_alchemy_indexes";
const DEFAULT_QUERY_SCOPE = "COLLECTION";
const DEFAULT_API_SCOPE = "ANY_API";

export type IndexQueryScope =
  | firestore.GoogleFirestoreAdminV1IndexQueryScopeEnum
  | (string & {});
export type IndexApiScope =
  | firestore.GoogleFirestoreAdminV1IndexApiScopeEnum
  | (string & {});
export type IndexDensity =
  | firestore.GoogleFirestoreAdminV1IndexDensityEnum
  | (string & {});
export type IndexFieldOrder =
  | firestore.GoogleFirestoreAdminV1IndexFieldOrderEnum
  | (string & {});
export type IndexFieldArrayConfig =
  | firestore.GoogleFirestoreAdminV1IndexFieldArrayConfigEnum
  | (string & {});

export type IndexVectorConfig = {
  /** Vector dimension this configuration applies to. */
  dimension?: number;
  /** Flat (exhaustive) vector index. */
  flat?: Record<string, never>;
};

export type IndexField = {
  /**
   * Field path to index. `__name__` is valid. For composite indexes
   * the API appends `__name__` when it is omitted as the last field.
   */
  fieldPath?: string;
  /** Order for inequality / sort (`ASCENDING`, `DESCENDING`). */
  order?: IndexFieldOrder;
  /** Array-contains indexing (`CONTAINS`). */
  arrayConfig?: IndexFieldArrayConfig;
  /** Vector nearest-neighbor configuration. */
  vectorConfig?: IndexVectorConfig;
};

export type DatabasesCollectionGroupsIndexeProps = {
  /**
   * Parent database. Full name `projects/{project}/databases/{database}`
   * or the database id. Immutable — changing it replaces the index.
   */
  database: string;
  /**
   * Collection group id (`users`, `posts`, …). Immutable — changing it
   * replaces the index.
   */
  collectionGroup: string;
  /**
   * Indexed fields. Composite indexes need 2–100 fields. Immutable —
   * changing fields replaces the index.
   */
  fields: IndexField[];
  /**
   * Query scope.
   * @default "COLLECTION"
   */
  queryScope?: IndexQueryScope;
  /**
   * API scope.
   * @default "ANY_API"
   */
  apiScope?: IndexApiScope;
  /**
   * Index density. Immutable — changing it replaces the index.
   */
  density?: IndexDensity;
  /**
   * Unique index. Immutable — changing it replaces the index.
   * @default false
   */
  unique?: boolean;
  /**
   * Multikey index (MongoDB-compatible API). Immutable.
   * @default false
   */
  multikey?: boolean;
  /**
   * Shard count. Immutable — changing it replaces the index.
   */
  shardCount?: number;
};

export type DatabasesCollectionGroupsIndexe = Resource<
  "GCP.Firestore.DatabasesCollectionGroupsIndexe",
  DatabasesCollectionGroupsIndexeProps,
  {
    /** Full resource name `.../collectionGroups/{collection}/indexes/{index}`. */
    name: string;
    /** Server-assigned index id. */
    indexId: string;
    /** Parent collection group resource name. */
    collectionGroup: string;
    /** Collection group id. */
    collectionGroupId: string;
    /** Parent database resource name. */
    database: string;
    /** Parent database id. */
    databaseId: string;
    /** Project id. */
    project: string;
    /** Query scope. */
    queryScope: string | undefined;
    /** API scope. */
    apiScope: string | undefined;
    /** Density. */
    density: string | undefined;
    /** Serving state (`CREATING`, `READY`, `NEEDS_REPAIR`). */
    state: string | undefined;
    /** Indexed fields. */
    fields: IndexField[];
    /** Whether the index is unique. */
    unique: boolean;
    /** Whether the index is multikey. */
    multikey: boolean;
    /** Shard count, if set. */
    shardCount: number | undefined;
  },
  never,
  Providers
>;

/**
 * A composite Firestore index on a collection group.
 *
 * The index id is assigned by the API. Indexes are immutable — changing
 * fields, scope, density, uniqueness, or the parent collection replaces
 * the index. Indexes have no labels field; Alchemy stamps ownership
 * into a `_alchemy_indexes` document on the parent database so `list`
 * / `pnpm nuke:gcp` can find them.
 *
 * ### Creating an Index
 * **Example:** Composite index on a collection
 * ```typescript
 * const database = yield* GCP.Firestore.Database("App", {
 *   location: "us-central1",
 * });
 * const index = yield* GCP.Firestore.DatabasesCollectionGroupsIndexe(
 *   "UsersByName",
 *   {
 *     database: database.name,
 *     collectionGroup: "users",
 *     queryScope: "COLLECTION",
 *     fields: [
 *       { fieldPath: "name", order: "ASCENDING" },
 *       { fieldPath: "created", order: "DESCENDING" },
 *     ],
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Firestore
 */
export const DatabasesCollectionGroupsIndexe =
  Resource<DatabasesCollectionGroupsIndexe>(
    "GCP.Firestore.DatabasesCollectionGroupsIndexe",
  );

export class IndexNotResolved extends Data.TaggedError(
  "GCP.Firestore.IndexNotResolved",
)<{
  name: string;
}> {}

export class IndexStillExists extends Data.TaggedError(
  "GCP.Firestore.IndexStillExists",
)<{
  name: string;
}> {}

const normalizeEnum = (value: string | undefined, fallback: string) => {
  const next = (value ?? fallback).toUpperCase();
  return next.endsWith("_UNSPECIFIED") ? fallback : next;
};

const fieldOf = (
  field: IndexField | firestore.GoogleFirestoreAdminV1IndexField,
): IndexField => ({
  fieldPath: field.fieldPath,
  order: field.order,
  arrayConfig: field.arrayConfig,
  vectorConfig:
    field.vectorConfig !== undefined
      ? {
          dimension: field.vectorConfig.dimension,
          flat: field.vectorConfig.flat !== undefined ? {} : undefined,
        }
      : undefined,
});

const canonicalizeFields = (
  fields: readonly (IndexField | firestore.GoogleFirestoreAdminV1IndexField)[],
) => {
  const mapped = fields.map(fieldOf);
  const last = mapped[mapped.length - 1];
  if (last !== undefined && last.fieldPath !== "__name__") {
    mapped.push({
      fieldPath: "__name__",
      order: last.order ?? "ASCENDING",
    });
  }
  return mapped;
};

const fieldsKey = (
  fields:
    | readonly (IndexField | firestore.GoogleFirestoreAdminV1IndexField)[]
    | undefined,
) =>
  JSON.stringify(
    canonicalizeFields(fields ?? []).map((field) => ({
      fieldPath: field.fieldPath ?? "",
      order: field.order?.toUpperCase(),
      arrayConfig: field.arrayConfig?.toUpperCase(),
      vectorConfig: field.vectorConfig,
    })),
  );

const collectionGroupParent = (
  project: string,
  database: string,
  collectionGroup: string,
) =>
  `${databaseNameOf(project, database)}/collectionGroups/${lastSegment(collectionGroup)}`;

const toAttrs = (
  index: firestore.GoogleFirestoreAdminV1Index,
  project: string,
): DatabasesCollectionGroupsIndexe["Attributes"] => {
  const name = index.name ?? "";
  const parsed = parseDatabaseName(name);
  const database = databaseNameOf(parsed.project || project, parsed.databaseId);
  return {
    name,
    indexId: parsed.indexId || lastSegment(name),
    collectionGroup: `${database}/collectionGroups/${parsed.collectionGroup}`,
    collectionGroupId: parsed.collectionGroup,
    database,
    databaseId: parsed.databaseId,
    project: parsed.project || project,
    queryScope: index.queryScope,
    apiScope: index.apiScope,
    density: index.density,
    state: index.state,
    fields: (index.fields ?? []).map(fieldOf),
    unique: index.unique === true,
    multikey: index.multikey === true,
    shardCount: index.shardCount,
  };
};

const desiredBody = (news: DatabasesCollectionGroupsIndexeProps) => ({
  queryScope: news.queryScope ?? DEFAULT_QUERY_SCOPE,
  apiScope: news.apiScope ?? DEFAULT_API_SCOPE,
  density: news.density,
  unique: news.unique === true ? true : undefined,
  multikey: news.multikey === true ? true : undefined,
  shardCount: news.shardCount,
  fields: news.fields.map(fieldOf),
});

const matchesDesired = (
  index: firestore.GoogleFirestoreAdminV1Index,
  news: DatabasesCollectionGroupsIndexeProps,
) => {
  const desired = desiredBody(news);
  return (
    normalizeEnum(index.queryScope, DEFAULT_QUERY_SCOPE) ===
      normalizeEnum(desired.queryScope, DEFAULT_QUERY_SCOPE) &&
    normalizeEnum(index.apiScope, DEFAULT_API_SCOPE) ===
      normalizeEnum(desired.apiScope, DEFAULT_API_SCOPE) &&
    (index.unique === true) === (desired.unique === true) &&
    (index.multikey === true) === (desired.multikey === true) &&
    jsonEqual(index.shardCount, desired.shardCount) &&
    (desired.density === undefined ||
      normalizeEnum(index.density, desired.density) ===
        normalizeEnum(desired.density, desired.density)) &&
    fieldsKey(index.fields) === fieldsKey(desired.fields)
  );
};

const getByName = (name: string) =>
  firestore
    .getProjectsDatabasesCollectionGroupsIndexes({ name })
    .pipe(
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed(undefined),
      ),
    );

const listOnParent = (parent: string) =>
  firestore.listProjectsDatabasesCollectionGroupsIndexes({ parent }).pipe(
    Effect.map((page) => page.indexes ?? []),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed([] as firestore.GoogleFirestoreAdminV1Index[]),
    ),
  );

const nameFromOperation = (
  operation: firestore.GoogleLongrunningOperation,
): string | undefined =>
  stringFromMap(operation.response, "name") ??
  stringFromMap(operation.metadata, "index") ??
  stringFromMap(operation.metadata, "name");

const resolveCreatedIndexName = (
  operation: firestore.GoogleLongrunningOperation | undefined,
  parent: string,
  news: DatabasesCollectionGroupsIndexeProps,
) =>
  Effect.gen(function* () {
    if (operation !== undefined) {
      const immediate = nameFromOperation(operation);
      if (immediate !== undefined) return immediate;
      if (operation.name !== undefined) {
        const latest = yield* firestore
          .getProjectsDatabasesOperations({ name: operation.name })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(operation)));
        const fromOp = nameFromOperation(latest);
        if (fromOp !== undefined) return fromOp;
      }
    }
    const match = (yield* listOnParent(parent)).find((index) =>
      matchesDesired(index, news),
    );
    if (match?.name !== undefined) return match.name;
    return yield* new IndexNotResolved({ name: `${parent}/indexes` });
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "GCP.Firestore.IndexNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((index) =>
      index
        ? Effect.succeed(index)
        : Effect.fail(new IndexNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Firestore.IndexNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (index) => index === undefined,
      () => new IndexStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Firestore.IndexStillExists",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.asVoid,
  );

export const DatabasesCollectionGroupsIndexeProvider = () =>
  Provider.succeed(DatabasesCollectionGroupsIndexe, {
    stables: [
      "name",
      "indexId",
      "collectionGroup",
      "collectionGroupId",
      "database",
      "databaseId",
      "project",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousDatabase = databaseIdOf(
        olds?.database ?? output?.database ?? output?.databaseId ?? "",
      );
      const nextDatabase = databaseIdOf(news.database);
      const previousGroup = lastSegment(
        olds?.collectionGroup ?? output?.collectionGroupId ?? "",
      );
      const nextGroup = lastSegment(news.collectionGroup);
      const previousFields = fieldsKey(olds?.fields ?? output?.fields);
      const nextFields = fieldsKey(news.fields);
      const previousScope = normalizeEnum(
        olds?.queryScope ?? output?.queryScope,
        DEFAULT_QUERY_SCOPE,
      );
      const nextScope = normalizeEnum(news.queryScope, DEFAULT_QUERY_SCOPE);
      const previousApi = normalizeEnum(
        olds?.apiScope ?? output?.apiScope,
        DEFAULT_API_SCOPE,
      );
      const nextApi = normalizeEnum(news.apiScope, DEFAULT_API_SCOPE);
      const previousUnique = olds?.unique === true || output?.unique === true;
      const nextUnique = news.unique === true;
      const previousMultikey =
        olds?.multikey === true || output?.multikey === true;
      const nextMultikey = news.multikey === true;
      const previousDensity = (
        olds?.density ??
        output?.density ??
        ""
      ).toUpperCase();
      const nextDensity = (news.density ?? previousDensity).toUpperCase();
      const previousShards = olds?.shardCount ?? output?.shardCount;
      const nextShards = news.shardCount ?? previousShards;
      if (
        (previousDatabase.length > 0 && previousDatabase !== nextDatabase) ||
        (previousGroup.length > 0 && previousGroup !== nextGroup) ||
        previousFields !== nextFields ||
        previousScope !== nextScope ||
        previousApi !== nextApi ||
        previousUnique !== nextUnique ||
        previousMultikey !== nextMultikey ||
        (news.density !== undefined && previousDensity !== nextDensity) ||
        previousShards !== nextShards
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const name = output?.name;
      if (name === undefined || name.length === 0) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const parent =
        olds?.database !== undefined
          ? databaseNameOf(env.project, olds.database)
          : attrs.database;
      return (yield* parentOwned(parent)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const databases = yield* listOwnedDatabaseNames(env.project);
        const names = yield* Effect.forEach(
          databases,
          (database) => listChildOwnershipNames(database, OWNERSHIP_COLLECTION),
          { concurrency: 4 },
        );
        const unique = [...new Set(names.flat())];
        const indexes = yield* Effect.forEach(
          unique,
          (name) =>
            getByName(name).pipe(
              Effect.map((index) =>
                index !== undefined ? toAttrs(index, env.project) : undefined,
              ),
            ),
          { concurrency: 8 },
        );
        return indexes.filter(
          (index): index is DatabasesCollectionGroupsIndexe["Attributes"] =>
            index !== undefined,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const databaseName = databaseNameOf(env.project, news.database);
      const parent = collectionGroupParent(
        env.project,
        news.database,
        news.collectionGroup,
      );
      const labels = yield* createInternalLabels(id);
      const body = desiredBody(news);

      let current =
        output?.name !== undefined ? yield* getByName(output.name) : undefined;

      if (current === undefined) {
        const existing = yield* listOnParent(parent);
        current = existing.find((index) => matchesDesired(index, news));
      }

      if (current === undefined) {
        const created = yield* firestore
          .createProjectsDatabasesCollectionGroupsIndexes({
            parent,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        const name = yield* resolveCreatedIndexName(created, parent, news);
        current = yield* waitUntilExists(name);
      } else if (current.name !== undefined) {
        current = yield* waitUntilExists(current.name);
      }

      if (current === undefined || current.name === undefined) {
        return yield* new IndexNotResolved({ name: `${parent}/indexes` });
      }

      yield* stampChildOwnership(
        databaseName,
        OWNERSHIP_COLLECTION,
        labels,
        current.name,
      );
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ id, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = databaseNameOf(env.project, output.database);
      const labels = yield* createInternalLabels(id);
      yield* firestore
        .deleteProjectsDatabasesCollectionGroupsIndexes({
          name: output.name,
        })
        .pipe(Effect.catchTag(["NotFound", "Forbidden"], () => Effect.void));
      yield* waitUntilGone(output.name);
      yield* deleteChildOwnership(parent, OWNERSHIP_COLLECTION, labels);
    }),
  });
