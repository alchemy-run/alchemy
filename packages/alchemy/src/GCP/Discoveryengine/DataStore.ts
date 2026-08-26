import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  findOwnedByDisplayName,
  hasOwnershipMarker,
  listDataStores,
  locationParent,
  normalizeLocation,
  ownershipLabels,
  parseOwnership,
  parseResourceName,
  sameStringList,
  toResourceId,
} from "./internal.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";

export type DataStoreProps = {
  /**
   * Data store id (the `{dataStore}` segment of the resource name). If
   * omitted, a unique RFC-1034 id is generated. Immutable — changing it
   * replaces the data store.
   */
  dataStoreId?: string;
  /**
   * Location (`global`, `us`, `eu`, …). Immutable — changing it replaces
   * the data store.
   * @default "global"
   */
  location?: string;
  /**
   * User-facing display name (max 128 characters). Data stores have no
   * labels field, so Alchemy stamps ownership into this field for list /
   * nuke.
   */
  displayName?: string;
  /**
   * Industry vertical. Immutable — changing it replaces the data store.
   * @default "GENERIC"
   */
  industryVertical?: discoveryengine.GoogleCloudDiscoveryengineV1DataStoreIndustryVerticalEnum;
  /**
   * Content config. Immutable — changing it replaces the data store.
   * @default "NO_CONTENT"
   */
  contentConfig?: discoveryengine.GoogleCloudDiscoveryengineV1DataStoreContentConfigEnum;
  /**
   * Solutions to enroll. Available values depend on `industryVertical`.
   * @default ["SOLUTION_TYPE_SEARCH"]
   */
  solutionTypes?: discoveryengine.GoogleCloudDiscoveryengineV1DataStoreSolutionTypesItemEnumList;
  /**
   * Whether ingested documents carry ACL information. Immutable.
   * @default false
   */
  aclEnabled?: boolean;
  /**
   * Skip creating the default schema. Cannot be combined with a starting
   * schema.
   * @default false
   */
  skipDefaultSchemaCreation?: boolean;
  /**
   * Create an advanced site-search data store. Ignored unless the store
   * is GENERIC + PUBLIC_WEBSITE.
   * @default false
   */
  createAdvancedSiteSearch?: boolean;
  /**
   * Disable CMEK even if the project has a default CmekConfig.
   * @default true
   */
  disableCmek?: boolean;
  /**
   * Resource name of the CmekConfig used to protect this data store.
   */
  cmekConfigName?: string;
  /**
   * Customer-managed KMS key used at creation time.
   */
  kmsKeyName?: string;
};

