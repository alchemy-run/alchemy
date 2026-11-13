import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type {
  CreateMongoDBCatalogRequest,
  MongoDBCatalog as MongoDBCatalogShape,
  MongoDBCatalogPatch,
} from "@distilled.cloud/starburst-galaxy/catalog";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { changedFields, hasChanges, sameIds } from "../internal.ts";
import type { Providers } from "../Providers.ts";
import {
  type CatalogBaseAttributes,
  type CatalogBaseProps,
  type CatalogLookup,
  catalogLifecycle,
  type CloudKind,
  secretValue,
} from "./CatalogKind.ts";

/** Galaxy connects to the MongoDB hosts directly over the internet. */
export interface MongoDBDirectConnection {
  readonly type: "direct";
  /** Comma-separated `host[:port]` list, or the SRV host name when `dnsSeedListEnabled`. */
  readonly hosts: string;
}

/** Galaxy connects to the MongoDB hosts through one of its SSH tunnels. */
export interface MongoDBSshTunnelConnection {
  readonly type: "sshTunnel";
  /** ID of the Galaxy SSH tunnel. */
  readonly sshTunnelId: string;
  /** Comma-separated `host[:port]` list, as the tunnel's bastion resolves it. */
  readonly hosts: string;
}

/** Galaxy connects through a PrivateLink connection (MongoDB Atlas). */
export interface MongoDBPrivateLinkConnection {
  readonly type: "privateLink";
  /** ID of the Galaxy PrivateLink connection (see `StarburstGalaxy.Network.PrivateLink`). */
  readonly privateLinkId: string;
}

export type MongoDBConnection =
  | MongoDBDirectConnection
  | MongoDBSshTunnelConnection
  | MongoDBPrivateLinkConnection;

export interface MongoDBCatalogProps extends CatalogBaseProps {
  /**
   * How Galaxy reaches the deployment. Changing `type` replaces the catalog: Galaxy keeps a
   * catalog's connection type on update.
   */
  readonly connection: MongoDBConnection;
  /**
   * Galaxy cloud regions the deployment is reachable from, e.g.
   * `["aws-us-east1"]`. Clusters in other regions cannot query the catalog.
   */
  readonly regions: ReadonlyArray<string>;
  /** MongoDB user Galaxy connects as. */
  readonly username: string;
  /**
   * Password of `username`. Galaxy never returns it: a change is detected
   * by comparing the new value with the deployed one.
   */
  readonly password: Redacted.Redacted<string>;
  /**
   * Resolve `hosts` as a DNS seed list (`mongodb+srv://`), as MongoDB Atlas uses.
   * @default false
   */
  readonly dnsSeedListEnabled?: boolean;
  /**
   * Connect over TLS.
   * @default true
   */
  readonly tlsEnabled?: boolean;
  /**
   * The deployment is an Atlas federated database instance.
   * @default false
   */
  readonly federatedDatabaseEnabled?: boolean;
  /**
   * Cloud the deployment runs in, for Galaxy's network routing.
   * @default "AWS"
   */
  readonly cloudKind?: CloudKind;
}

export interface MongoDBCatalogAttributes extends CatalogBaseAttributes {
  /** How Galaxy reaches the deployment, as Galaxy reports it. */
  readonly connection: MongoDBConnection;
  /** Galaxy cloud regions the deployment is reachable from. */
  readonly regions: ReadonlyArray<string>;
  /** MongoDB user Galaxy connects as. */
  readonly username: string;
  /** Whether `hosts` is a DNS seed list. */
  readonly dnsSeedListEnabled: boolean | undefined;
  /** Whether Galaxy connects over TLS. */
  readonly tlsEnabled: boolean | undefined;
  /** Whether the deployment is an Atlas federated database instance. */
  readonly federatedDatabaseEnabled: boolean | undefined;
  /** Cloud the deployment runs in, as Galaxy reports it. */
  readonly cloudKind: CloudKind | undefined;
}

export type MongoDBCatalog = Resource<
  "StarburstGalaxy.Catalog.MongoDBCatalog",
  MongoDBCatalogProps,
  MongoDBCatalogAttributes,
  never,
  Providers,
  CatalogLookup
>;

/**
 * A Starburst Galaxy catalog over a MongoDB deployment (MongoDB Atlas or
 * self-managed): databases become schemas and collections become tables,
 * queried as `<catalog>.<database>.<collection>`.
 *
 * Every setting, the name included, updates in place except the
 * connection type, which replaces the catalog. Galaxy never returns the
 * password, so a rotated password is detected by comparing the deployed
 * value with the new one. Galaxy checks the connection on every create and
 * update; set `validate: false` to store a catalog it cannot reach yet.
 *
 * Catalogs have no labels or tags in Galaxy: a catalog Alchemy created is
 * recognized by its generated name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/working-with-data/create-catalogs/non-object-storage/mongodb.html
 *
 * ### Creating a catalog
 * **Example:** A MongoDB Atlas cluster through its SRV record
 * ```typescript
 * const password = yield* Config.Redacted("ATLAS_PASSWORD");
 * const events = yield* StarburstGalaxy.Catalog.MongoDBCatalog("Events", {
 *   connection: { type: "direct", hosts: "events.abcde.mongodb.net" },
 *   dnsSeedListEnabled: true,
 *   regions: ["aws-us-east1"],
 *   username: "galaxy",
 *   password,
 * });
 * yield* StarburstGalaxy.Cluster.Cluster("Analytics", {
 *   cloudRegionId: "aws-us-east1",
 *   catalogs: [events.catalogId],
 * });
 * ```
 *
 * ### Looking up an existing catalog
 * **Example:** Reference a catalog created in the Galaxy console
 * ```typescript
 * const events = StarburstGalaxy.Catalog.MongoDBCatalog.lookup({ name: "events" });
 * ```
 *
 * @resource
 * @product Catalogs
 */
