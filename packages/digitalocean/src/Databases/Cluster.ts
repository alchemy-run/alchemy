import * as DO from "@distilled.cloud/digitalocean";
import type { DatabaseClusterRead } from "@distilled.cloud/digitalocean";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { setEquals } from "../internal/equal.ts";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import {
  generationTagFor,
  isAlchemyTag,
  ownershipTagFor,
  withoutAlchemyTags,
} from "../internal/ownership.ts";
import { pollUntil, type PollBudget } from "../internal/poll.ts";
import { toRedactedOrUndefined } from "../internal/redacted.ts";
import {
  alchemyTagsFor,
  deleteTagsIfUnused,
  desiredTagsFor,
  rejectReservedTags,
  syncTags,
} from "../internal/tags.ts";
import type { Providers } from "../Providers.ts";
import type { RegionSlug } from "../Slugs.ts";

export type ClusterEngine = "pg" | "mysql" | "valkey" | "mongodb" | "kafka" | "opensearch";

export type ClusterProps = {
  /**
   * Cluster name, unique within the team. A change replaces the cluster.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Database engine. A change replaces the cluster. */
  engine: ClusterEngine;
  /**
   * Engine major version, for example `"17"` for PostgreSQL. Raising it
   * upgrades the cluster in place; lowering it replaces the cluster.
   *
   * @default the engine's current default
   */
  version?: string;
  /** Node size slug, for example `"db-s-1vcpu-1gb"`. A change resizes the cluster in place. */
  size: string;
  /** Number of nodes; more than one adds standby nodes. A change resizes in place. @default 1 */
  numNodes?: number;
  /** Region slug. A change migrates the cluster to the new region in place. */
  region: RegionSlug;
  /** VPC for private connections. A change replaces the cluster. @default the region's default VPC */
  vpcUuid?: string;
  /** Disk size in MiB, for engines and sizes that allow extra storage. A change resizes in place. */
  storageSizeMib?: number;
  /** Tags to assign. The `alchemy:` prefix is reserved. A change updates the cluster in place. */
  tags?: string[];
  /** Weekly maintenance window in UTC, for example `{ day: "sunday", hour: "03:00" }`. */
  maintenanceWindow?: { day: string; hour: string };
};

export type Cluster = Resource<
  "DigitalOcean.Databases.Cluster",
  ClusterProps,
  {
    /** Cluster id (UUID). */
    clusterId: string;
    /** Uniform resource name, `do:dbaas:<id>`, for `ProjectResources`. */
    urn: string;
    /** Cluster name. */
    name: string;
    /** Database engine. */
    engine: string;
    /** Engine version. */
    version: string;
    /** `online` once usable. */
    status: string;
    /** Region slug. */
    region: string;
    /** Node size slug. */
    size: string;
    /** Number of nodes. */
    numNodes: number;
    /** Public host name. */
    host: string | undefined;
    /** Port. */
    port: number | undefined;
    /** Admin user, `doadmin` for SQL engines. */
    user: string | undefined;
    /** Admin password. */
    password: Redacted.Redacted<string> | undefined;
    /** Default database name, `defaultdb` for SQL engines. */
    database: string | undefined;
    /** Public connection URI with the admin credentials. */
    uri: Redacted.Redacted<string> | undefined;
    /** Host name inside the VPC. */
    privateHost: string | undefined;
    /** Connection URI inside the VPC. */
    privateUri: Redacted.Redacted<string> | undefined;
    /** VPC id. */
    vpcUuid: string | undefined;
    /** Tags without the `alchemy:` tags. */
    tags: string[];
    /** ISO 8601 creation time. */
    createdAt: string;
    /**
     * The PEM certificate of the CA that signs the cluster's TLS
     * certificate. Drivers verify the connection with it, e.g. `pg`'s
     * `ssl: { ca }`.
     */
    caCertificate: string | undefined;
  },
  never,
  Providers
>;

export type ClusterAttributes = Cluster["Attributes"];