export type DataStore = Resource<
  "GCP.Discoveryengine.DataStore",
  DataStoreProps,
  {
    /** Full resource name. */
    name: string;
    /** Data store id (last path segment). */
    dataStoreId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Collection id parsed from the resource name, if present. */
    collectionId: string | undefined;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Industry vertical. */
    industryVertical: string | undefined;
    /** Content config. */
    contentConfig: string | undefined;
    /** Enrolled solutions. */
    solutionTypes: string[];
    /** Whether ACL is enabled. */
    aclEnabled: boolean;
    /** Default schema id. */
    defaultSchemaId: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Discovery Engine DataStore — a container for Documents.
 *
 * Location-scoped (`projects/{project}/locations/{location}/dataStores`).
 * Data stores have no labels, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Id, location, vertical, content
 * config, and ACL are immutable; display name updates in place.
 *
 * ### Creating a Data Store
 * **Example:** Generated id, generic search store
 * ```typescript
 * const store = yield* GCP.Discoveryengine.DataStore("Docs", {
 *   displayName: "docs",
 * });
 * ```
 *
 * **Example:** Explicit id
 * ```typescript
 * const store = yield* GCP.Discoveryengine.DataStore("Docs", {
 *   dataStoreId: "app-docs",
 *   location: "global",
 *   industryVertical: "GENERIC",
 *   contentConfig: "NO_CONTENT",
 *   solutionTypes: ["SOLUTION_TYPE_SEARCH"],
 * });
 * ```
 *
 * ### Updating a Data Store
 * **Example:** Rename
 * ```typescript
 * const store = yield* GCP.Discoveryengine.DataStore("Docs", {
 *   dataStoreId: existing.dataStoreId,
 *   displayName: "docs-prod",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Discoveryengine
 */
export const DataStore = Resource<DataStore>("GCP.Discoveryengine.DataStore");

export class DataStoreNotResolved extends Data.TaggedError(
  "GCP.Discoveryengine.DataStoreNotResolved",
)<{
  name: string;
}> {}

export class DataStoreStillExists extends Data.TaggedError(
  "GCP.Discoveryengine.DataStoreStillExists",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, dataStoreId: string) =>
  `projects/${project}/locations/${location}/dataStores/${dataStoreId}`;

const verticalOf = (
  value:
    | discoveryengine.GoogleCloudDiscoveryengineV1DataStoreIndustryVerticalEnum
    | undefined,
) => value ?? "GENERIC";

const contentOf = (
  value:
    | discoveryengine.GoogleCloudDiscoveryengineV1DataStoreContentConfigEnum
    | undefined,
) => value ?? "NO_CONTENT";

const solutionsOf = (
  value:
    | discoveryengine.GoogleCloudDiscoveryengineV1DataStoreSolutionTypesItemEnumList
    | undefined,
): discoveryengine.GoogleCloudDiscoveryengineV1DataStoreSolutionTypesItemEnumList =>
  value && value.length > 0 ? value : ["SOLUTION_TYPE_SEARCH"];

const getByName = (name: string) =>
  discoveryengine
    .getProjectsLocationsDataStores({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toAttrs = (
  store: discoveryengine.GoogleCloudDiscoveryengineV1DataStore,
  project: string,
) => {
  const name = store.name ?? "";
  const parsed = parseResourceName(name, "dataStores");
  const ownership = parseOwnership(store.displayName);
  return {
    name,
    dataStoreId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    collectionId: name.includes("/collections/")
      ? parsed.collectionId
      : undefined,
    displayName: ownership.text,
    industryVertical: store.industryVertical,
    contentConfig: store.contentConfig,
    solutionTypes: [...(store.solutionTypes ?? [])],
    aclEnabled: store.aclEnabled === true,
    defaultSchemaId: store.defaultSchemaId,
    createTime: store.createTime,
  };
};

const findOwned = (id: string, project: string, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    return yield* findOwnedByDisplayName(id, yield* listDataStores(project));
  });

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((store) =>
      store
        ? Effect.succeed(store)
        : Effect.fail(new DataStoreNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Discoveryengine.DataStoreNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((store) =>
      store === undefined
        ? Effect.void
        : Effect.fail(new DataStoreStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Discoveryengine.DataStoreStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const DataStoreProvider = () =>
  Provider.succeed(DataStore, {
    stables: [
      "name",
      "dataStoreId",
      "project",
      "location",
      "collectionId",
      "industryVertical",
      "contentConfig",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.dataStoreId ?? output?.dataStoreId;
      const nextId = news.dataStoreId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      const previousVertical = verticalOf(
        olds?.industryVertical ??
          (output?.industryVertical as DataStoreProps["industryVertical"]),
      );
      const nextVertical = verticalOf(
        news.industryVertical ??
          (output?.industryVertical as DataStoreProps["industryVertical"]),
      );
      const previousContent = contentOf(
        olds?.contentConfig ??
          (output?.contentConfig as DataStoreProps["contentConfig"]),
      );
      const nextContent = contentOf(
        news.contentConfig ??
          (output?.contentConfig as DataStoreProps["contentConfig"]),
      );
      const previousAcl = olds?.aclEnabled ?? output?.aclEnabled ?? false;
      const nextAcl = news.aclEnabled ?? previousAcl;
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousVertical !== nextVertical ||
        previousContent !== nextContent ||
        previousAcl !== nextAcl;
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* findOwned(id, env.project, output?.name);
      if (existing === undefined) {
        if (output?.name) return undefined;
        const dataStoreId = yield* toResourceId(
          id,
          olds?.dataStoreId,
          output?.dataStoreId,
        );
        const location = normalizeLocation(olds?.location ?? output?.location);
        const named = yield* getByName(
          resourceName(env.project, location, dataStoreId),
        );
        if (named === undefined) return undefined;
        const attrs = toAttrs(named, env.project);
        const { labels } = parseOwnership(named.displayName);
        return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
      }
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseOwnership(existing.displayName);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const stores = yield* listDataStores(env.project);
        return stores
          .filter((store) => hasOwnershipMarker(store.displayName))
          .map((store) => toAttrs(store, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const dataStoreId = yield* toResourceId(
        id,
        news.dataStoreId,
        output?.dataStoreId,
      );
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnership(ownership, news.displayName);
      const industryVertical = verticalOf(news.industryVertical);
      const contentConfig = contentOf(news.contentConfig);
      const solutionTypes = solutionsOf(news.solutionTypes);
      const parent = locationParent(env.project, location);
      const fallbackName =
        output?.name ?? resourceName(env.project, location, dataStoreId);

      let current = yield* findOwned(id, env.project, output?.name);
      if (current === undefined && news.dataStoreId !== undefined) {
        current = yield* getByName(
          resourceName(env.project, location, news.dataStoreId),
        );
      }

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsDataStores({
            parent,
            dataStoreId,
            skipDefaultSchemaCreation: news.skipDefaultSchemaCreation,
            createAdvancedSiteSearch: news.createAdvancedSiteSearch,
            disableCmek: news.disableCmek ?? true,
            cmekConfigName: news.cmekConfigName,
            body: {
              displayName,
              industryVertical,
              contentConfig,
              solutionTypes,
              aclEnabled: news.aclEnabled === true ? true : undefined,
              kmsKeyName: news.kmsKeyName,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const done = yield* waitForOperation(created);
          const createdName =
            resourceNameFromOperation(done) ??
            (yield* findOwned(id, env.project))?.name ??
            fallbackName;
          if (createdName !== undefined && createdName.length > 0) {
            current = yield* waitUntilExists(createdName).pipe(
              Effect.catchTag("GCP.Discoveryengine.DataStoreNotResolved", () =>
                findOwned(id, env.project),
              ),
            );
          }
        }
        if (current === undefined) {
          current = yield* findOwned(id, env.project);
        }
      }

      if (current === undefined) {
        return yield* new DataStoreNotResolved({ name: fallbackName });
      }

      const name = current.name ?? fallbackName;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const solutionsChanged = !sameStringList(
        current.solutionTypes,
        solutionTypes,
      );

      if (displayNameChanged || solutionsChanged) {
        current = yield* discoveryengine.patchProjectsLocationsDataStores({
          name,
          updateMask: [
            displayNameChanged ? "display_name" : undefined,
            solutionsChanged ? "solution_types" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          body: {
            name,
            displayName,
            solutionTypes,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* discoveryengine
        .deleteProjectsLocationsDataStores({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
