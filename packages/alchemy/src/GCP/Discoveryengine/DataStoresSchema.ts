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
import type { Providers } from "../Providers.ts";
import {
  expandDataStore,
  fingerprint,
  injectSchemaOwnership,
  internalLabels,
  listProjectDataStores,
  parseJsonObject,
  parseResourceName,
  rfc1035,
  schemaHasOwnership,
  toPhysical,
} from "./internal.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";

export type DataStoresSchemaProps = {
  /**
   * Parent Data Store resource name
   * `projects/{project}/locations/{location}/dataStores/{dataStore}`.
   * Immutable — changing it replaces the schema.
   */
  dataStore: string;
  /**
   * Schema id (RFC-1034, max 63 characters). If omitted, a unique id is
   * generated. Immutable — changing it replaces the schema.
   */
  schemaId?: string;
  /**
   * JSON Schema document. Alchemy stamps a `$comment` ownership marker
   * so `list` / nuke can find the schema.
   */
  jsonSchema?: string;
  /**
   * Structured schema representation. Ignored when `jsonSchema` is set.
   */
  structSchema?: Record<string, unknown>;
};

export type DataStoresSchema = Resource<
  "GCP.Discoveryengine.DataStoresSchema",
  DataStoresSchemaProps,
  {
    /** Full resource name `.../dataStores/{dataStore}/schemas/{schema}`. */
    name: string;
    /** Schema id (last path segment). */
    schemaId: string;
    /** Parent data store resource name. */
    dataStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** JSON schema document, if set. */
    jsonSchema: string | undefined;
    /** Structured schema, if set. */
    structSchema: Record<string, unknown> | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Search Schema attached to a Data Store.
 *
 * Schemas have no labels or display name, so Alchemy stamps ownership
 * into JSON Schema `$comment` for `list` / nuke. Parent and schema id
 * are immutable; the schema document updates in place (LRO).
 *
 * ### Creating a Schema
 * **Example:** JSON schema
 * ```typescript
 * const schema = yield* GCP.Discoveryengine.DataStoresSchema("Catalog", {
 *   dataStore: dataStore.name,
 *   jsonSchema: JSON.stringify({
 *     type: "object",
 *     properties: {
 *       title: { type: "string" },
 *       sku: { type: "string" },
 *     },
 *   }),
 * });
 * ```
 *
 * ### Updating a Schema
 * **Example:** Add a field
 * ```typescript
 * const schema = yield* GCP.Discoveryengine.DataStoresSchema("Catalog", {
 *   dataStore: existing.dataStore,
 *   schemaId: existing.schemaId,
 *   jsonSchema: JSON.stringify({
 *     type: "object",
 *     properties: {
 *       title: { type: "string" },
 *       sku: { type: "string" },
 *       price: { type: "number" },
 *     },
 *   }),
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Discoveryengine
 */
export const DataStoresSchema = Resource<DataStoresSchema>(
  "GCP.Discoveryengine.DataStoresSchema",
);

export class DataStoresSchemaNotResolved extends Data.TaggedError(
  "GCP.Discoveryengine.DataStoresSchemaNotResolved",
)<{
  name: string;
}> {}

const resourceName = (dataStore: string, schemaId: string) =>
  `${dataStore}/schemas/${schemaId}`;

const toAttrs = (
  schema: discoveryengine.GoogleCloudDiscoveryengineV1Schema,
  project: string,
) => {
  const name = schema.name ?? "";
  const parsed = parseResourceName(name, "schemas");
  const json = schema.jsonSchema;
  const obj = parseJsonObject(json);
  if (obj && "$comment" in obj) {
    delete obj.$comment;
  }
  return {
    name,
    schemaId: parsed.id,
    dataStore: parsed.dataStore,
    project: parsed.project || project,
    location: parsed.location,
    jsonSchema: obj ? JSON.stringify(obj) : json,
    structSchema: schema.structSchema as Record<string, unknown> | undefined,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsDataStoresSchemas({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAtParent = (parent: string) =>
  discoveryengine.listProjectsLocationsDataStoresSchemas
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.schemas ?? [])),
      Stream.filter((schema) => schemaHasOwnership(schema.jsonSchema)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
      Effect.catchTag("Forbidden", () => Effect.succeed([])),
    );

export const DataStoresSchemaProvider = () =>
  Provider.succeed(DataStoresSchema, {
    stables: ["name", "schemaId", "dataStore", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.dataStore ?? output?.dataStore;
      if (previousParent !== undefined && news.dataStore !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.schemaId ?? output?.schemaId;
      if (
        previousId !== undefined &&
        news.schemaId !== undefined &&
        news.schemaId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const schemaId = yield* toPhysical(
        id,
        olds?.schemaId,
        output?.schemaId,
        rfc1035,
      );
      const parent = olds?.dataStore
        ? expandDataStore(
            olds.dataStore,
            env.project,
            output?.location ?? "global",
          )
        : undefined;
      const name =
        output?.name ?? (parent ? resourceName(parent, schemaId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return schemaHasOwnership(existing.jsonSchema) ? attrs : Unowned(attrs);
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
                    schemas.map((schema) => toAttrs(schema, env.project)),
                  ),
                )
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = expandDataStore(
        news.dataStore,
        env.project,
        output?.location ?? "global",
      );
      const schemaId = yield* toPhysical(
        id,
        news.schemaId,
        output?.schemaId,
        rfc1035,
      );
      const name = resourceName(parent, schemaId);
      const labels = yield* internalLabels(id);
      const jsonSchema = injectSchemaOwnership(news.jsonSchema, labels);
      const body: discoveryengine.GoogleCloudDiscoveryengineV1Schema = {
        jsonSchema,
        structSchema:
          news.jsonSchema === undefined ? news.structSchema : undefined,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsDataStoresSchemas({
            parent,
            schemaId,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
            Effect.catchIf(
              (error) =>
                error._tag === "BadRequest" &&
                error.message.toLowerCase().includes("already exists"),
              () => Effect.succeed(undefined),
            ),
            Effect.retry({
              while: (error) =>
                error._tag === "BadRequest" &&
                error.message.toLowerCase().includes("try again later"),
              times: 8,
              schedule: Schedule.spaced("5 seconds"),
            }),
          );
        if (created !== undefined) {
          const done = yield* waitForOperation(created);
          const createdName = resourceNameFromOperation(done) ?? name;
          current = yield* getByName(createdName).pipe(
            Effect.flatMap((schema) =>
              schema ? Effect.succeed(schema) : getByName(name),
            ),
          );
        }
        if (current === undefined) {
          current = yield* getByName(name);
        }
        if (current === undefined) {
          const listed = yield* listAtParent(parent);
          current =
            listed.find((schema) =>
              (schema.name ?? "").endsWith(`/${schemaId}`),
            ) ??
            listed.find((schema) => schemaHasOwnership(schema.jsonSchema)) ??
            listed[0];
        }
      }

      if (current === undefined) {
        return yield* new DataStoresSchemaNotResolved({ name });
      }

      const stripComment = (json: string | undefined) => {
        const obj = parseJsonObject(json);
        if (obj && "$comment" in obj) delete obj.$comment;
        return fingerprint(obj ?? json);
      };
      const schemaChanged =
        stripComment(current.jsonSchema) !== stripComment(jsonSchema) ||
        (news.jsonSchema === undefined &&
          fingerprint(current.structSchema) !== fingerprint(news.structSchema));

      if (schemaChanged) {
        const patched =
          yield* discoveryengine.patchProjectsLocationsDataStoresSchemas({
            name: current.name ?? name,
            body: {
              ...body,
              name: current.name ?? name,
            },
          });
        const done = yield* waitForOperation(patched);
        const patchedName =
          resourceNameFromOperation(done) ?? current.name ?? name;
        current = (yield* getByName(patchedName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* discoveryengine
        .deleteProjectsLocationsDataStoresSchemas({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });
