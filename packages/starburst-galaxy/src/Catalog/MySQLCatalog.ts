import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type {
  CreateMySQLCatalogRequest,
  MySQLCatalog as MySQLCatalogShape,
  MySQLCatalogPatch,
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

/** Galaxy connects to the MySQL server's host directly over the internet. */
export interface MySQLDirectConnection {
  readonly type: "direct";
  /** Host name of the MySQL server. */
  readonly host: string;
}

/** Galaxy connects to the MySQL server through one of its SSH tunnels. */
export interface MySQLSshTunnelConnection {
  readonly type: "sshTunnel";
  /** ID of the Galaxy SSH tunnel. */
  readonly sshTunnelId: string;
  /** Host name of the MySQL server, as the tunnel's bastion resolves it. */
  readonly host: string;
}

/** Galaxy connects to the MySQL server through a PrivateLink connection. */
export interface MySQLPrivateLinkConnection {
  readonly type: "privateLink";
  /** ID of the Galaxy PrivateLink connection (see `StarburstGalaxy.Network.PrivateLink`). */
  readonly privateLinkId: string;
}

export type MySQLConnection =
  | MySQLDirectConnection
  | MySQLSshTunnelConnection
  | MySQLPrivateLinkConnection;

export interface MySQLCatalogProps extends CatalogBaseProps {
  /**
   * How Galaxy reaches the MySQL server. Changing `type` replaces the catalog: Galaxy keeps a
   * catalog's connection type on update.
   */
  readonly connection: MySQLConnection;
  /**
   * Port of the MySQL server.
   * @default 3306
   */
  readonly port?: number;
  /** MySQL user Galaxy connects as. Its grants bound what the catalog can read and write. */
  readonly username: string;
  /**
   * Password of `username`. Galaxy never returns it: a change is detected
   * by comparing the new value with the deployed one.
   */
  readonly password: Redacted.Redacted<string>;
  /**
   * Cloud the MySQL server runs in, for Galaxy's network routing.
   * @default "AWS"
   */
  readonly cloudKind?: CloudKind;
}

export interface MySQLCatalogAttributes extends CatalogBaseAttributes {
  /** How Galaxy reaches the server, as Galaxy reports it. */
  readonly connection: MySQLConnection;
  /** Port Galaxy connects to. */
  readonly port: number | undefined;
  /** MySQL user Galaxy connects as. */
  readonly username: string;
  /** Cloud the server runs in, as Galaxy reports it. */
  readonly cloudKind: CloudKind | undefined;
}

export type MySQLCatalog = Resource<
  "StarburstGalaxy.Catalog.MySQLCatalog",
  MySQLCatalogProps,
  MySQLCatalogAttributes,
  never,
  Providers,
  CatalogLookup
>;

/**
 * A Starburst Galaxy catalog over a MySQL database server: its databases
 * become schemas, queried as `<catalog>.<database>.<table>` on every
 * cluster the catalog is attached to.
 *
 * Every setting, the name included, updates in place except the
 * connection type, which replaces the catalog. Galaxy never returns the
 * password, so a rotated password is detected by comparing the deployed
 * value with the new one. Galaxy checks the connection on every create and
 * update; set `validate: false` to store a catalog whose server is not
 * reachable yet.
 *
 * Catalogs have no labels or tags in Galaxy: a catalog Alchemy created is
 * recognized by its generated name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/working-with-data/create-catalogs/non-object-storage/mysql.html
 *
 * ### Creating a catalog
 * **Example:** A catalog over a MySQL server reachable from the internet
 * ```typescript
 * const password = yield* Config.Redacted("SHOP_DB_PASSWORD");
 * const shop = yield* StarburstGalaxy.Catalog.MySQLCatalog("Shop", {
 *   connection: { type: "direct", host: "shop.cluster-abc.us-east-1.rds.amazonaws.com" },
 *   username: "galaxy",
 *   password,
 * });
 * yield* StarburstGalaxy.Cluster.Cluster("Analytics", {
 *   cloudRegionId: "aws-us-east1",
 *   catalogs: [shop.catalogId],
 * });
 * ```
 *
 * ### Reaching a private server
 * **Example:** Through a Galaxy SSH tunnel
 * ```typescript
 * const password = yield* Config.Redacted("SHOP_DB_PASSWORD");
 * yield* StarburstGalaxy.Catalog.MySQLCatalog("Shop", {
 *   connection: { type: "sshTunnel", sshTunnelId: "st-1234567890", host: "10.0.4.12" },
 *   username: "galaxy",
 *   password,
 *   readOnly: true,
 * });
 * ```
 *
 * ### Looking up an existing catalog
 * **Example:** Reference a catalog created in the Galaxy console
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.MySQLCatalog.lookup({ name: "shop" });
 * ```
 *
 * @resource
 * @product Catalogs
 */
export const MySQLCatalog = Resource<MySQLCatalog>("StarburstGalaxy.Catalog.MySQLCatalog");

const connectionOf = (shape: MySQLCatalogShape): MySQLConnection =>
  shape.connectionType === "direct"
    ? { type: "direct", host: shape.host }
    : shape.connectionType === "sshTunnel"
      ? { type: "sshTunnel", sshTunnelId: shape.sshTunnelId, host: shape.host }
      : { type: "privateLink", privateLinkId: shape.privateLinkId };

/** The connection's settings, as Galaxy names them. */
const connectionSettingsOf = (connection: MySQLConnection) =>
  connection.type === "direct"
    ? { host: connection.host }
    : connection.type === "sshTunnel"
      ? { sshTunnelId: connection.sshTunnelId, host: connection.host }
      : { privateLinkId: connection.privateLinkId };

/** The non-secret settings, as Galaxy names them. */
const settingsOf = (name: string, props: MySQLCatalogProps) => ({
  name,
  description: props.description ?? "",
  readOnly: props.readOnly ?? false,
  cloudKind: props.cloudKind,
  port: props.port,
  username: props.username,
});

export const MySQLCatalogProvider = () =>
  Provider.succeed(
    MySQLCatalog,
    catalogLifecycle({
      kind: "MySQL",
      get: (catalogId) =>
        galaxy.catalog
          .getMySQLCatalog({ catalogId })
          .pipe(Effect.catchTag("NotFound", () => Effect.undefined)),
      create: (body: CreateMySQLCatalogRequest) =>
        galaxy.catalog
          .createMySQLCatalog({ body })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined)),
      update: (catalogId, body: MySQLCatalogPatch) =>
        galaxy.catalog.updateMySQLCatalog({ catalogId, body }),
      validate: (catalogId) => galaxy.catalog.validateMySQLCatalog({ catalogId }),
      delete: (catalogId) =>
        galaxy.catalog.deleteMySQLCatalog({ catalogId }).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        ),
      list: galaxy.catalog.listMySQLCatalogs.items({}),
      toCreate: (name, props): CreateMySQLCatalogRequest => {
        const fields = {
          ...settingsOf(name, props),
          password: props.password,
          validate: props.validate ?? true,
        };
        const connection = props.connection;
        switch (connection.type) {
          case "direct":
            return { ...fields, connectionType: "direct", host: connection.host };
          case "sshTunnel":
            return {
              ...fields,
              connectionType: "sshTunnel",
              sshTunnelId: connection.sshTunnelId,
              host: connection.host,
            };
          case "privateLink":
            return {
              ...fields,
              connectionType: "privateLink",
              privateLinkId: connection.privateLinkId,
            };
        }
      },
      toPatch: (name, props, observed, withSecrets): MySQLCatalogPatch | undefined => {
        const delta = changedFields(
          { ...observed, description: observed.description ?? "" },
          { ...settingsOf(name, props), ...connectionSettingsOf(props.connection) },
        );
        if (!hasChanges(delta) && !withSecrets) return undefined;
        const fields = {
          ...delta,
          ...(withSecrets ? { password: props.password } : {}),
          validate: props.validate ?? true,
        };
        // The connection type never changes in place (it replaces), so the patch uses the current one.
        switch (props.connection.type) {
          case "direct":
            return { ...fields, connectionType: "direct" };
          case "sshTunnel":
            return { ...fields, connectionType: "sshTunnel" };
          case "privateLink":
            return { ...fields, connectionType: "privateLink" };
        }
      },
      toAttributes: (shape: MySQLCatalogShape): MySQLCatalogAttributes => ({
        catalogId: shape.catalogId,
        name: shape.name,
        description: shape.description,
        readOnly: shape.readOnly,
        connection: connectionOf(shape),
        port: shape.port,
        username: shape.username,
        cloudKind: shape.cloudKind,
      }),
      secretsChanged: (olds, news) => secretValue(olds.password) !== secretValue(news.password),
      replaces: (olds, news) => olds.connection.type !== news.connection.type,
    }),
  );
