import type { Input } from "alchemy/Input";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { Providers } from "./Providers.ts";
import { ShardGroups } from "./ShardGroups.ts";

/**
 * The private network runners must join to reach the database and each
 * other. A pool Layer matches on `kind` and refuses a network it cannot
 * join.
 */
export type ClusterNetwork =
  | {
      /** A Docker network; runner containers join it by name. */
      readonly kind: "docker";
      readonly name: Input<string>;
    }
  | {
      /** An AWS VPC; runners run in its subnets, in the pool's security group. */
      readonly kind: "aws";
      readonly vpcId: Input<string>;
      readonly subnetIds: Input<string>[];
      /** The group every runner joins: it reaches the database and the other runners. */
      readonly securityGroupId: Input<string>;
    }
  | {
      /** A Fly private network; runners' Apps join it by name. */
      readonly kind: "fly";
      readonly network: Input<string>;
    }
  | {
      /** A Hetzner private Network; runners' Servers attach to it. */
      readonly kind: "hetzner";
      readonly networkId: Input<number>;
      /** Its IPv4 range, where each runner finds its own address. */
      readonly ipRange: string;
      readonly location: string;
    }
  | {
      /** A GCP VPC; runners' instances join its subnetwork. */
      readonly kind: "gcp";
      readonly network: Input<string>;
      readonly subnetwork: Input<string>;
      readonly region: string;
      /** The subnetwork's IPv4 range, where each runner finds its own address. */
      readonly cidr: string;
      /** The network tag every runner carries: it reaches the database and the other runners. */
      readonly tag: string;
    }
  | {
      /** A Kubernetes cluster; runners run as a Deployment in its namespace. */
      readonly kind: "kubernetes";
      /** The cluster, as `@alchemy.run/kubernetes` takes it. */
      readonly cluster: unknown;
      readonly namespace: string;
    };

/** What every database Layer gives the pool it is provided to. */
export interface DatabaseShape {
  /**
   * The Postgres connection URL runners use for runner registration,
   * shard locks and persisted messages.
   */
  readonly url: Input<Redacted.Redacted<string>>;
  /** The network runners join to reach it, when it is private. */
  readonly network?: ClusterNetwork;
  /** Every shard group in the cluster, which each pool registers with. */
  readonly shardGroups: ShardGroups;
}

/**
 * The database an Effect Cluster coordinates through: runners register in
 * it, lock their shards in it, and keep persisted messages in it. Each
 * host's `Database` Layer provides it.
 */
export class Database extends Context.Service<Database, DatabaseShape>()("Cluster.Database") {}

export interface DatabaseProps {
  /** A Postgres connection URL. */
  url: Redacted.Redacted<string> | Config.Config<Redacted.Redacted<string>>;
}

/**
 * A Postgres database you already run, as an Effect Cluster `Database`
 * Layer: Neon, PlanetScale, RDS, or any Postgres the pool can reach.
 *
 * ### Using an existing database
 * **Example:** A Postgres URL from config
 * ```typescript
 * export const Database = Cluster.Database.fromUrl({
 *   url: Config.Redacted("CLUSTER_DATABASE_URL"),
 * });
 * ```
 *
 * @primitive
 */
export const fromUrl = (
  props: DatabaseProps,
): Layer.Layer<Database, Config.ConfigError, Providers> =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) {
        // Runners read their database from their own environment at runtime.
        return { url: Redacted.make(""), shardGroups: undefined as never };
      }
      const url = Config.isConfig(props.url) ? yield* props.url : props.url;
      return { url, shardGroups: yield* clusterShardGroups("Database") };
    }),
  );

/** The shard groups resource every database Layer declares for its cluster. @internal */
export const clusterShardGroups = (id: string) => ShardGroups(`${id}ShardGroups`, {});
