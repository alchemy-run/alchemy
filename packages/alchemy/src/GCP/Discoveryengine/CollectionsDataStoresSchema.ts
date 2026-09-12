import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  hasOwnershipMarker,
  injectSchemaOwnership,
  listProjectDataStores,
  ownershipLabels,
  parentOf,
  parseResourceName,
  parseSchemaOwnership,
  rfc1035,
  sameJson,
  toPhysical,
} from "./internal.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";

export type CollectionsDataStoresSchemaProps = {
  /**
   * Parent data store resource name. Immutable — changing it replaces
   * the schema.
   */
  dataStore: string;
  /**
   * Schema id (RFC-1034, max 63 characters). If omitted, a unique id is
   * generated. Immutable — changing it replaces the schema.
   */
  schemaId?: string;
  /**
   * JSON Schema document. Schemas have no labels field, so Alchemy
   * stamps ownership into `description` for `list` / nuke.
   */
  jsonSchema?: string;
  /**
   * Structured schema representation.
   */
  structSchema?: Record<string, unknown>;
};

export type CollectionsDataStoresSchema = Resource<
  "GCP.Discoveryengine.CollectionsDataStoresSchema",
  CollectionsDataStoresSchemaProps,
  {
    /** Full resource name. */
    name: string;
    /** Schema id. */
    schemaId: string;
    /** Parent data store resource name. */
    dataStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** JSON Schema document. */
    jsonSchema: string | undefined;
    /** Structured schema. */
    structSchema: Record<string, unknown> | undefined;
  },
  never,
  Providers
>;

/**
 * A Discovery Engine schema on a collection data store.
 *
 * Schemas have no labels field, so Alchemy stamps ownership into the
 * JSON Schema `description` for `list` / nuke. Parent and schema id are
 * immutable. Schema contents update in place.
 *
 * ### Creating a Schema
 * **Example:** Custom schema on a store without a default schema
 * ```typescript
 * const store = yield* GCP.Discoveryengine.CollectionsDataStore("Docs", {
 *   skipDefaultSchemaCreation: true,
 * });
 * const schema = yield* GCP.Discoveryengine.CollectionsDataStoresSchema(
 *   "Fields",
 *   {
 *     dataStore: store.name,
 *     jsonSchema: JSON.stringify({
 *       type: "object",
 *       properties: { title: { type: "string" } },
 *     }),
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Discoveryengine
 */
export const CollectionsDataStoresSchema =
  Resource<CollectionsDataStoresSchema>(
    "GCP.Discoveryengine.CollectionsDataStoresSchema",
  );

export class CollectionsDataStoresSchemaNotResolved extends Data.TaggedError(
  "GCP.Discoveryengine.CollectionsDataStoresSchemaNotResolved",
)<{
  name: string;
}> {}

export class CollectionsDataStoresSchemaStillExists extends Data.TaggedError(
  "GCP.Discoveryengine.CollectionsDataStoresSchemaStillExists",
)<{
  name: string;
}> {}

const toAttrs = (
  schema: discoveryengine.GoogleCloudDiscoveryengineV1Schema,
  project: string,
) => {
  const name = schema.name ?? "";
  const parsed = parseResourceName(name, "schemas");
  return {
    name,
    schemaId: parsed.id,
    dataStore: parentOf(name, "schemas"),
    project: parsed.project || project,
    location: parsed.location,
    jsonSchema: schema.jsonSchema,
    structSchema: schema.structSchema as Record<string, unknown> | undefined,
  };
};

