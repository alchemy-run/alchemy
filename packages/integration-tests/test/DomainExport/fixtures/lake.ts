/**
 * An Iceberg lake for a test file, deployed as Alchemy Docker resources on a
 * scratch stack: a network, MinIO holding the `warehouse` bucket, and one
 * Iceberg REST catalog over it. Inside the network every container reaches
 * the others by alias (`minio`, `catalog`); from the host, by the ports
 * Docker bound. Each Java server runs under a CPU and memory ceiling.
 *
 * Every catalog runs client-managed storage: DuckDB on the host reads and
 * writes MinIO with its own keys. Vended credentials would carry the
 * endpoint MinIO has inside the network, which the host cannot reach.
 */
import * as Docker from "@alchemy.run/docker";
import * as Iceberg from "@alchemy.run/domain/Export/Iceberg";
import type { Input } from "alchemy/Input";
import type { Output } from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import {
  call,
  type Request,
  send,
  decodeJson,
  deployed,
  fixtureStack,
  publish,
  type DockerStack,
  type Published,
  httpOk,
  images,
  json,
  waitFor,
} from "./docker.ts";

/** The catalogs a lake can run. */
export type CatalogKind = "rest-fixture" | "lakekeeper" | "polaris" | "nessie" | "gravitino";

/** A running catalog, as Export and other clients reach it. */
export interface LakeCatalog {
  readonly kind: CatalogKind;
  /** The Iceberg REST base URI: from the host, and from a container on the network. */
  readonly host: string;
  readonly internal: string;
  readonly warehouse: string;
  readonly auth?: Iceberg.Auth | undefined;
}

/** Credentials and addresses of a running lake, from the host and from inside its network. */
export interface Lake {
  /** The Docker network every container of the lake joins. */
  readonly network: string;
  readonly catalog: LakeCatalog;
  /** MinIO's S3 endpoint: from the host (`host:port`), and from a container (`http://…`). */
  readonly s3: { readonly host: string; readonly internal: string };
  readonly accessKey: "admin";
  readonly secretKey: "password";
}

const minioInternal = "http://minio:9000";

/** Where a catalog listens inside its container, and the REST path under it. */
interface CatalogShape {
  readonly port: number;
  readonly path: string;
  readonly warehouse: string;
  readonly auth?: Iceberg.Auth;
}

const shapes: Record<CatalogKind, CatalogShape> = {
  "rest-fixture": { port: 8181, path: "", warehouse: "" },
  lakekeeper: { port: 8181, path: "/catalog", warehouse: "warehouse" },
  polaris: {
    port: 8181,
    path: "/api/catalog",
    warehouse: "warehouse",
    auth: new Iceberg.OAuth2({
      clientId: "root",
      clientSecret: Redacted.make("s3cr3t"),
      scope: "PRINCIPAL_ROLE:ALL",
    }),
  },
  nessie: { port: 19120, path: "/iceberg", warehouse: "warehouse" },
  gravitino: { port: 9001, path: "/iceberg", warehouse: "" },
};

/** A Java server's ceiling: one at a time on a developer machine stays usable. */
const jvm = { cpus: 1, memory: "1g" } as const;

const on = (network: Output<string>, ...aliases: Array<string>) => [{ name: network, aliases }];

