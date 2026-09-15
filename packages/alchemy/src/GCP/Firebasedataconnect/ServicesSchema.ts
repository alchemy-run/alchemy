import * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_SCHEMA_ID,
  expandParent,
  fieldMask,
  fingerprint,
  listAtNested,
  listLabeledPages,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  retryTransient,
  sameText,
  stringMap,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type File = {
  /** File contents (GraphQL SDL). */
  content?: string;
  /**
   * Path relative to the Data Connect workspace, for example
   * `schema.gql`.
   */
  path?: string;
};

export type Source = {
  /** GraphQL source files that make up the schema. */
  files?: File[];
};

export type CloudSqlInstance = {
  /**
   * Cloud SQL instance resource name
   * `projects/{project}/locations/{location}/instances/{instance}`.
   */
  instance?: string;
};

export type HttpGraphql = {
  /** HTTP GraphQL endpoint URI. */
  uri?: string;
  /** Request timeout, for example `"3.5s"`. */
  timeout?: string;
};

export type PostgreSql = {
  /** Cloud SQL instance used as the Postgres backend. */
  cloudSql?: CloudSqlInstance;
  /**
   * When true, no Postgres instance is linked. Do not set `database`
   * or `schemaValidation` together with `unlinked`.
   */
  unlinked?: boolean;
  /** PostgreSQL database name. */
  database?: string;
  /**
   * How much PostgreSQL schema validation to run before deploying
   * (`NONE`, `STRICT`, `COMPATIBLE`).
   */
  schemaValidation?:
    | firebasedataconnect.PostgreSqlSchemaValidationEnum
    | (string & {});
  /**
   * Additive-only PostgreSQL schema migration before deploy
   * (`MIGRATE_COMPATIBLE`).
   */
  schemaMigration?:
    | firebasedataconnect.PostgreSqlSchemaMigrationEnum
    | (string & {});
  /**
   * PostgreSQL schema name.
   * @default "public"
   */
  schema?: string;
};

export type Datasource = {
  /** HTTP GraphQL webhook backend. */
  httpGraphql?: HttpGraphql;
  /** PostgreSQL (Cloud SQL or unlinked) backend. */
  postgresql?: PostgreSql;
};