export const MongoDBCatalog = Resource<MongoDBCatalog>("StarburstGalaxy.Catalog.MongoDBCatalog");

const connectionOf = (shape: MongoDBCatalogShape): MongoDBConnection =>
  shape.connectionType === "direct"
    ? { type: "direct", hosts: shape.hosts }
    : shape.connectionType === "sshTunnel"
      ? { type: "sshTunnel", sshTunnelId: shape.sshTunnelId, hosts: shape.hosts }
      : { type: "privateLink", privateLinkId: shape.privateLinkId };

/** The connection's settings, as Galaxy names them. */
const connectionSettingsOf = (connection: MongoDBConnection) =>
  connection.type === "direct"
    ? { hosts: connection.hosts }
    : connection.type === "sshTunnel"
      ? { sshTunnelId: connection.sshTunnelId, hosts: connection.hosts }
      : { privateLinkId: connection.privateLinkId };

/** The non-secret settings, as Galaxy names them; regions are compared apart. */
const settingsOf = (name: string, props: MongoDBCatalogProps) => ({
  name,
  description: props.description ?? "",
  readOnly: props.readOnly ?? false,
  cloudKind: props.cloudKind,
  username: props.username,
  dnsSeedListEnabled: props.dnsSeedListEnabled,
  tlsEnabled: props.tlsEnabled,
  federatedDatabaseEnabled: props.federatedDatabaseEnabled,
});

export const MongoDBCatalogProvider = () =>
  Provider.succeed(
    MongoDBCatalog,
    catalogLifecycle({
      kind: "MongoDB",
      get: (catalogId) =>
        galaxy.catalog
          .getMongoDBCatalog({ catalogId })
          .pipe(Effect.catchTag("NotFound", () => Effect.undefined)),
      create: (body: CreateMongoDBCatalogRequest) =>
        galaxy.catalog
          .createMongoDBCatalog({ body })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined)),
      update: (catalogId, body: MongoDBCatalogPatch) =>
        galaxy.catalog.updateMongoDBCatalog({ catalogId, body }),
      validate: (catalogId) => galaxy.catalog.validateMongoDBCatalog({ catalogId }),
      delete: (catalogId) =>
        galaxy.catalog.deleteMongoDBCatalog({ catalogId }).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        ),
      list: galaxy.catalog.listMongoDBCatalogs.items({}),
      toCreate: (name, props): CreateMongoDBCatalogRequest => {
        const fields = {
          ...settingsOf(name, props),
          regions: [...props.regions],
          password: props.password,
          validate: props.validate ?? true,
        };
        const connection = props.connection;
        switch (connection.type) {
          case "direct":
            return { ...fields, connectionType: "direct", hosts: connection.hosts };
          case "sshTunnel":
            return {
              ...fields,
              connectionType: "sshTunnel",
              sshTunnelId: connection.sshTunnelId,
              hosts: connection.hosts,
            };
          case "privateLink":
            return {
              ...fields,
              connectionType: "privateLink",
              privateLinkId: connection.privateLinkId,
            };
        }
      },
      toPatch: (name, props, observed, withSecrets): MongoDBCatalogPatch | undefined => {
        const delta = changedFields(
          { ...observed, description: observed.description ?? "" },
          { ...settingsOf(name, props), ...connectionSettingsOf(props.connection) },
        );
        const regionsChanged = !sameIds(observed.regions, props.regions);
        if (!hasChanges(delta) && !regionsChanged && !withSecrets) return undefined;
        const fields = {
          ...delta,
          ...(regionsChanged ? { regions: [...props.regions] } : {}),
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
      toAttributes: (shape: MongoDBCatalogShape): MongoDBCatalogAttributes => ({
        catalogId: shape.catalogId,
        name: shape.name,
        description: shape.description,
        readOnly: shape.readOnly,
        connection: connectionOf(shape),
        regions: shape.regions,
        username: shape.username,
        dnsSeedListEnabled: shape.dnsSeedListEnabled,
        tlsEnabled: shape.tlsEnabled,
        federatedDatabaseEnabled: shape.federatedDatabaseEnabled,
        cloudKind: shape.cloudKind,
      }),
      secretsChanged: (olds, news) => secretValue(olds.password) !== secretValue(news.password),
      replaces: (olds, news) => olds.connection.type !== news.connection.type,
    }),
  );
