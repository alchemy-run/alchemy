import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type {
  CreateSqlServerCatalogRequest,
  SqlServerCatalog as SqlServerCatalogShape,
  UpdateSqlServerCatalogRequest,
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

export interface SqlServerCatalogProps extends CatalogBaseProps {
  /**
   * Host name of the SQL Server. Galaxy connects from its own cloud region,
   * so the server must be reachable from the internet, through
   * `sshTunnelId`, or through `privateLinkId` (which replaces `endpoint`).
   */
  readonly endpoint?: string;
  /**
   * Port of the SQL Server.
   * @default 1433
   */
  readonly port?: number;
  /** Database Galaxy exposes as the catalog's schemas and tables. */
  readonly databaseName: string;
  /** SQL Server login Galaxy connects as. Its grants bound what the catalog can read and write. */
  readonly username: string;
  /**
   * Password of `username`. Galaxy never returns it: a change is detected
   * by comparing the new value with the deployed one.
   */
  readonly password: Redacted.Redacted<string>;
  /**
   * Cloud the server runs in, for Galaxy's network routing.
   * @default "AWS"
   */
  readonly cloudKind?: CloudKind;
  /** ID of a Galaxy SSH tunnel to reach a private server through. */
  readonly sshTunnelId?: string;
  /** ID of a Galaxy PrivateLink connection to reach the server through. */
  readonly privateLinkId?: string;
}

export interface SqlServerCatalogAttributes extends CatalogBaseAttributes {
  /** Cloud the server runs in, as Galaxy reports it. */
  readonly cloudKind: CloudKind | undefined;
  /** Host name Galaxy connects to. */
  readonly endpoint: string | undefined;
  /** Port Galaxy connects to. */
  readonly port: number | undefined;
  /** Database exposed by the catalog. */
  readonly databaseName: string;
  /** Login Galaxy connects as. */
  readonly username: string;
  /** SSH tunnel Galaxy connects through, if any. */
  readonly sshTunnelId: string | undefined;
  /** PrivateLink connection Galaxy connects through, if any. */
  readonly privateLinkId: string | undefined;
}

export type SqlServerCatalog = Resource<
  "StarburstGalaxy.SqlServerCatalog",
  SqlServerCatalogProps,
  SqlServerCatalogAttributes,
  never,
  Providers,
  CatalogLookup
>;

/**
 * A Starburst Galaxy catalog over a Microsoft SQL Server database (on
 * premises, Azure SQL or Amazon RDS): its schemas and tables become
 * `<catalog>.<schema>.<table>` on every cluster the catalog is attached to.
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
 * @see https://docs.starburst.io/starburst-galaxy/working-with-data/create-catalogs/non-object-storage/sqlserver.html
 *
 * ### Creating a catalog
 * **Example:** A catalog over an Azure SQL database
 * ```typescript
 * const password = yield* Config.Redacted("ERP_SQL_PASSWORD");
 * const erp = yield* StarburstGalaxy.SqlServerCatalog("Erp", {
 *   endpoint: "erp.database.windows.net",
 *   databaseName: "erp",
 *   username: "galaxy",
 *   password,
 *   cloudKind: "AZURE",
 * });
 * yield* StarburstGalaxy.Cluster("Analytics", {
 *   cloudRegionId: "azure-us-east2",
 *   catalogs: [erp.catalogId],
 * });
 * ```
 *
 * ### Looking up an existing catalog
 * **Example:** Reference a catalog created in the Galaxy console
 * ```typescript
 * const erp = StarburstGalaxy.SqlServerCatalog.lookup({ name: "erp" });
 * ```
 *
 * @resource
 * @product Catalogs
 */
export const SqlServerCatalog = Resource<SqlServerCatalog>("StarburstGalaxy.SqlServerCatalog");

/** The non-secret settings, as Galaxy names them. */
const settingsOf = (name: string, props: SqlServerCatalogProps) => ({
  name,
  description: props.description ?? "",
  readOnly: props.readOnly ?? false,
  cloudKind: props.cloudKind,
  endpoint: props.endpoint,
  port: props.port,
  databaseName: props.databaseName,
  username: props.username,
  sshTunnelId: props.sshTunnelId,
  privateLinkId: props.privateLinkId,
});

export const SqlServerCatalogProvider = () =>
  Provider.succeed(
    SqlServerCatalog,
    catalogLifecycle({
      kind: "SQL Server",
      get: (catalogId) =>
        galaxy.catalog
          .getSqlServerCatalog({ catalogId })
          .pipe(Effect.catchTag("NotFound", () => Effect.undefined)),
      create: (request: CreateSqlServerCatalogRequest) =>
        galaxy.catalog
          .createSqlServerCatalog(request)
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined)),
      update: (catalogId, patch: Omit<UpdateSqlServerCatalogRequest, "catalogId">) =>
        galaxy.catalog.updateSqlServerCatalog({ ...patch, catalogId }),
      validate: (catalogId) => galaxy.catalog.validateSqlServerCatalog({ catalogId }),
      delete: (catalogId) =>
        galaxy.catalog.deleteSqlServerCatalog({ catalogId }).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        ),
      list: galaxy.catalog.listSqlServerCatalogs.items({}),
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
      toAttributes: (shape: SqlServerCatalogShape): SqlServerCatalogAttributes => ({
        catalogId: shape.catalogId,
        name: shape.name,
        description: shape.description,
        readOnly: shape.readOnly,
        cloudKind: shape.cloudKind,
        endpoint: shape.endpoint,
        port: shape.port,
        databaseName: shape.databaseName,
        username: shape.username,
        sshTunnelId: shape.sshTunnelId,
        privateLinkId: shape.privateLinkId,
      }),
      secretsChanged: (olds, news) => secretValue(olds.password) !== secretValue(news.password),
    }),
  );
