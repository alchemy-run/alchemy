/**
 * Iceberg as a store: tables in an Iceberg catalog, written and read through
 * DuckDB's `iceberg` extension, on any catalog speaking the Iceberg REST
 * specification. The suites run it against the Apache Iceberg REST fixture,
 * Lakekeeper, Polaris, Nessie and Gravitino, with data files on S3-compatible
 * storage (MinIO). AWS Glue's Iceberg endpoint has a live suite. The other
 * catalogs and storages declared here (Amazon S3 Tables, Google BigLake,
 * Cloudflare R2 Data Catalog, Unity, GCS, ADLS) attach as DuckDB documents
 * them and have not been run against the service.
 *
 * The store is `Export.Sql.store` on DuckDB's `SqlClient` with the catalog
 * attached: the same writes, reads and filter push-down as every SQL store,
 * with Iceberg's limits (see `Export.Sql`). A catalog cannot be counted on to
 * keep views (S3 Tables has none, DuckDB cannot write them), so an engine
 * finds a table's promoted generation through `names`.
 *
 * @module
 */

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { SqlClient } from "effect/sql/SqlClient";
import * as DuckDb from "./DuckDb.ts";
import { EngineUnavailable, QueryFailed } from "./Engine.ts";
import type * as Engine from "./Engine.ts";
import { columnName, generationName, type Logical, type TableSpec } from "./Spec.ts";
import { store as sqlStore } from "./SqlStore.ts";
import type * as Store from "./Store.ts";

// ---------------------------------------------------------------- catalog auth

/** A catalog that needs no credentials (a local REST server). */
export class NoAuth extends Data.TaggedClass("NoAuth")<{}> {}

/** A bearer token: R2 Data Catalog, a Unity personal access token, a token minted elsewhere. */
export class Bearer extends Data.TaggedClass("Bearer")<{
  readonly token: Redacted.Redacted<string>;
}> {}

/** OAuth2 client credentials: Polaris, Lakekeeper, Nessie, Gravitino behind an identity provider. */
export class OAuth2 extends Data.TaggedClass("OAuth2")<{
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  /** The token endpoint; defaults to the catalog's own `/v1/oauth/tokens`. */
  readonly serverUri?: string | undefined;
  readonly scope?: string | undefined;
}> {}

export type Auth = NoAuth | Bearer | OAuth2;

// ---------------------------------------------------------------- catalogs

/** Behaviour a catalog may lack; each defaults to the REST specification's. */
export interface Compatibility {
  /** `false` for a catalog without staged table creation (S3 Tables, Unity). */
  readonly stageCreateTables?: boolean | undefined;
  /** `false` for a catalog that rejects multi-table commits. */
  readonly multiTableCommit?: boolean | undefined;
}

/** Any Iceberg REST catalog. */
export class Rest extends Data.TaggedClass("Rest")<{
  /** The catalog's REST endpoint, without `/v1`. */
  readonly uri: string;
  /** The warehouse: a name, or a location such as `s3://bucket/path`. */
  readonly warehouse: string;
  readonly auth?: Auth | undefined;
  /**
   * Storage access: `true` asks the catalog for each table's credentials
   * (Polaris, Lakekeeper, Unity); `false` uses the storage's own keys and
   * ignores storage settings the catalog returns (an endpoint only its own
   * network resolves, say); unset leaves the choice to DuckDB (vended).
   */
  readonly vendedCredentials?: boolean | undefined;
  readonly compatibility?: Compatibility | undefined;
}> {}

/** Amazon S3 Tables: a table bucket, signed with the AWS credential chain (or the storage's keys). Not yet run against S3 Tables. */
export class S3Tables extends Data.TaggedClass("S3Tables")<{
  /** The table bucket's ARN. */
  readonly arn: string;
}> {}

/** AWS Glue's Iceberg REST endpoint (SageMaker Lakehouse), signed with the AWS credential chain. */
export class Glue extends Data.TaggedClass("Glue")<{
  /** The warehouse: an account id, `account:catalog`, or a federated `catalog/sub`. */
  readonly warehouse: string;
  readonly region: string;
}> {}

/** Google BigLake's Iceberg REST catalog. Access tokens last an hour: rebuild the layer to refresh. Not yet run against BigLake. */
export class BigLake extends Data.TaggedClass("BigLake")<{
  /** The warehouse: `gs://bucket`. */
  readonly warehouse: string;
  /** The project billed for requests. */
  readonly project: string;
  readonly token: Redacted.Redacted<string>;
}> {}

export type Catalog = Rest | S3Tables | Glue | BigLake;

/** Cloudflare R2 Data Catalog: a REST catalog with an R2 API token. Not yet run against R2. */
export const R2 = (options: {
  readonly uri: string;
  readonly warehouse: string;
  readonly token: Redacted.Redacted<string>;
}) =>
  new Rest({
    uri: options.uri,
    warehouse: options.warehouse,
    auth: new Bearer({ token: options.token }),
  });

// ---------------------------------------------------------------- storage

/** S3, or anything speaking its API (MinIO, R2, SeaweedFS, Ceph). Without keys, the AWS credential chain. */
export class S3 extends Data.TaggedClass("S3")<{
  readonly region?: string | undefined;
  /** `host:port` of an S3-compatible service. */
  readonly endpoint?: string | undefined;
  readonly urlStyle?: "path" | "vhost" | undefined;
  readonly useSsl?: boolean | undefined;
  readonly keyId?: string | undefined;
  readonly secret?: Redacted.Redacted<string> | undefined;
  readonly sessionToken?: Redacted.Redacted<string> | undefined;
}> {}

/** Google Cloud Storage with HMAC keys. Not yet run against GCS. */
export class Gcs extends Data.TaggedClass("Gcs")<{
  readonly keyId: string;
  readonly secret: Redacted.Redacted<string>;
}> {}

/** Azure Data Lake Storage: a connection string, or the account with Azure's credential chain. Not yet run against ADLS. */
export class Adls extends Data.TaggedClass("Adls")<{
  readonly connectionString?: Redacted.Redacted<string> | undefined;
  readonly accountName?: string | undefined;
}> {}

export type Storage = S3 | Gcs | Adls;

// ---------------------------------------------------------------- DuckDB setup

/** The alias the catalog is attached under, and so the first part of every table's name. */
export const catalogAlias = "lake";

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
const option = (name: string, value: string | boolean | undefined) =>
  value === undefined ? [] : [`${name} ${typeof value === "boolean" ? value : quote(value)}`];

const storageSecret = (storage: Storage): string => {
  switch (storage._tag) {
    case "S3":
      return `CREATE OR REPLACE SECRET export_storage (${[
        "TYPE s3",
        ...(storage.keyId === undefined ? ["PROVIDER credential_chain"] : []),
        ...option("KEY_ID", storage.keyId),
        ...option("SECRET", storage.secret && Redacted.value(storage.secret)),
        ...option("SESSION_TOKEN", storage.sessionToken && Redacted.value(storage.sessionToken)),
        ...option("REGION", storage.region),
        ...option("ENDPOINT", storage.endpoint),
        ...option("URL_STYLE", storage.urlStyle),
        ...(storage.useSsl === undefined ? [] : [`USE_SSL ${storage.useSsl}`]),
      ].join(", ")})`;
    case "Gcs":
      return `CREATE OR REPLACE SECRET export_storage (TYPE gcs, KEY_ID ${quote(storage.keyId)}, SECRET ${storage.secret.pipe(Redacted.value, quote)})`;
    case "Adls":
      return storage.connectionString !== undefined
        ? `CREATE OR REPLACE SECRET export_storage (TYPE azure, CONNECTION_STRING ${storage.connectionString.pipe(Redacted.value, quote)})`
        : `CREATE OR REPLACE SECRET export_storage (TYPE azure, PROVIDER credential_chain${storage.accountName === undefined ? "" : `, ACCOUNT_NAME ${quote(storage.accountName)}`})`;
  }
};

/** The catalog's OAuth2 token endpoint: the one given, or the REST spec's default under its URI. */
export const tokenEndpointOf = (catalog: Rest, auth: OAuth2): string =>
  auth.serverUri ?? `${catalog.uri.replace(/\/$/, "")}/v1/oauth/tokens`;

const restSecret = (catalog: Rest): ReadonlyArray<string> => {
  const auth = catalog.auth;
  if (auth === undefined || auth._tag === "NoAuth") return [];
  return auth._tag === "Bearer"
    ? [
        `CREATE OR REPLACE SECRET export_catalog (TYPE iceberg, TOKEN ${auth.token.pipe(Redacted.value, quote)})`,
      ]
    : [
        `CREATE OR REPLACE SECRET export_catalog (${[
          "TYPE iceberg",
          `CLIENT_ID ${quote(auth.clientId)}`,
          `CLIENT_SECRET ${auth.clientSecret.pipe(Redacted.value, quote)}`,
          `OAUTH2_SERVER_URI ${quote(tokenEndpointOf(catalog, auth))}`,
          ...option("OAUTH2_SCOPE", auth.scope),
        ].join(", ")})`,
      ];
};

const attach = (catalog: Catalog): ReadonlyArray<string> => {
  switch (catalog._tag) {
    case "Rest":
      return [
        ...restSecret(catalog),
        `ATTACH ${quote(catalog.warehouse)} AS ${catalogAlias} (${[
          "TYPE iceberg",
          `ENDPOINT ${quote(catalog.uri)}`,
          ...(catalog.auth === undefined || catalog.auth._tag === "NoAuth"
            ? ["AUTHORIZATION_TYPE 'none'"]
            : ["SECRET export_catalog"]),
          ...(catalog.vendedCredentials === undefined
            ? []
            : [
                `ACCESS_DELEGATION_MODE ${catalog.vendedCredentials ? "'vended_credentials'" : "'none'"}`,
              ]),
          ...(catalog.compatibility?.stageCreateTables === false
            ? ["STAGE_CREATE_TABLES false"]
            : []),
          ...(catalog.compatibility?.multiTableCommit === false
            ? ["DISABLE_MULTI_TABLE_COMMIT true"]
            : []),
        ].join(", ")})`,
      ];
    case "S3Tables":
      return [
        `ATTACH ${quote(catalog.arn)} AS ${catalogAlias} (TYPE iceberg, ENDPOINT_TYPE s3_tables, STAGE_CREATE_TABLES false)`,
      ];
    case "Glue":
      return [
        `ATTACH ${quote(catalog.warehouse)} AS ${catalogAlias} (TYPE iceberg, ENDPOINT ${quote(`glue.${catalog.region}.amazonaws.com/iceberg`)}, AUTHORIZATION_TYPE 'sigv4')`,
      ];
    case "BigLake":
      return [
        `CREATE OR REPLACE SECRET export_catalog (TYPE iceberg, TOKEN ${catalog.token.pipe(Redacted.value, quote)}, EXTRA_HTTP_HEADERS MAP {'x-goog-user-project': ${quote(catalog.project)}})`,
        `ATTACH ${quote(catalog.warehouse)} AS ${catalogAlias} (TYPE iceberg, ENDPOINT 'https://biglake.googleapis.com/iceberg/v1/restcatalog', SECRET export_catalog)`,
      ];
  }
};

/** The script `layer` runs once on the database, before any connection is pooled (DuckDB's `init`): extensions, secrets, and the attached catalog. */
export const setupOf = (options: {
  readonly catalog: Catalog;
  readonly storage?: Storage | undefined;
}): string =>
  [
    "INSTALL iceberg",
    "LOAD iceberg",
    "INSTALL httpfs",
    "LOAD httpfs",
    ...(options.storage?._tag === "Adls" ? ["INSTALL azure", "LOAD azure"] : []),
    ...(options.storage === undefined ? [] : [storageSecret(options.storage)]),
    ...attach(options.catalog),
  ].join(";\n");

// ---------------------------------------------------------------- layers

/** What `Export.Iceberg.layer` attaches, and how DuckDB runs. */
export interface LayerOptions {
  /** The catalog: `Rest` (and `R2`), `Glue`, `S3Tables` or `BigLake`. */
  readonly catalog: Catalog;
  /** Where data files are read and written, when the catalog does not vend credentials. */
  readonly storage?: Storage | undefined;
  /**
   * DuckDB connections writing and reading.
   * @default 2
   */
  readonly connections?: number | undefined;
  /** DuckDB settings, e.g. `{ memory_limit: "2GB" }`; see `Export.DuckDb.layer`'s `config`. */
  readonly config?: Readonly<Record<string, string>> | undefined;
}

/** The catalog an `Export.Iceberg.layer` attached, for the store's upkeep beside DuckDB. */
export class AttachedCatalog extends Context.Service<AttachedCatalog, Catalog>()(
  "alchemy/Domain/Export/Iceberg/AttachedCatalog",
) {}

/**
 * DuckDB with the catalog attached: the `DuckDb` service (an engine), its
 * `SqlClient` (the store), and the catalog itself. The catalog is attached
 * once, for the database, before any connection is pooled.
 *
 * ### Attaching a REST catalog
 * **Example:** Lakekeeper over MinIO, with the storage's own keys
 * ```typescript
 * import * as Iceberg from "@alchemy.run/domain/Export/Iceberg";
 * import * as Redacted from "effect/Redacted";
 *
 * export const LakeCatalog = Iceberg.layer({
 *   catalog: new Iceberg.Rest({
 *     uri: "http://lakekeeper:8181/catalog",
 *     warehouse: "warehouse",
 *     vendedCredentials: false,
 *   }),
 *   storage: new Iceberg.S3({
 *     endpoint: "minio:9000",
 *     urlStyle: "path",
 *     useSsl: false,
 *     keyId: "admin",
 *     secret: Redacted.make(secretKey),
 *   }),
 * });
 * ```
 *
 * **Example:** Polaris behind OAuth2 client credentials
 * ```typescript
 * export const LakeCatalog = Iceberg.layer({
 *   catalog: new Iceberg.Rest({
 *     uri: "http://polaris:8181/api/catalog",
 *     warehouse: "warehouse",
 *     auth: new Iceberg.OAuth2({ clientId, clientSecret, scope: "PRINCIPAL_ROLE:ALL" }),
 *   }),
 * });
 * ```
 *
 * ### Attaching AWS Glue
 * **Example:** Glue's Iceberg endpoint, signed with the AWS credential chain
 * ```typescript
 * export const LakeCatalog = Iceberg.layer({
 *   catalog: new Iceberg.Glue({ warehouse: accountId, region: "us-east-1" }),
 *   storage: new Iceberg.S3({ region: "us-east-1" }),
 * });
 * ```
 *
 * @layer
 * @title Iceberg
 * @provides Export.DuckDb.DuckDb
 * @provides SqlClient
 * @provides Export.Iceberg.AttachedCatalog
 * @peer @duckdb/node-api
 */
export const layer = (
  options: LayerOptions,
): Layer.Layer<DuckDb.DuckDb | SqlClient | AttachedCatalog, QueryFailed> =>
  Layer.mergeAll(
    DuckDb.sqlClient.pipe(
      Layer.provideMerge(
        DuckDb.layer({
          init: setupOf(options),
          connections: options.connections ?? 2,
          config: options.config,
        }),
      ),
    ),
    Layer.succeed(AttachedCatalog, options.catalog),
  );

// ---------------------------------------------------------------- the courtesy view

/** Each logical type's Iceberg type in a view schema; values kept as text are `string`. */
const viewTypes: Record<Logical["_tag"], string> = {
  String: "string",
  Enum: "string",
  Int: "long",
  Float: "double",
  Decimal: "string",
  Bool: "boolean",
  Timestamp: "timestamptz",
  Date: "date",
  Bytes: "string",
  Json: "string",
  Array: "string",
};

/** The fields of a generation's table, in the order the store creates them. */
const viewFields = (spec: TableSpec) =>
  [
    { name: "_export_ord", type: "long" },
    ...[...spec.columns, ...spec.metadata].map((column) => ({
      name: columnName(column.path),
      type: viewTypes[column.type._tag],
    })),
    { name: "_export_identity", type: "string" },
    { name: "_export_json", type: "string" },
  ].map((field, index) => ({ id: index + 1, name: field.name, required: false, type: field.type }));

/** A catalog's client config: `defaults` overlaid by `overrides` (the REST spec's order). */
const ConfigResponse = Schema.Struct({
  defaults: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  endpoints: Schema.String.pipe(Schema.Array, Schema.optionalKey),
});
const TokenResponse = Schema.Struct({ access_token: Schema.String });
const ViewField = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  required: Schema.Boolean,
  type: Schema.String,
});
/** What a replace needs of a loaded view: its identity, schemas, versions and which is current. */
const LoadedView = Schema.Struct({
  metadata: Schema.Struct({
    "view-uuid": Schema.String,
    "current-version-id": Schema.Number,
    versions: Schema.Array(
      Schema.Struct({
        "version-id": Schema.Number,
        "schema-id": Schema.Number,
        "default-catalog": Schema.optionalKey(Schema.String),
        representations: Schema.Array(Schema.Struct({ sql: Schema.String })),
      }),
    ),
    schemas: Schema.Array(
      Schema.Struct({ "schema-id": Schema.Number, fields: Schema.Array(ViewField) }),
    ),
  }),
});

/** Whether two view schemas hold the same fields, as Iceberg compares them to reuse one. */
const sameFields = (
  a: ReadonlyArray<typeof ViewField.Type>,
  b: ReadonlyArray<typeof ViewField.Type>,
) =>
  a.length === b.length &&
  a.every(
    (field, i) =>
      field.id === b[i]!.id &&
      field.name === b[i]!.name &&
      field.required === b[i]!.required &&
      field.type === b[i]!.type,
  );

const createView = "POST /v1/{prefix}/namespaces/{namespace}/views";

/**
 * The view under a table's stable name, pointing at the generation engines
 * read, on a REST catalog that advertises views (`/v1/config`'s endpoints):
 * for people and tools querying by hand (Trino, Spark). A promotion moves it
 * in one commit (a new version made current, asserting the view's identity),
 * so a reader never finds it missing. Engines do not depend on it; a failure
 * is logged. The view's SQL names its generation by namespace; the catalog
 * is `viewCatalog`, the name readers give this catalog, where one is given.
 * Trino reads a view only with it; Spark resolves a view without it in its
 * own catalog.
 */
const viewUpkeep = (catalog: Rest, namespace: string, viewCatalog: string | undefined) =>
  Effect.gen(function* () {
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const base = catalog.uri.replace(/\/$/, "");
    const auth = catalog.auth;
    // One client-credentials token serves every view call for a while, well inside the hour a
    // catalog's token usually lasts; then the next call asks for a fresh one.
    const token: Effect.Effect<Option.Option<string>, unknown> = auth === undefined ||
    auth._tag === "NoAuth"
      ? Effect.succeedNone
      : auth._tag === "Bearer"
        ? auth.token.pipe(Redacted.value, Effect.succeedSome)
        : yield* Effect.cachedWithTTL(
            http
              .execute(
                HttpClientRequest.post(tokenEndpointOf(catalog, auth)).pipe(
                  HttpClientRequest.bodyUrlParams({
                    grant_type: "client_credentials",
                    client_id: auth.clientId,
                    client_secret: Redacted.value(auth.clientSecret),
                    ...(auth.scope === undefined ? {} : { scope: auth.scope }),
                  }),
                ),
              )
              .pipe(
                Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenResponse)),
                Effect.map((response) => Option.some(response.access_token)),
              ),
            "5 minutes",
          );
    const authorized = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.map(
        token,
        Option.match({
          onNone: () => request,
          onSome: (value) => HttpClientRequest.bearerToken(request, value),
        }),
      );
    const config = yield* authorized(
      HttpClientRequest.get(`${base}/v1/config`).pipe(
        HttpClientRequest.setUrlParam("warehouse", catalog.warehouse),
      ),
    ).pipe(
      Effect.flatMap(http.execute),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ConfigResponse)),
    );
    const supported = config.endpoints?.includes(createView) ?? false;
    // The path segment as the catalog gives it (Nessie's is already encoded: `main%7Cwarehouse`).
    const prefix = config.overrides?.["prefix"] ?? config.defaults?.["prefix"];
    const views = `${base}/v1/${prefix === undefined ? "" : `${prefix}/`}namespaces/${encodeURIComponent(namespace)}/views`;
    return {
      supported,
      /** Point `spec`'s stable name at `generation`: when absent only, or always (a promotion). */
      point: (spec: TableSpec, generation: string, replace: boolean) =>
        Effect.gen(function* () {
          const url = `${views}/${encodeURIComponent(spec.name)}`;
          const loaded = yield* authorized(HttpClientRequest.get(url)).pipe(
            Effect.flatMap(http.execute),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(LoadedView)),
            Effect.option,
          );
          if (Option.isSome(loaded) && !replace) return;
          const now = yield* Clock.currentTimeMillis;
          const fields = viewFields(spec);
          const version = (versionId: number, schemaId: number) => ({
            "version-id": versionId,
            "timestamp-ms": now,
            "schema-id": schemaId,
            summary: { "engine-name": "alchemy-domain-export" },
            "default-namespace": [namespace],
            ...(viewCatalog === undefined ? {} : { "default-catalog": viewCatalog }),
            representations: ["trino", "spark"].map((dialect) => ({
              type: "sql",
              sql: `SELECT * FROM ${namespace}.${generation}`,
              dialect,
            })),
          });
          if (Option.isNone(loaded)) {
            yield* authorized(
              HttpClientRequest.post(views).pipe(
                HttpClientRequest.bodyJsonUnsafe({
                  name: spec.name,
                  schema: { type: "struct", "schema-id": 0, fields },
                  "view-version": version(1, 0),
                  properties: {},
                }),
              ),
            ).pipe(Effect.flatMap(http.execute));
            return;
          }
          const metadata = loaded.value.metadata;
          const select = `SELECT * FROM ${namespace}.${generation}`;
          // Iceberg keeps one copy of a schema: an identical one is referred to by its id, not added.
          const existing = metadata.schemas.find((schema) => sameFields(schema.fields, fields));
          // And one copy of a version (its time aside): a promotion back reuses the earlier one.
          const same =
            existing === undefined
              ? undefined
              : metadata.versions.find(
                  (v) =>
                    v["schema-id"] === existing["schema-id"] &&
                    v["default-catalog"] === viewCatalog &&
                    v.representations.length > 0 &&
                    v.representations.every((r) => r.sql === select),
                );
          if (same !== undefined && same["version-id"] === metadata["current-version-id"]) return;
          const schemaId =
            existing?.["schema-id"] ?? Math.max(...metadata.schemas.map((s) => s["schema-id"])) + 1;
          const versionId =
            same?.["version-id"] ?? Math.max(...metadata.versions.map((v) => v["version-id"])) + 1;
          yield* authorized(
            HttpClientRequest.post(url).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                requirements: [{ type: "assert-view-uuid", uuid: metadata["view-uuid"] }],
                updates: [
                  ...(existing === undefined
                    ? [
                        {
                          action: "add-schema",
                          schema: { type: "struct", "schema-id": schemaId, fields },
                          "last-column-id": fields.length,
                        },
                      ]
                    : []),
                  ...(same === undefined
                    ? [{ action: "add-view-version", "view-version": version(versionId, schemaId) }]
                    : []),
                  { action: "set-current-view-version", "view-version-id": versionId },
                ],
              }),
            ),
          ).pipe(Effect.flatMap(http.execute));
        }),
    };
  });

// ---------------------------------------------------------------- the store

/** Where `Export.Iceberg.store` keeps its tables. */
export interface StoreOptions {
  /**
   * The catalog namespace the tables live in, created when first needed.
   * @default "export"
   */
  readonly namespace?: string;
  /**
   * The store's name in its errors.
   * @default "iceberg"
   */
  readonly name?: string;
  /**
   * The name readers give this catalog (Trino's catalog file name, Spark's
   * `spark.sql.catalog.<name>`): the default catalog of each view the store
   * keeps, which Trino needs to read it. Unset, a view resolves in each
   * reader's own catalog, which Spark does and Trino refuses.
   */
  readonly viewCatalog?: string | undefined;
}

