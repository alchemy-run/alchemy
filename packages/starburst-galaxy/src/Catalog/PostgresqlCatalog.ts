import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type {
  CreatePostgresqlCatalogRequest,
  PostgresqlCatalog as PostgresqlCatalogShape,
  UpdatePostgresqlCatalogRequest,
} from "@distilled.cloud/starburst-galaxy/catalog";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { changedFields, hasChanges } from "../internal.ts";
import type { Providers } from "../Providers.ts";
import {
  type CatalogBaseAttributes,
  type CatalogBaseProps,
  type CatalogLookup,
  catalogLifecycle,
  type CloudKind,
  secretValue,
} from "./CatalogKind.ts";

export interface PostgresqlCatalogProps extends CatalogBaseProps {
  /**
   * Host name of the PostgreSQL server. Galaxy connects from its own cloud
   * region, so the server must be reachable from the internet, through
   * `sshTunnelId`, or through `privateLinkId` (which replaces `endpoint`).
   */
  readonly endpoint?: string;
  /**
   * Port of the PostgreSQL server.
   * @default 5432
   */
  readonly port?: number;
  /** Database Galaxy exposes as the catalog's schemas and tables. */
  readonly databaseName: string;
  /** PostgreSQL user Galaxy connects as. Its grants bound what the catalog can read and write. */
  readonly username: string;
  /**
   * Password of `username`. Galaxy never returns it: a change is detected
   * by comparing the new value with the deployed one, and is sent on the
   * next deploy.
   */
  readonly password: Redacted.Redacted<string>;
  /**
   * Connect over TLS.
   * @default true
   */
  readonly tlsEnabled?: boolean;
  /**
   * Cloud the PostgreSQL server runs in, for Galaxy's network routing.
   * @default "AWS"
   */
  readonly cloudKind?: CloudKind;
  /** ID of a Galaxy SSH tunnel to reach a private server through. */
  readonly sshTunnelId?: string;
  /** ID of a Galaxy PrivateLink connection to reach the server through. */
  readonly privateLinkId?: string;
}

export interface PostgresqlCatalogAttributes extends CatalogBaseAttributes {
  /** Cloud the server runs in, as Galaxy reports it. */
  readonly cloudKind: CloudKind | undefined;
  /** Host name Galaxy connects to. */
  readonly endpoint: string | undefined;
  /** Port Galaxy connects to. */
  readonly port: number | undefined;
  /** Database exposed by the catalog. */
  readonly databaseName: string;
  /** PostgreSQL user Galaxy connects as. */
  readonly username: string;
  /** Whether Galaxy connects over TLS. */
  readonly tlsEnabled: boolean | undefined;
  /** SSH tunnel Galaxy connects through, if any. */
  readonly sshTunnelId: string | undefined;
  /** PrivateLink connection Galaxy connects through, if any. */
  readonly privateLinkId: string | undefined;
}

export type PostgresqlCatalog = Resource<
  "StarburstGalaxy.PostgresqlCatalog",
  PostgresqlCatalogProps,
  PostgresqlCatalogAttributes,
  never,
  Providers,
  CatalogLookup
>;