const resourceName = (dataStore: string, schemaId: string) =>
  `${dataStore}/schemas/${schemaId}`;

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsCollectionsDataStoresSchemas({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAtParent = (parent: string) =>
  discoveryengine.listProjectsLocationsCollectionsDataStoresSchemas
    .pages({ parent, pageSize: 1000 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.schemas ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
      Effect.catchTag("Forbidden", () => Effect.succeed([])),
    );

const ownedJson = (
  schema: discoveryengine.GoogleCloudDiscoveryengineV1Schema,
) => parseSchemaOwnership(schema.jsonSchema);

const findOwned = (id: string, dataStore: string, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const schemas = yield* listAtParent(dataStore);
    for (const schema of schemas) {
      const { labels } = ownedJson(schema);
      if (yield* hasAlchemyLabels(id, labels)) return schema;
    }
    return undefined as
      | discoveryengine.GoogleCloudDiscoveryengineV1Schema
      | undefined;
  });

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((schema) =>
      schema
        ? Effect.succeed(schema)
        : Effect.fail(new CollectionsDataStoresSchemaNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.Discoveryengine.CollectionsDataStoresSchemaNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((schema) =>
      schema === undefined
        ? Effect.void
        : Effect.fail(new CollectionsDataStoresSchemaStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.Discoveryengine.CollectionsDataStoresSchemaStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const CollectionsDataStoresSchemaProvider = () =>
  Provider.succeed(CollectionsDataStoresSchema, {
    stables: ["name", "schemaId", "dataStore", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.dataStore ?? output?.dataStore;
      const previousId = olds?.schemaId ?? output?.schemaId;
      if (
        (previousParent !== undefined && news.dataStore !== previousParent) ||
        (previousId !== undefined &&
          news.schemaId !== undefined &&
          news.schemaId !== previousId)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousParent === news.dataStore &&
            previousId !== undefined &&
            news.schemaId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const dataStore = olds?.dataStore ?? output?.dataStore;
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : dataStore !== undefined
            ? yield* findOwned(id, dataStore)
            : undefined;
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = ownedJson(existing);
      if (output?.name !== undefined) return attrs;
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const stores = yield* listProjectDataStores(env.project);
        const pages = yield* Effect.forEach(
          stores,
          (store) =>
            store.name
              ? listAtParent(store.name).pipe(
                  Effect.map((schemas) =>
                    schemas
                      .filter((schema) => {
                        const owned =
                          Object.keys(ownedJson(schema).labels).length > 0;
                        return owned || hasOwnershipMarker(store.displayName);
                      })
                      .map((schema) => toAttrs(schema, env.project)),
                  ),
                )
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const schemaId = yield* toPhysical(
        id,
        news.schemaId,
        output?.schemaId,
        (name) => rfc1035(name, 32),
        32,
      );
      const name = resourceName(news.dataStore, schemaId);
      const ownership = yield* ownershipLabels(id);
      const jsonSchema = injectSchemaOwnership(news.jsonSchema, ownership);

      let current = yield* findOwned(id, news.dataStore, output?.name);
      if (current === undefined) {
        current = yield* getByName(name);
      }

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsDataStoresSchemas({
            parent: news.dataStore,
            schemaId,
            body: {
              jsonSchema,
              structSchema: news.structSchema,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created).pipe(
            Effect.catchTag(
              "GCP.Discoveryengine.OperationPending",
              () => Effect.void,
            ),
          );
          current = yield* getByName(name);
          if (current === undefined) {
            current = yield* waitUntilExists(name);
          }
        } else {
          current = yield* getByName(name);
        }
      }

      if (current === undefined) {
        return yield* new CollectionsDataStoresSchemaNotResolved({ name });
      }

      const resource = current.name ?? name;
      const jsonChanged = (current.jsonSchema ?? "") !== jsonSchema;
      const structChanged = !sameJson(current.structSchema, news.structSchema);

      if (jsonChanged || structChanged) {
        const patched =
          yield* discoveryengine.patchProjectsLocationsCollectionsDataStoresSchemas(
            {
              name: resource,
              body: {
                name: resource,
                jsonSchema,
                structSchema: news.structSchema,
              },
            },
          );
        const done = yield* waitForOperation(patched);
        current = yield* waitUntilExists(
          resourceNameFromOperation(done) ?? resource,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* discoveryengine
        .deleteProjectsLocationsCollectionsDataStoresSchemas({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