/** The catalog's containers, joined to `network`; the one serving REST is aliased `catalog`. */
const catalogContainers = (kind: CatalogKind, network: Output<string>, published: Published) => {
  const serving = (image: string, environment: Record<string, string>, command?: Array<string>) =>
    Docker.Container("Catalog", {
      image,
      ...(command === undefined ? {} : { command }),
      environment,
      ports: [published.mapping],
      networks: on(network, "catalog"),
      start: true,
      ...jvm,
    });
  switch (kind) {
    case "rest-fixture":
      return serving(images.icebergRestFixture, {
        CATALOG_WAREHOUSE: "s3://warehouse/",
        CATALOG_IO__IMPL: "org.apache.iceberg.aws.s3.S3FileIO",
        CATALOG_S3_ENDPOINT: minioInternal,
        CATALOG_S3_PATH__STYLE__ACCESS: "true",
        AWS_ACCESS_KEY_ID: "admin",
        AWS_SECRET_ACCESS_KEY: "password",
        AWS_REGION: "us-east-1",
      });
    case "lakekeeper":
      return Effect.gen(function* () {
        yield* Docker.Container("CatalogDb", {
          image: images.postgres,
          environment: { POSTGRES_PASSWORD: "postgres" },
          networks: on(network, "catalog-db"),
          start: true,
          memory: "512m",
        });
        const settings = {
          LAKEKEEPER__PG_ENCRYPTION_KEY: "alchemy-test-export-not-secret",
          LAKEKEEPER__PG_DATABASE_URL_READ:
            "postgresql://postgres:postgres@catalog-db:5432/postgres",
          LAKEKEEPER__PG_DATABASE_URL_WRITE:
            "postgresql://postgres:postgres@catalog-db:5432/postgres",
        };
        // Both restart until Postgres answers: the migration, then the server once migrated.
        yield* Docker.Container("CatalogMigrate", {
          image: images.lakekeeper,
          command: ["migrate"],
          environment: settings,
          networks: on(network),
          restart: "on-failure",
          start: true,
        });
        return yield* Docker.Container("Catalog", {
          image: images.lakekeeper,
          command: ["serve"],
          environment: settings,
          ports: [published.mapping],
          networks: on(network, "catalog"),
          restart: "on-failure",
          start: true,
          ...jvm,
        });
      });
    case "polaris":
      return serving(images.polaris, {
        POLARIS_BOOTSTRAP_CREDENTIALS: "POLARIS,root,s3cr3t",
        "polaris.realm-context.realms": "POLARIS",
        "quarkus.otel.sdk.disabled": "true",
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "admin",
        AWS_SECRET_ACCESS_KEY: "password",
      });
    case "nessie":
      return serving(images.nessie, {
        "nessie.version.store.type": "IN_MEMORY",
        "nessie.catalog.default-warehouse": "warehouse",
        "nessie.catalog.warehouses.warehouse.location": "s3://warehouse/nessie",
        "nessie.catalog.service.s3.default-options.endpoint": `${minioInternal}/`,
        "nessie.catalog.service.s3.default-options.path-style-access": "true",
        "nessie.catalog.service.s3.default-options.region": "us-east-1",
        "nessie.catalog.service.s3.default-options.access-key":
          "urn:nessie-secret:quarkus:minio-keys",
        "minio-keys.name": "admin",
        "minio-keys.secret": "password",
      });
    case "gravitino":
      return serving(images.gravitino, {
        GRAVITINO_ICEBERG_REST_CATALOG_BACKEND: "memory",
        GRAVITINO_ICEBERG_REST_WAREHOUSE: "s3://warehouse/gravitino",
        GRAVITINO_ICEBERG_REST_IO_IMPL: "org.apache.iceberg.aws.s3.S3FileIO",
        GRAVITINO_ICEBERG_REST_S3_ACCESS_KEY: "admin",
        GRAVITINO_ICEBERG_REST_S3_SECRET_KEY: "password",
        GRAVITINO_ICEBERG_REST_S3_ENDPOINT: minioInternal,
        GRAVITINO_ICEBERG_REST_S3_REGION: "us-east-1",
        GRAVITINO_ICEBERG_REST_S3_PATH_STYLE_ACCESS: "true",
      });
  }
};

/**
 * Wait until the catalog answers, then do what it needs first, from the
 * host: Lakekeeper's warehouse, Polaris's catalog and grants.
 */
const bootstrap = (kind: CatalogKind, server: string, rest: string) =>
  Effect.gen(function* () {
    switch (kind) {
      case "lakekeeper": {
        yield* waitFor("Lakekeeper", httpOk(`${server}/health`));
        yield* call(
          `${server}/management/v1/bootstrap`,
          json("POST", { "accept-terms-of-use": true }),
        );
        yield* call(
          `${server}/management/v1/warehouse`,
          json("POST", {
            "warehouse-name": "warehouse",
            "storage-profile": {
              type: "s3",
              bucket: "warehouse",
              "key-prefix": "lakekeeper",
              region: "us-east-1",
              endpoint: minioInternal,
              "path-style-access": true,
              flavor: "s3-compat",
              "sts-enabled": false,
              "remote-signing-enabled": false,
            },
            "storage-credential": {
              type: "s3",
              "credential-type": "access-key",
              "aws-access-key-id": "admin",
              "aws-secret-access-key": "password",
            },
          }),
        );
        return;
      }
      case "polaris": {
        const tokenRequest: Request = {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "grant_type=client_credentials&client_id=root&client_secret=s3cr3t&scope=PRINCIPAL_ROLE:ALL",
        };
        yield* waitFor("Polaris", httpOk(`${server}/api/catalog/v1/oauth/tokens`, tokenRequest));
        const { access_token: token } = yield* call(
          `${server}/api/catalog/v1/oauth/tokens`,
          tokenRequest,
        ).pipe(Effect.flatMap(decodeJson(Schema.Struct({ access_token: Schema.String }))));
        const management = `${server}/api/management/v1`;
        yield* call(
          `${management}/catalogs`,
          json(
            "POST",
            {
              catalog: {
                name: "warehouse",
                type: "INTERNAL",
                properties: { "default-base-location": "s3://warehouse/polaris" },
                storageConfigInfo: {
                  storageType: "S3",
                  allowedLocations: ["s3://warehouse/polaris"],
                  endpoint: minioInternal,
                  pathStyleAccess: true,
                  stsUnavailable: true,
                  region: "us-east-1",
                },
              },
            },
            token,
          ),
        );
        yield* call(
          `${management}/catalogs/warehouse/catalog-roles/catalog_admin/grants`,
          json("PUT", { grant: { type: "catalog", privilege: "CATALOG_MANAGE_CONTENT" } }, token),
        );
        yield* call(
          `${management}/principal-roles/service_admin/catalog-roles/warehouse`,
          json("PUT", { catalogRole: { name: "catalog_admin" } }, token),
        );
        return;
      }
      default:
        yield* waitFor(`the ${kind} catalog`, httpOk(`${rest}/v1/config`));
        return;
    }
  });