export type ServicesSchemaProps = {
  /**
   * Parent Data Connect service. Full name
   * `projects/{project}/locations/{location}/services/{service}` or the
   * service id (combined with `location`). Immutable — changing it
   * replaces the schema.
   */
  service: string;
  /**
   * Region used when `service` is a bare id.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Schema id. The API currently only accepts `main`. Immutable —
   * changing it replaces the schema.
   * @default "main"
   */
  schemaId?: string;
  /**
   * GraphQL SDL source files. Required.
   */
  source: Source;
  /**
   * Data sources linked by this schema. Required. Use
   * `{ postgresql: { unlinked: true } }` when no Cloud SQL instance is
   * attached, or `{ postgresql: { database, cloudSql } }` to link one.
   */
  datasources: Datasource[];
  /**
   * Human-readable name. 63 character limit.
   */
  displayName?: string;
  /**
   * User annotations (preserved by external tools).
   */
  annotations?: Record<string, string>;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type ServicesSchema = Resource<
  "GCP.Firebasedataconnect.ServicesSchema",
  ServicesSchemaProps,
  {
    /** Full resource name. */
    name: string;
    /** Schema id (`main`). */
    schemaId: string;
    /** Parent service name. */
    service: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** GraphQL source files. */
    source: Source | undefined;
    /** Linked data sources. */
    datasources: Datasource[] | undefined;
    /** Human-readable name. */
    displayName: string | undefined;
    /** True while Data Connect is compiling or deploying the schema. */
    reconciling: boolean;
    /** True when the Postgres backend is ephemeral in-memory storage. */
    ephemeral: boolean;
    /** User annotations. */
    annotations: Record<string, string>;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Server-computed etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * The application schema of a Firebase Data Connect service. Only
 * `schemas/main` is supported — one schema per service.
 *
 * Changing `service`, `location`, or `schemaId` replaces the schema.
 * Source, datasources, display name, labels, and annotations update in
 * place. Delete fails while connectors still exist; destroy connectors
 * first (or delete the parent service with `force`).
 *
 * ### Creating a Schema
 * **Example:** Unlinked Postgres schema
 * ```typescript
 * const service = yield* GCP.Firebasedataconnect.Service("App", {});
 * const schema = yield* GCP.Firebasedataconnect.ServicesSchema("Main", {
 *   service: service.name,
 *   source: {
 *     files: [{
 *       path: "schema.gql",
 *       content: "type Note @table { title: String! }",
 *     }],
 *   },
 *   datasources: [{ postgresql: { unlinked: true } }],
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Cloud SQL Postgres
 * ```typescript
 * const schema = yield* GCP.Firebasedataconnect.ServicesSchema("Main", {
 *   service: service.name,
 *   source: {
 *     files: [{
 *       path: "schema.gql",
 *       content: "type Movie @table { title: String! }",
 *     }],
 *   },
 *   datasources: [{
 *     postgresql: {
 *       database: "fdcdb",
 *       cloudSql: { instance: sqlInstance.name },
 *       schemaValidation: "NONE",
 *       schemaMigration: "MIGRATE_COMPATIBLE",
 *     },
 *   }],
 * });
 * ```
 *
 * ### Updating a Schema
 * **Example:** New GraphQL types
 * ```typescript
 * const schema = yield* GCP.Firebasedataconnect.ServicesSchema("Main", {
 *   service: service.name,
 *   source: {
 *     files: [{
 *       path: "schema.gql",
 *       content: "type Note @table { title: String! body: String }",
 *     }],
 *   },
 *   datasources: [{ postgresql: { unlinked: true } }],
 *   displayName: "notes v2",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Firebasedataconnect
 */
export const ServicesSchema = Resource<ServicesSchema>(
  "GCP.Firebasedataconnect.ServicesSchema",
);

const resourceName = (service: string, schemaId: string) =>
  `${service}/schemas/${schemaId}`;

const toFile = (value: firebasedataconnect.File): File => ({
  content: value.content,
  path: value.path,
});

const toSource = (
  value: firebasedataconnect.Source | undefined,
): Source | undefined =>
  value === undefined ? undefined : { files: value.files?.map(toFile) };

const toDatasource = (value: firebasedataconnect.Datasource): Datasource => ({
  httpGraphql: value.httpGraphql
    ? { uri: value.httpGraphql.uri, timeout: value.httpGraphql.timeout }
    : undefined,
  postgresql: value.postgresql
    ? {
        cloudSql: value.postgresql.cloudSql
          ? { instance: value.postgresql.cloudSql.instance }
          : undefined,
        unlinked: value.postgresql.unlinked,
        database: value.postgresql.database,
        schemaValidation: value.postgresql.schemaValidation,
        schemaMigration: value.postgresql.schemaMigration,
        schema: value.postgresql.schema,
      }
    : undefined,
});

const toAttrs = (
  item: firebasedataconnect.Firebasedataconnect_Schema,
  project: string,
): ServicesSchema["Attributes"] => {
  const name = item.name ?? "";
  const parsed = parseName(name, "schemas");
  return {
    name,
    schemaId: parsed.id,
    service: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    source: toSource(item.source),
    datasources: item.datasources?.map(toDatasource),
    displayName: item.displayName,
    reconciling: item.reconciling === true,
    ephemeral:
      item.datasources?.some((ds) => ds.postgresql?.ephemeral === true) ===
      true,
    annotations: stringMap(item.annotations),
    labels: userLabels(item.labels),
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
    etag: item.etag,
  };
};

const getByName = (name: string) =>
  firebasedataconnect
    .getProjectsLocationsServicesSchemas({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtNested(project, "services/-", (parent) =>
    listLabeledPages(
      firebasedataconnect.listProjectsLocationsServicesSchemas.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.schemas,
      (item) => item.labels,
    ),
  );

const schemaIdOf = (value: string | undefined) =>
  value === undefined || value.length === 0 ? DEFAULT_SCHEMA_ID : value;

export const ServicesSchemaProvider = () =>
  Provider.succeed(ServicesSchema, {
    stables: [
      "name",
      "schemaId",
      "service",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const previousParent =
        (olds?.service ?? output?.service)
          ? expandParent(
              olds?.service ?? output?.service ?? "",
              env.project,
              previousLocation,
              "services",
            )
          : undefined;
      const nextParent = expandParent(
        news.service,
        env.project,
        location,
        "services",
      );
      return replaceOnIdentity({
        previousId: olds?.schemaId ?? output?.schemaId,
        nextId: schemaIdOf(news.schemaId ?? olds?.schemaId ?? output?.schemaId),
        previousLocation,
        nextLocation: location,
        previousParent,
        nextParent,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const schemaId = schemaIdOf(olds?.schemaId ?? output?.schemaId);
      const location = normalizeLocation(olds?.location ?? output?.location);
      const service =
        output?.service ??
        (olds?.service
          ? expandParent(olds.service, env.project, location, "services")
          : undefined);
      const name =
        output?.name ?? (service ? resourceName(service, schemaId) : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const schemaId = schemaIdOf(news.schemaId ?? output?.schemaId);
      const location = normalizeLocation(news.location ?? output?.location);
      const service = expandParent(
        news.service,
        env.project,
        location,
        "services",
      );
      const name = resourceName(service, schemaId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = news.annotations ?? {};
      const body: firebasedataconnect.Firebasedataconnect_Schema = {
        source: news.source,
        datasources: news.datasources,
        displayName: news.displayName,
        annotations: desiredAnnotations,
        labels: desiredLabels,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retryTransient(
          firebasedataconnect.createProjectsLocationsServicesSchemas({
            parent: service,
            schemaId,
            body,
          }),
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, {
            times: 10,
            interval: "6 seconds",
          });
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        fingerprint(stringMap(current.annotations)) !==
          fingerprint(desiredAnnotations) && "annotations",
        !sameText(current.displayName, news.displayName) && "displayName",
        fingerprint(toSource(current.source)) !== fingerprint(news.source) &&
          "source",
        fingerprint(current.datasources?.map(toDatasource)) !==
          fingerprint(news.datasources) && "datasources",
      ]);

      if (mask.length > 0) {
        const operation = yield* retryTransient(
          firebasedataconnect.patchProjectsLocationsServicesSchemas({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              ...body,
              etag: current.etag,
            },
          }),
        );
        yield* waitForOperation(operation, {
          times: 10,
          interval: "5 seconds",
        });
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
      );
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* retryTransient(
        firebasedataconnect.deleteProjectsLocationsServicesSchemas({
          name: output.name,
          force: true,
        }),
      ).pipe(
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          times: 8,
          schedule: Schedule.spaced("2 seconds"),
        }),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
      if (operation !== undefined) {
        yield* waitForOperation(operation, {
          notFoundOk: true,
          times: 10,
          interval: "5 seconds",
        });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