/**
 * A DigitalOcean Managed Database cluster: PostgreSQL, MySQL, Valkey,
 * MongoDB, Kafka or OpenSearch. Size, node count, storage, region,
 * a higher version, tags and the maintenance window update in place;
 * `name`, `engine`, `vpcUuid` and a lower version replace the cluster,
 * which loses its data.
 *
 * Alchemy tags every cluster it creates with an `alchemy:` ownership tag
 * and an `alchemy:generation:` tag, so an interrupted deploy resumes on the
 * cluster it already created. A same-named cluster without the ownership
 * tag is `Unowned` and needs `--adopt`.
 *
 * A cluster takes five to ten minutes to come online; `reconcile` returns
 * once it is `online`.
 *
 * ### Creating a Cluster
 * **Example:** A single-node PostgreSQL cluster
 * ```typescript
 * const pg = yield* DigitalOcean.Databases.Cluster("db", {
 *   engine: "pg",
 *   version: "17",
 *   size: "db-s-1vcpu-1gb",
 *   region: "nyc3",
 * });
 * // pg.uri is a Redacted postgresql:// URI for the doadmin user.
 * ```
 *
 * **Example:** A high-availability MySQL cluster in a VPC
 * ```typescript
 * const network = yield* DigitalOcean.Vpc("network", { region: "nyc3" });
 * const mysql = yield* DigitalOcean.Databases.Cluster("mysql", {
 *   engine: "mysql",
 *   size: "db-s-2vcpu-4gb",
 *   numNodes: 3,
 *   region: "nyc3",
 *   vpcUuid: network.vpcId,
 *   maintenanceWindow: { day: "sunday", hour: "03:00" },
 * });
 * ```
 *
 * ### Databases, Users and Pools
 * **Example:** An app database with its own user and pool
 * ```typescript
 * const pg = yield* DigitalOcean.Databases.Cluster("db", {
 *   engine: "pg",
 *   size: "db-s-1vcpu-1gb",
 *   region: "nyc3",
 * });
 * const app = yield* DigitalOcean.Databases.Database("app", {
 *   clusterId: pg.clusterId,
 *   migrations: "./migrations",
 * });
 * const user = yield* DigitalOcean.Databases.User("app-user", { clusterId: pg.clusterId });
 * yield* DigitalOcean.Databases.ConnectionPool("app-pool", {
 *   clusterId: pg.clusterId,
 *   database: app.name,
 *   user: user.name,
 *   size: 10,
 * });
 * ```
 *
 * ### Restricting Access
 * **Example:** Only a droplet may connect
 * ```typescript
 * const pg = yield* DigitalOcean.Databases.Cluster("db", {
 *   engine: "pg",
 *   size: "db-s-1vcpu-1gb",
 *   region: "nyc3",
 * });
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "nyc3",
 *   size: "s-1vcpu-1gb",
 *   image: "ubuntu-24-04-x64",
 * });
 * yield* DigitalOcean.Databases.Firewall("db-firewall", {
 *   clusterId: pg.clusterId,
 *   rules: [{ type: "droplet", value: String(host.dropletId) }],
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Databases
 *
 * @resource
 * @product Managed Databases
 * @category Databases
 */
export const Cluster = Resource<Cluster>("DigitalOcean.Databases.Cluster");

export class ClusterTagReserved extends Data.TaggedError(
  "DigitalOcean.Databases.ClusterTagReserved",
)<{
  readonly tag: string;
}> {
  override get message() {
    return `Tag '${this.tag}' uses the 'alchemy:' prefix, which is reserved for ownership tags.`;
  }
}

export class ClusterWaitTimedOut extends Data.TaggedError(
  "DigitalOcean.Databases.ClusterWaitTimedOut",
)<{
  readonly clusterId: string;
  readonly waitingFor: string;
  readonly lastStatus: string | undefined;
}> {
  override get message() {
    return `Database cluster ${this.clusterId} timed out waiting for ${this.waitingFor} (last status: ${this.lastStatus ?? "missing"}).`;
  }
}

const NAME_MAX_LENGTH = 63;

// A cluster takes five to ten minutes to come online; a resize or a region
// migration can take longer (≈ 25 min budget).
const PROVISIONING_POLL: PollBudget = { maxDelay: "20 seconds", times: 80 };

const DELETE_POLL: PollBudget = { maxDelay: "10 seconds", times: 36 };

