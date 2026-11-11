import * as DO from "@distilled.cloud/digitalocean";
import type { DatabaseReplicaRead } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import { pollUntil, type PollBudget } from "../internal/poll.ts";
import { toRedactedOrUndefined } from "../internal/redacted.ts";
import type { Providers } from "../Providers.ts";
import type { RegionSlug } from "../Slugs.ts";
import { waitUntilOnline } from "./Cluster.ts";

export type ReplicaProps = {
  /** The PostgreSQL or MySQL cluster to replicate. A change replaces the replica. */
  clusterId: string;
  /**
   * Replica name. A change replaces the replica.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Node size slug, at least the cluster's. A change replaces the replica. */
  size: string;
  /** Region for the replica. A change replaces the replica. @default the cluster's region */
  region?: RegionSlug;
  /** VPC for the replica. A change replaces the replica. */
  vpcUuid?: string;
};

export type Replica = Resource<
  "DigitalOcean.Databases.Replica",
  ReplicaProps,
  {
    /** Replica id (UUID). */
    replicaId: string;
    /** The cluster it replicates. */
    clusterId: string;
    /** Replica name. */
    name: string;
    /** Region slug. */
    region: string;
    /** `online` once it serves reads. */
    status: string;
    /** Public host name. */
    host: string | undefined;
    /** Public read-only connection URI. */
    uri: Redacted.Redacted<string> | undefined;
    /** Read-only connection URI inside the VPC. */
    privateUri: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
>;

/**
 * A read-only replica of a PostgreSQL or MySQL Managed Database cluster,
 * in the cluster's region or another one. Point read-heavy work at
 * `replica.uri`. Every prop replaces the replica.
 *
 * ### Adding a Read Replica
 * **Example:** A replica in another region
 * ```typescript
 * const pg = yield* DigitalOcean.Databases.Cluster("db", {
 *   engine: "pg",
 *   size: "db-s-1vcpu-2gb",
 *   region: "nyc3",
 * });
 * const reads = yield* DigitalOcean.Databases.Replica("db-reads", {
 *   clusterId: pg.clusterId,
 *   size: "db-s-1vcpu-2gb",
 *   region: "sfo3",
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#operation/databases_create_replica
 *
 * @resource
 * @product Managed Databases
 * @category Databases
 */
export const Replica = Resource<Replica>("DigitalOcean.Databases.Replica");

export class ReplicaWaitTimedOut extends Data.TaggedError(
  "DigitalOcean.Databases.ReplicaWaitTimedOut",
)<{
  readonly name: string;
  readonly waitingFor: string;
}> {
  override get message() {
    return `Database replica ${this.name} timed out waiting for ${this.waitingFor}.`;
  }
}

// A replica takes five to ten minutes to come online (≈ 25 min budget).
const REPLICA_POLL: PollBudget = { maxDelay: "20 seconds", times: 80 };

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const observe = (clusterId: string, name: string) =>
  noneIfNotFound(
    DO.getDatabaseReplica({ database_cluster_uuid: clusterId, replica_name: name }).pipe(
      Effect.map((r) => r.replica),
    ),
  );

const toAttrs = (clusterId: string, replica: DatabaseReplicaRead) => ({
  replicaId: replica.id,
  clusterId,
  name: replica.name,
  region: replica.region,
  status: replica.status,
  host: replica.connection?.host,
  uri: toRedactedOrUndefined(replica.connection?.uri),
  privateUri: toRedactedOrUndefined(replica.private_connection?.uri),
});

export const ReplicaProvider = () =>
  Provider.succeed(Replica, {
    stables: ["replicaId", "clusterId", "name", "region"],
    read: Effect.fn(function* ({ id, olds, output }) {
      const name = output?.name ?? olds.name ?? (yield* physicalName(id));
      const clusterId = output?.clusterId ?? olds.clusterId;
      const observed = yield* observe(clusterId, name);
      return Option.getOrUndefined(Option.map(observed, (r) => toAttrs(clusterId, r)));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (
        news.clusterId !== olds.clusterId ||
        news.name !== olds.name ||
        news.size !== olds.size ||
        news.region !== olds.region ||
        news.vpcUuid !== olds.vpcUuid
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = output?.name ?? news.name ?? (yield* physicalName(id));
      const observed = yield* observe(news.clusterId, name);
      if (Option.isNone(observed)) {
        yield* waitUntilOnline(news.clusterId);
        yield* DO.createDatabaseReplica({
          database_cluster_uuid: news.clusterId,
          name,
          size: news.size,
          region: news.region,
          private_network_uuid: news.vpcUuid,
        });
      }
      const online = yield* pollUntil(observe(news.clusterId, name), {
        ...REPLICA_POLL,
        until: (o): o is Option.Some<DatabaseReplicaRead> =>
          Option.isSome(o) && o.value.status === "online",
        onTimeout: () => new ReplicaWaitTimedOut({ name, waitingFor: "the online state" }),
      });
      return toAttrs(news.clusterId, online.value);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        DO.databasesDestroyReplica({
          database_cluster_uuid: output.clusterId,
          replica_name: output.name,
        }),
      );
      yield* pollUntil(observe(output.clusterId, output.name), {
        ...REPLICA_POLL,
        until: Option.isNone,
        onTimeout: () => new ReplicaWaitTimedOut({ name: output.name, waitingFor: "deletion" }),
      });
    }),
  });