/**
 * The store on the catalog `Export.Iceberg.layer` attached. Tables live in
 * `namespace`, created when first needed. On a REST catalog that advertises
 * views, a view under each table's stable name follows its promoted
 * generation, for people and tools querying by hand; engines read the
 * promoted generation by its full name (`names`) and do not depend on it.
 *
 * ### Exporting to a lake
 * **Example:** A store on the attached catalog
 * ```typescript
 * import * as Iceberg from "@alchemy.run/domain/Export/Iceberg";
 * import * as FetchHttpClient from "effect/http/FetchHttpClient";
 * import * as Layer from "effect/Layer";
 *
 * export const LakeLive = Lake.toLayer(Iceberg.store({ namespace: "facts", viewCatalog: "lake" })).pipe(
 *   Layer.provide(LakeCatalog),
 *   Layer.provide(FetchHttpClient.layer),
 * );
 * ```
 *
 * ### Querying the lake
 * **Example:** DuckDB over the same catalog, reading promoted generations
 * ```typescript
 * import * as DuckDb from "@alchemy.run/domain/Export/DuckDb";
 * import * as Effect from "effect/Effect";
 *
 * export const AnalyticsLive = Analytics.toLayer(
 *   Effect.flatMap(Iceberg.names(Lake), (name) => DuckDb.engine({ name })),
 * ).pipe(Layer.provideMerge(LakeLive));
 * ```
 *
 * @layer
 * @provides Export.Store.Implementation
 * @peer @duckdb/node-api
 */
export const store = (
  options: StoreOptions = {},
): Effect.Effect<
  Store.Implementation,
  Store.Unavailable,
  SqlClient | AttachedCatalog | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const namespace = options.namespace ?? "export";
    const inner = yield* sqlStore({
      name: options.name ?? "iceberg",
      iceberg: { catalog: catalogAlias, namespace },
    });
    const catalog = yield* AttachedCatalog;
    const stableName = inner.stableName;
    if (catalog._tag !== "Rest" || stableName === undefined) return inner;
    const upkeep = yield* viewUpkeep(catalog, namespace, options.viewCatalog).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Export.Iceberg: the catalog's views are not kept", cause),
      ),
      Effect.option,
    );
    if (Option.isNone(upkeep) || !upkeep.value.supported) return inner;
    const views = upkeep.value;
    /** Point the view at what engines read now; a failure is logged, the write stands. */
    const follow = (spec: TableSpec, replace: boolean) =>
      stableName(spec).pipe(
        Effect.flatMap((qualified) =>
          views.point(spec, qualified.split(".").at(-1) ?? generationName(spec), replace),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning(`Export.Iceberg: view ${spec.name} not updated`, cause),
        ),
      );
    return {
      ...inner,
      target: (spec) => {
        const target = inner.target(spec);
        return {
          ...target,
          ensure: (spec) => Effect.tap(target.ensure(spec), () => follow(spec, false)),
          promote: (spec) => Effect.tap(target.promote(spec), () => follow(spec, true)),
        };
      },
    } satisfies Store.Implementation;
  });

/**
 * An engine's table names for a store that keeps no view: each query reads
 * the generation the store has promoted, by its full name. For any engine
 * reading the same catalog: DuckDB attached as `lake`, or Trino and Spark,
 * given `catalog`, the name their catalog has.
 */
export const names = <Id>(
  declaration: { readonly Store: Context.Key<Id, Store.Implementation> },
  options: { readonly catalog?: string | undefined } = {},
): Effect.Effect<NonNullable<Engine.Implementation["name"]>, never, Id> =>
  Effect.map(declaration.Store, (built) => ({ spec }) => {
    const stable = built.stableName;
    if (stable === undefined) return spec.name;
    return stable(spec).pipe(
      Effect.map((name) =>
        options.catalog === undefined
          ? name
          : `${options.catalog}.${name.split(".").slice(1).join(".")}`,
      ),
      Effect.mapError(
        (cause) =>
          new QueryFailed({
            reason: new EngineUnavailable({ code: cause._tag }),
            detail: cause.message,
            cause,
          }),
      ),
    );
  });