const physicalName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: NAME_MAX_LENGTH });

export const toClusterAttrs = (
  cluster: DatabaseClusterRead,
  caCertificate?: string,
): ClusterAttributes => ({
  clusterId: cluster.id,
  urn: `do:dbaas:${cluster.id}`,
  name: cluster.name,
  engine: cluster.engine,
  version: cluster.version,
  status: cluster.status,
  region: cluster.region,
  size: cluster.size,
  numNodes: cluster.num_nodes,
  host: cluster.connection.host,
  port: cluster.connection.port,
  user: cluster.connection.user,
  password: toRedactedOrUndefined(cluster.connection.password),
  database: cluster.connection.database,
  uri: toRedactedOrUndefined(cluster.connection.uri),
  privateHost: cluster.private_connection?.host,
  privateUri: toRedactedOrUndefined(cluster.private_connection?.uri),
  vpcUuid: cluster.private_network_uuid || undefined,
  tags: withoutAlchemyTags(cluster.tags ?? []),
  createdAt: cluster.created_at,
  caCertificate,
});

/** The cluster's CA certificate as PEM; `undefined` for engines without one. */
export const clusterCaCertificate = (clusterId: string) =>
  DO.getDatabaseCa({ database_cluster_uuid: clusterId }).pipe(
    Effect.flatMap((r) =>
      Effect.sync(() => Buffer.from(r.ca.certificate, "base64").toString("utf8")),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

export const observeCluster = (clusterId: string) =>
  noneIfNotFound(
    DO.getDatabaseCluster({ database_cluster_uuid: clusterId }).pipe(Effect.map((r) => r.database)),
  );

const observeByTag = (tag: string) =>
  DO.listDatabaseClusters({ tag_name: tag }).pipe(
    Effect.map((r) => Option.fromNullishOr((r.databases ?? [])[0])),
  );

const observeByName = (name: string) =>
  DO.listDatabaseClusters({}).pipe(
    Effect.map((r) => Option.fromNullishOr((r.databases ?? []).find((c) => c.name === name))),
  );

const observeGeneration = Effect.fn(function* (
  output: ClusterAttributes | undefined,
  instanceId: string,
) {
  if (output !== undefined) {
    const byId = yield* observeCluster(output.clusterId);
    if (Option.isSome(byId)) return byId;
  }
  return yield* observeByTag(generationTagFor(instanceId));
});

/** Waits until a cluster is online and matches `until`. */
export const waitUntilOnline = (
  clusterId: string,
  until: (cluster: DatabaseClusterRead) => boolean = () => true,
) =>
  pollUntil(observeCluster(clusterId), {
    ...PROVISIONING_POLL,
    until: (o): o is Option.Some<DatabaseClusterRead> =>
      Option.isSome(o) && o.value.status === "online" && until(o.value),
    onTimeout: (last) =>
      new ClusterWaitTimedOut({
        clusterId,
        waitingFor: "the online state",
        lastStatus: Option.getOrUndefined(last)?.status,
      }),
  }).pipe(Effect.map((o) => o.value));

const majorOf = (version: string | undefined) => Number.parseInt(version ?? "", 10);

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: ["clusterId", "urn", "engine", "createdAt"],
    list: Effect.fn(function* () {
      const response = yield* DO.listDatabaseClusters({});
      return (response.databases ?? [])
        .filter((cluster) => (cluster.tags ?? []).some(isAlchemyTag))
        .map((cluster) => toClusterAttrs(cluster));
    }),
    read: Effect.fn(function* ({ fqn, instanceId, olds, output }) {
      const owned = yield* observeGeneration(output, instanceId);
      if (Option.isSome(owned)) return toClusterAttrs(owned.value, output?.caCertificate);
      if (olds.name === undefined) return undefined;
      const ownershipTag = yield* ownershipTagFor(fqn);
      const named = yield* observeByName(olds.name);
      return named.pipe(
        Option.filter((cluster) => !(cluster.tags ?? []).includes(ownershipTag)),
        Option.map((cluster) => Unowned(toClusterAttrs(cluster))),
        Option.getOrUndefined,
      );
    }),
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const downgraded =
        news.version !== undefined &&
        olds.version !== undefined &&
        majorOf(news.version) < majorOf(olds.version);
      if (
        news.name !== olds.name ||
        news.engine !== olds.engine ||
        news.vpcUuid !== olds.vpcUuid ||
        downgraded
      ) {
        // Names are unique, so a chosen name frees up before the new cluster takes it.
        return { action: "replace", deleteFirst: news.name !== undefined } as const;
      }
      // Clusters deployed before `caCertificate` existed record it on their next deploy.
      if (output !== undefined && output.caCertificate === undefined) {
        return { action: "update" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, fqn, instanceId, news, output }) {
      yield* rejectReservedTags(news.tags, (tag) => new ClusterTagReserved({ tag }));
      const tags = yield* desiredTagsFor(news.tags, fqn, instanceId);
      const name = news.name ?? (yield* physicalName(id));
      const numNodes = news.numNodes ?? 1;

      const observed = yield* observeGeneration(output, instanceId);
      const created = yield* Option.match(observed, {
        onNone: () =>
          DO.createDatabaseCluster({
            name,
            engine: news.engine,
            version: news.version,
            size: news.size,
            num_nodes: numNodes,
            region: news.region,
            private_network_uuid: news.vpcUuid,
            storage_size_mib: news.storageSizeMib,
            tags: [...tags],
          }).pipe(Effect.map((r) => r.database)),
        onSome: Effect.succeed,
      });
      let cluster = yield* waitUntilOnline(created.id);

      yield* syncTags("database", cluster.id, cluster.tags ?? [], tags);

      const resized =
        cluster.size !== news.size ||
        cluster.num_nodes !== numNodes ||
        (news.storageSizeMib !== undefined && cluster.storage_size_mib !== news.storageSizeMib);
      if (resized) {
        yield* DO.updateDatabaseClusterSize({
          database_cluster_uuid: cluster.id,
          size: news.size,
          num_nodes: numNodes,
          storage_size_mib: news.storageSizeMib,
        });
        cluster = yield* waitUntilOnline(
          cluster.id,
          (c) => c.size === news.size && c.num_nodes === numNodes,
        );
      }

      if (cluster.region !== news.region) {
        yield* DO.updateDatabaseRegion({ database_cluster_uuid: cluster.id, region: news.region });
        cluster = yield* waitUntilOnline(cluster.id, (c) => c.region === news.region);
      }

      if (news.version !== undefined && majorOf(cluster.version) < majorOf(news.version)) {
        yield* DO.updateDatabaseMajorVersion({
          database_cluster_uuid: cluster.id,
          version: news.version,
        });
        cluster = yield* waitUntilOnline(
          cluster.id,
          (c) => majorOf(c.version) === majorOf(news.version),
        );
      }

      const window = news.maintenanceWindow;
      if (
        window !== undefined &&
        (cluster.maintenance_window?.day !== window.day ||
          cluster.maintenance_window?.hour !== window.hour)
      ) {
        yield* DO.updateDatabaseMaintenanceWindow({
          database_cluster_uuid: cluster.id,
          day: window.day,
          hour: window.hour,
        });
      }

      const online = yield* waitUntilOnline(cluster.id, (c) => setEquals(c.tags, tags));
      return toClusterAttrs(online, yield* clusterCaCertificate(cluster.id));
    }),
    delete: Effect.fn(function* ({ fqn, instanceId, output }) {
      const observed = yield* observeCluster(output.clusterId);
      const alchemyTags = Option.isSome(observed)
        ? (observed.value.tags ?? []).filter(isAlchemyTag)
        : yield* alchemyTagsFor(fqn, instanceId);
      if (Option.isSome(observed)) {
        yield* ignoreNotFound(
          DO.databasesDestroyCluster({ database_cluster_uuid: output.clusterId }),
        );
        yield* pollUntil(observeCluster(output.clusterId), {
          ...DELETE_POLL,
          until: Option.isNone,
          onTimeout: () =>
            new ClusterWaitTimedOut({
              clusterId: output.clusterId,
              waitingFor: "deletion",
              lastStatus: undefined,
            }),
        });
      }
      yield* deleteTagsIfUnused(alchemyTags);
    }),
  });