/**
 * A Starburst Galaxy catalog over a PostgreSQL database: its schemas and
 * tables become `<catalog>.<schema>.<table>` in SQL on every cluster the
 * catalog is attached to.
 *
 * Every setting, the name included, updates in place. Galaxy never returns
 * the password, so a rotated password is detected by comparing the
 * deployed value with the new one. Galaxy checks the connection on every
 * create and update; set `validate: false` to store a catalog whose server
 * is not reachable yet.
 *
 * Catalogs have no labels or tags in Galaxy: a catalog Alchemy created is
 * recognized by its generated name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/working-with-data/create-catalogs/postgresql.html
 *
 * ### Creating a catalog
 * **Example:** A catalog over a Neon project, attached to a cluster
 * ```typescript
 * const project = yield* Neon.Project("app");
 * const pg = yield* StarburstGalaxy.PostgresqlCatalog("App", {
 *   endpoint: project.origin.host,
 *   databaseName: project.origin.database,
 *   username: project.origin.user,
 *   password: project.origin.password,
 * });
 * yield* StarburstGalaxy.Cluster("Analytics", {
 *   cloudRegionId: "aws-us-east1",
 *   catalogs: [pg.catalogId],
 * });
 * ```
 *
 * **Example:** A read-only catalog with an explicit name
 * ```typescript
 * const password = yield* Config.Redacted("ORDERS_READER_PASSWORD");
 * const pg = yield* StarburstGalaxy.PostgresqlCatalog("Orders", {
 *   name: "orders",
 *   description: "Orders replica",
 *   readOnly: true,
 *   endpoint: "orders.example.com",
 *   databaseName: "orders",
 *   username: "galaxy_reader",
 *   password,
 * });
 * ```
 *
 * ### Rotating the password
 * **Example:** A new password value is a change the next deploy sends to Galaxy
 * ```typescript
 * const password = yield* Config.Redacted("ORDERS_READER_PASSWORD_V2");
 * yield* StarburstGalaxy.PostgresqlCatalog("Orders", {
 *   endpoint: "orders.example.com",
 *   databaseName: "orders",
 *   username: "galaxy_reader",
 *   password,
 * });
 * ```
 *
 * ### Storing a catalog without checking it
 * **Example:** Skip Galaxy's connection check
 * ```typescript
 * yield* StarburstGalaxy.PostgresqlCatalog("Later", {
 *   endpoint: "db.internal.example.com",
 *   databaseName: "app",
 *   username: "galaxy",
 *   password: Redacted.make("not-yet-reachable"),
 *   validate: false,
 * });
 * ```
 *
 * ### Looking up an existing catalog
 * **Example:** Reference a catalog created in the Galaxy console
 * ```typescript
 * const sales = StarburstGalaxy.PostgresqlCatalog.lookup({ name: "sales" });
 * ```
 *
 * @resource
 * @product Catalogs
 */
export const PostgresqlCatalog = Resource<PostgresqlCatalog>("StarburstGalaxy.PostgresqlCatalog");

const toAttributes = (shape: PostgresqlCatalogShape): PostgresqlCatalogAttributes => ({
  catalogId: shape.catalogId,
  name: shape.name,
  description: shape.description,
  readOnly: shape.readOnly,
  cloudKind: shape.cloudKind,
  endpoint: shape.endpoint,
  port: shape.port,
  databaseName: shape.databaseName,
  username: shape.username,
  tlsEnabled: shape.tlsEnabled,
  sshTunnelId: shape.sshTunnelId,
  privateLinkId: shape.privateLinkId,
});

/** The non-secret settings, as Galaxy names them. */
const settingsOf = (name: string, props: PostgresqlCatalogProps) => ({
  name,
  description: props.description ?? "",
  readOnly: props.readOnly ?? false,
  cloudKind: props.cloudKind,
  endpoint: props.endpoint,
  port: props.port,
  databaseName: props.databaseName,
  username: props.username,
  tlsEnabled: props.tlsEnabled,
  sshTunnelId: props.sshTunnelId,
  privateLinkId: props.privateLinkId,
});

export const PostgresqlCatalogProvider = () =>
  Provider.succeed(
    PostgresqlCatalog,
    catalogLifecycle({
      kind: "PostgreSQL",
      get: (catalogId) =>
        galaxy.catalog
          .getPostgresqlCatalog({ catalogId })
          .pipe(Effect.catchTag("NotFound", () => Effect.undefined)),
      create: (request: CreatePostgresqlCatalogRequest) =>
        galaxy.catalog
          .createPostgresqlCatalog(request)
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined)),
      update: (catalogId, patch: Omit<UpdatePostgresqlCatalogRequest, "catalogId">) =>
        galaxy.catalog.updatePostgresqlCatalog({ ...patch, catalogId }),
      validate: (catalogId) => galaxy.catalog.validatePostgresqlCatalog({ catalogId }),
      delete: (catalogId) =>
        galaxy.catalog.deletePostgresqlCatalog({ catalogId }).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        ),
      list: galaxy.catalog.listPostgresqlCatalogs.items({}),
      toCreate: (name, props) => ({
        ...settingsOf(name, props),
        password: props.password,
        validate: props.validate ?? true,
      }),
      toPatch: (name, props, observed, withSecrets) => {
        const delta = changedFields(
          { ...observed, description: observed.description ?? "" },
          settingsOf(name, props),
        );
        if (!hasChanges(delta) && !withSecrets) return undefined;
        return {
          ...delta,
          ...(withSecrets ? { password: props.password } : {}),
          validate: props.validate ?? true,
        };
      },
      toAttributes,
      secretsChanged: (olds, news) => secretValue(olds.password) !== secretValue(news.password),
    }),
  );