export interface LakeOptions<Extra> {
  /** The stack's name, unique within the file. */
  readonly label: string;
  /** The test file (`import.meta.url`), which namespaces the stack's durable state. */
  readonly file: string;
  readonly catalog?: CatalogKind;
  /** More containers on the lake's network, deployed with it: they get the network's name. */
  readonly extra?: (network: Output<string>) => Effect.Effect<Extra, never, DockerStack>;
}

/**
 * Deploy the lake (and `extra`) for the rest of the scope, wait until MinIO
 * holds the bucket and the catalog answers, and bootstrap the catalog.
 */
export const startLake = <Extra = undefined>({
  label,
  file,
  catalog: kind = "rest-fixture",
  extra,
}: LakeOptions<Extra>): Effect.Effect<
  { lake: Lake; extra: Input.Resolve<Extra> },
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const shape = shapes[kind];
    const minioPort = yield* publish(9000);
    const catalogPort = yield* publish(shape.port);
    const outputs = yield* deployed(
      fixtureStack(label, file),
      Effect.gen(function* () {
        const network = yield* Docker.Network("Lake", {});
        const minio = yield* Docker.Container("Minio", {
          image: images.minio,
          command: ["server", "/data"],
          environment: { MINIO_ROOT_USER: "admin", MINIO_ROOT_PASSWORD: "password" },
          ports: [minioPort.mapping],
          networks: on(network.name, "minio"),
          // The check also makes the bucket, idempotently: healthy means the warehouse exists.
          healthcheck: {
            cmd: "mc alias set m http://127.0.0.1:9000 admin password >/dev/null && mc mb --ignore-existing m/warehouse",
            interval: "1 second",
            retries: 120,
          },
          start: true,
          memory: "512m",
        });
        yield* catalogContainers(kind, network.name, catalogPort);
        return {
          network: network.name,
          extra: extra === undefined ? undefined : yield* extra(network.name),
        };
      }),
    );
    const s3Host = `127.0.0.1:${minioPort.port}`;
    // Anonymous: an existing bucket refuses (403), a missing one is not found (404).
    yield* waitFor(
      "the warehouse bucket",
      send(`http://${s3Host}/warehouse`).pipe(
        Effect.as(false),
        Effect.catchTag("RequestFailed", (failed) => Effect.succeed(failed.status === 403)),
        Effect.orElseSucceed(() => false),
      ),
    );
    const server = `http://127.0.0.1:${catalogPort.port}`;
    const host = `${server}${shape.path}`;
    yield* bootstrap(kind, server, host);
    const lake: Lake = {
      network: outputs.network,
      catalog: {
        kind,
        host,
        internal: `http://catalog:${shape.port}${shape.path}`,
        warehouse: shape.warehouse,
        auth: shape.auth,
      },
      s3: { host: s3Host, internal: minioInternal },
      accessKey: "admin",
      secretKey: "password",
    };
    // A cast: the deploy resolves `extra`'s outputs as declared; its result type is not inferred through `deployed`.
    return { lake, extra: outputs.extra as Input.Resolve<Extra> };
  });

/** The Export side of a lake: DuckDB with its catalog attached, and an HTTP client for the catalog's views. */
export const exportLayer = (lake: Lake) =>
  Layer.merge(
    Layer.orDie(
      Iceberg.layer({
        catalog: new Iceberg.Rest({
          uri: lake.catalog.host,
          warehouse: lake.catalog.warehouse,
          auth: lake.catalog.auth,
          // The host's own MinIO keys and address, whatever storage settings the catalog returns.
          vendedCredentials: false,
        }),
        storage: new Iceberg.S3({
          endpoint: lake.s3.host,
          region: "us-east-1",
          urlStyle: "path",
          useSsl: false,
          keyId: lake.accessKey,
          secret: Redacted.make(lake.secretKey),
        }),
      }),
    ),
    FetchHttpClient.layer,
  );

/** Trino's Iceberg connector over the lake's REST catalog, as `iceberg.properties`. */
export const trinoIcebergCatalog = (lake: Lake) =>
  [
    "connector.name=iceberg",
    "iceberg.catalog.type=rest",
    `iceberg.rest-catalog.uri=${lake.catalog.internal}`,
    ...(lake.catalog.warehouse === ""
      ? []
      : [`iceberg.rest-catalog.warehouse=${lake.catalog.warehouse}`]),
    "fs.native-s3.enabled=true",
    `s3.endpoint=${lake.s3.internal}`,
    "s3.region=us-east-1",
    "s3.path-style-access=true",
    `s3.aws-access-key=${lake.accessKey}`,
    `s3.aws-secret-key=${lake.secretKey}`,
  ].join("\n");
