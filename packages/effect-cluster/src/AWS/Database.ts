import * as EC2 from "@alchemy.run/aws/EC2";
import * as RDS from "@alchemy.run/aws/RDS";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { clusterShardGroups, Database as ClusterDatabase } from "../Database.ts";
import { RUNNER_PORT } from "../internal/Gateway.ts";
import type { Providers } from "../Providers.ts";
import { resolveNetwork } from "./internal/Network.ts";
import type { Network, NetworkInput } from "./Network.ts";

export interface DatabaseProps<E = never, R = never> {
  /**
   * RDS instance class.
   * @default "db.t4g.micro"
   */
  instanceClass?: string;
  /**
   * Postgres major version.
   * @default "17"
   */
  engineVersion?: string;
  /**
   * Storage, in GiB.
   * @default 20
   */
  allocatedStorage?: number;
  /**
   * Run a standby in a second Availability Zone.
   * @default false
   */
  multiAZ?: boolean;
  /**
   * IPv4 CIDR block of the VPC the database creates. Ignored with a
   * `network`.
   * @default "10.44.0.0/16"
   */
  cidrBlock?: string;
  /**
   * The VPC the database, the runners and their gateways run in, by id, or
   * an Effect that yields the resources the ids come from and returns
   * them. When omitted, the database creates a VPC of its own, with public
   * subnets and no NAT gateway.
   */
  network?: NetworkInput<Network, E, R>;
}

/** A VPC of the database's own: public subnets, where runners take public IPs. */
const ownNetwork = Effect.fn(function* (id: string, cidrBlock: string) {
  const network = yield* EC2.Network(`${id}Network`, { cidrBlock, availabilityZones: 2 });
  return {
    vpcId: network.vpcId,
    subnetIds: network.publicSubnetIds,
    cidrBlock: network.vpc.cidrBlock,
    assignPublicIp: true,
  } satisfies Network;
});

/**
 * The database an Effect Cluster coordinates through, on AWS, as a
 * `Cluster.Database` Layer: Postgres on RDS, in a VPC of its own or the one
 * you give it, which the runners join. Every runner joins one security
 * group, which reaches the database and the other runners on the runner
 * port; nothing else does.
 *
 * ### Running the database on RDS
 * **Example:** Postgres for the cluster
 * ```typescript
 * export const Database = ClusterAWS.Database("Cluster");
 * ```
 *
 * **Example:** A larger instance with a standby
 * ```typescript
 * export const Database = ClusterAWS.Database("Cluster", {
 *   instanceClass: "db.m7g.large",
 *   multiAZ: true,
 * });
 * ```
 *
 * ### Running in your own VPC
 * Give the database a `network` by id: the database, the runners and their
 * gateways run in its `subnetIds`. Runners take public IPs unless
 * `assignPublicIp` is `false`, as in private subnets behind a NAT gateway.
 *
 * **Example:** A VPC nobody manages
 * ```typescript
 * const vpc = EC2.Vpc.lookup({ name: "shared" });
 * const a = EC2.Subnet.lookup({ name: "private-a" });
 * const b = EC2.Subnet.lookup({ name: "private-b" });
 *
 * export const Database = ClusterAWS.Database("Cluster", {
 *   network: {
 *     vpcId: vpc.vpcId,
 *     subnetIds: [a.subnetId, b.subnetId],
 *     cidrBlock: vpc.cidrBlock,
 *     assignPublicIp: false,
 *   },
 * });
 * ```
 *
 * A declaration or another stack's resource is an Effect: yield it in an
 * Effect that returns the network.
 *
 * **Example:** A network declared in the same stack
 * ```typescript
 * export const AppNetwork = EC2.Network("App", {
 *   cidrBlock: "10.42.0.0/16",
 *   nat: "single",
 * });
 *
 * export const Database = ClusterAWS.Database("Cluster", {
 *   network: Effect.gen(function* () {
 *     const network = yield* AppNetwork;
 *     return {
 *       vpcId: network.vpcId,
 *       subnetIds: network.privateSubnetIds,
 *       publicSubnetIds: network.publicSubnetIds,
 *       cidrBlock: network.vpc.cidrBlock,
 *       assignPublicIp: false,
 *     };
 *   }),
 * });
 * ```
 *
 * **Example:** A VPC another stack owns
 * ```typescript
 * export const Database = ClusterAWS.Database("Cluster", {
 *   network: Effect.gen(function* () {
 *     const vpc = yield* EC2.Vpc.ref("AppVpc", { stack: "network" });
 *     const a = yield* EC2.Subnet.ref("PrivateSubnetA", { stack: "network" });
 *     const b = yield* EC2.Subnet.ref("PrivateSubnetB", { stack: "network" });
 *     return {
 *       vpcId: vpc.vpcId,
 *       subnetIds: [a.subnetId, b.subnetId],
 *       cidrBlock: vpc.cidrBlock,
 *       assignPublicIp: false,
 *     };
 *   }),
 * });
 * ```
 *
 * @primitive
 */
