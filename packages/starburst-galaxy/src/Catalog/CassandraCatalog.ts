import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type {
  CassandraCatalog as CassandraCatalogShape,
  CassandraCatalogPatch,
  CreateCassandraCatalogRequest,
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

/** A self-managed Apache Cassandra cluster. */
export interface ApacheCassandraDeployment {
  readonly type: "apacheCassandra";
  /** Comma-separated host names or addresses of the cluster's contact points. */
  readonly contactPoints: string;
  /** Data center the driver treats as local, e.g. `dc1`. */
  readonly localDatacenter: string;
  /**
   * CQL native transport port.
   * @default 9042
   */
  readonly port?: number;
  /** Cassandra user Galaxy connects as. */
  readonly username: string;
  /** Password of `username`. Galaxy never returns it. */
  readonly password: Redacted.Redacted<string>;
  /** ID of a Galaxy SSH tunnel to reach a private cluster through. */
  readonly sshTunnelId?: string;
}

/** A DataStax Astra DB database. */
export interface AstraDBDeployment {
  readonly type: "astraDB";
  /** Astra database ID (a UUID). */
  readonly databaseId: string;
  /** Cloud region of the database, e.g. `us-east-1`. */
  readonly region: string;
  /** Astra application token (`AstraCS:…`). Galaxy never returns it. */
  readonly token: Redacted.Redacted<string>;
}

export type CassandraDeployment = ApacheCassandraDeployment | AstraDBDeployment;

export interface CassandraCatalogProps extends CatalogBaseProps {
  /**
   * The Cassandra deployment. Changing `type` replaces the catalog: an
   * Astra DB database and a self-managed cluster are different stores.
   */
  readonly deployment: CassandraDeployment;
  /**
   * Cloud the deployment runs in, for Galaxy's network routing.
   * @default "AWS"
   */
  readonly cloudKind?: CloudKind;
}

/** A deployment as Galaxy reports it; secrets are never included. */
export type CassandraDeploymentAttributes =
  | Omit<ApacheCassandraDeployment, "password">
  | Omit<AstraDBDeployment, "token">;

export interface CassandraCatalogAttributes extends CatalogBaseAttributes {
  /** The deployment as Galaxy reports it. */
  readonly deployment: CassandraDeploymentAttributes;
  /** Cloud the deployment runs in, as Galaxy reports it. */
  readonly cloudKind: CloudKind | undefined;
}

export type CassandraCatalog = Resource<
  "StarburstGalaxy.Catalog.CassandraCatalog",
  CassandraCatalogProps,
  CassandraCatalogAttributes,
  never,
  Providers,
  CatalogLookup
>;

/**
 * A Starburst Galaxy catalog over Apache Cassandra or DataStax Astra DB:
 * keyspaces become schemas, queried as `<catalog>.<keyspace>.<table>` on
 * every cluster the catalog is attached to.
 *
 * Every setting except the deployment type updates in place, the name
 * included. Galaxy never returns the password or Astra token, so a rotated
 * secret is detected by comparing the deployed value with the new one.
 * Galaxy checks the connection on every create and update; set
 * `validate: false` to store a catalog it cannot reach yet.
 *
 * Catalogs have no labels or tags in Galaxy: a catalog Alchemy created is
 * recognized by its generated name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/working-with-data/create-catalogs/non-object-storage/cassandra.html
 *
 * ### Creating a catalog
 * **Example:** An Astra DB database
 * ```typescript
 * const token = yield* Config.Redacted("ASTRA_TOKEN");
 * const iot = yield* StarburstGalaxy.Catalog.CassandraCatalog("Iot", {
 *   deployment: {
 *     type: "astraDB",
 *     databaseId: "3f8b2d4e-1c2a-4e8b-9f1d-2a3b4c5d6e7f",
 *     region: "us-east-1",
 *     token,
 *   },
 * });
 * yield* StarburstGalaxy.Cluster.Cluster("Analytics", {
 *   cloudRegionId: "aws-us-east1",
 *   catalogs: [iot.catalogId],
 * });
 * ```
 *
 * ### A self-managed cluster
 * **Example:** Contact points in one data center
 * ```typescript
 * const password = yield* Config.Redacted("CASSANDRA_PASSWORD");
 * yield* StarburstGalaxy.Catalog.CassandraCatalog("Ledger", {
 *   deployment: {
 *     type: "apacheCassandra",
 *     contactPoints: "cass-1.example.com,cass-2.example.com",
 *     localDatacenter: "dc1",
 *     username: "galaxy",
 *     password,
 *   },
 * });
 * ```
 *
 * ### Looking up an existing catalog
 * **Example:** Reference a catalog created in the Galaxy console
 * ```typescript
 * const iot = StarburstGalaxy.Catalog.CassandraCatalog.lookup({ name: "iot" });
 * ```
 *
 * @resource
 * @product Catalogs
 */
export const CassandraCatalog = Resource<CassandraCatalog>(
  "StarburstGalaxy.Catalog.CassandraCatalog",
);

const deploymentOf = (shape: CassandraCatalogShape): CassandraDeploymentAttributes =>
  shape.deploymentType === "apacheCassandra"
    ? {
        type: "apacheCassandra",
        contactPoints: shape.contactPoints,
        localDatacenter: shape.localDatacenter,
        port: shape.port,
        username: shape.username,
        sshTunnelId: shape.sshTunnelId,
      }
    : { type: "astraDB", databaseId: shape.databaseId, region: shape.region };

/** The deployment's non-secret settings, as Galaxy names them. */
const deploymentSettingsOf = (deployment: CassandraDeployment) =>
  deployment.type === "apacheCassandra"
    ? {
        contactPoints: deployment.contactPoints,
        localDatacenter: deployment.localDatacenter,
        port: deployment.port,
        username: deployment.username,
        sshTunnelId: deployment.sshTunnelId,
      }
    : { databaseId: deployment.databaseId, region: deployment.region };

const secretsOf = (deployment: CassandraDeployment) =>
  deployment.type === "apacheCassandra"
    ? { password: deployment.password }
    : { token: deployment.token };

const secretOf = (deployment: CassandraDeployment) =>
  secretValue(deployment.type === "apacheCassandra" ? deployment.password : deployment.token);

/** The non-secret settings, as Galaxy names them. */
const settingsOf = (name: string, props: CassandraCatalogProps) => ({
  name,
  description: props.description ?? "",
  readOnly: props.readOnly ?? false,
  cloudKind: props.cloudKind,
});

export const CassandraCatalogProvider = () =>
  Provider.succeed(
    CassandraCatalog,
    catalogLifecycle({
      kind: "Cassandra",
      get: (catalogId) =>
        galaxy.catalog
          .getCassandraCatalog({ catalogId })
          .pipe(Effect.catchTag("NotFound", () => Effect.undefined)),
      create: (body: CreateCassandraCatalogRequest) =>
        galaxy.catalog
          .createCassandraCatalog({ body })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined)),
      update: (catalogId, body: CassandraCatalogPatch) =>
        galaxy.catalog.updateCassandraCatalog({ catalogId, body }),
      validate: (catalogId) => galaxy.catalog.validateCassandraCatalog({ catalogId }),
      delete: (catalogId) =>
        galaxy.catalog.deleteCassandraCatalog({ catalogId }).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        ),
      list: galaxy.catalog.listCassandraCatalogs.items({}),
      toCreate: (name, props): CreateCassandraCatalogRequest => {
        const fields = { ...settingsOf(name, props), validate: props.validate ?? true };
        const deployment = props.deployment;
        switch (deployment.type) {
          case "apacheCassandra":
            return {
              ...fields,
              deploymentType: "apacheCassandra",
              contactPoints: deployment.contactPoints,
              localDatacenter: deployment.localDatacenter,
              port: deployment.port,
              username: deployment.username,
              password: deployment.password,
              sshTunnelId: deployment.sshTunnelId,
            };
          case "astraDB":
            return {
              ...fields,
              deploymentType: "astraDB",
              databaseId: deployment.databaseId,
              region: deployment.region,
              token: deployment.token,
            };
        }
      },
      toPatch: (name, props, observed, withSecrets): CassandraCatalogPatch | undefined => {
        const delta = changedFields(
          { ...observed, description: observed.description ?? "" },
          { ...settingsOf(name, props), ...deploymentSettingsOf(props.deployment) },
        );
        if (!hasChanges(delta) && !withSecrets) return undefined;
        const fields = {
          ...delta,
          ...(withSecrets ? secretsOf(props.deployment) : {}),
          validate: props.validate ?? true,
        };
        // The deployment type never changes in place (it replaces), so the patch uses the current one.
        return props.deployment.type === "apacheCassandra"
          ? { ...fields, deploymentType: "apacheCassandra" }
          : { ...fields, deploymentType: "astraDB" };
      },
      toAttributes: (shape: CassandraCatalogShape): CassandraCatalogAttributes => ({
        catalogId: shape.catalogId,
        name: shape.name,
        description: shape.description,
        readOnly: shape.readOnly,
        deployment: deploymentOf(shape),
        cloudKind: shape.cloudKind,
      }),
      secretsChanged: (olds, news) => secretOf(olds.deployment) !== secretOf(news.deployment),
      replaces: (olds, news) => olds.deployment.type !== news.deployment.type,
    }),
  );