export const Database = <E = never, R = never>(id: string, props: DatabaseProps<E, R> = {}) =>
  Layer.effect(
    ClusterDatabase,
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) {
        // Runners read their database from their own environment at runtime.
        return { url: Redacted.make(""), shardGroups: undefined as never };
      }
      const network: Network =
        props.network === undefined
          ? yield* ownNetwork(id, props.cidrBlock ?? "10.44.0.0/16")
          : yield* resolveNetwork(props.network);
      const vpcId = network.vpcId as Input<EC2.VpcId>;
      const runners = yield* EC2.SecurityGroup(`${id}RunnersGroup`, {
        vpcId,
        description: "Effect Cluster runners",
        egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
      });
      // Runners send each other messages for the shards they own.
      yield* EC2.SecurityGroupRule(`${id}RunnerPeers`, {
        groupId: runners.groupId,
        type: "ingress",
        ipProtocol: "tcp",
        fromPort: RUNNER_PORT,
        toPort: RUNNER_PORT,
        referencedGroupId: runners.groupId,
      });
      const databaseGroup = yield* EC2.SecurityGroup(`${id}DatabaseGroup`, {
        vpcId,
        description: "Effect Cluster database",
        ingress: [
          { ipProtocol: "tcp", fromPort: 5432, toPort: 5432, referencedGroupId: runners.groupId },
        ],
        egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
      });
      const subnets = yield* RDS.DBSubnetGroup(`${id}Subnets`, {
        description: "Effect Cluster database",
        subnetIds: [...network.subnetIds] as Input<EC2.SubnetId>[],
      });
      const password = yield* Random(`${id}Password`, { bytes: 24 }) as unknown as Effect.Effect<
        Random,
        never,
        Providers
      >;
      const instance = yield* RDS.DBInstance(`${id}Postgres`, {
        engine: "postgres",
        engineVersion: props.engineVersion ?? "17",
        dbInstanceClass: props.instanceClass ?? "db.t4g.micro",
        allocatedStorage: props.allocatedStorage ?? 20,
        dbName: "effect_cluster",
        masterUsername: "effect",
        masterUserPassword: password.text,
        multiAZ: props.multiAZ ?? false,
        dbSubnetGroupName: subnets.dbSubnetGroupName,
        vpcSecurityGroupIds: [databaseGroup.groupId],
        publiclyAccessible: false,
        storageEncrypted: true,
        skipFinalSnapshot: true,
      });
      return {
        // RDS requires TLS. Runners verify the certificate against the RDS
        // certificate authority their image trusts (`ClusterAWS.EcsPool`).
        url: Output.all(instance.endpointAddress, instance.endpointPort, password.text).pipe(
          Output.map(([host, port, text]) =>
            Redacted.make(
              `postgres://effect:${encodeURIComponent(text.pipe(Redacted.value))}@${host}:${port ?? 5432}/effect_cluster?sslmode=require`,
            ),
          ),
        ),
        network: {
          kind: "aws" as const,
          vpcId: network.vpcId,
          subnetIds: [...network.subnetIds],
          publicSubnetIds: network.publicSubnetIds && [...network.publicSubnetIds],
          securityGroupId: runners.groupId,
          cidrBlock: network.cidrBlock,
          assignPublicIp: network.assignPublicIp,
        },
        shardGroups: yield* clusterShardGroups(id),
      };
    }),
  );
