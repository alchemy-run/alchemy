import * as EC2 from "@alchemy.run/aws/EC2";
import * as RDS from "@alchemy.run/aws/RDS";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { clusterShardGroups, Database as ClusterDatabase } from "../Database.ts";
import { RUNNER_PORT } from "../internal/Gateway.ts";
import type { Providers } from "../Providers.ts";

export interface DatabaseProps {
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
   * IPv4 CIDR block of the cluster's VPC.
   * @default "10.44.0.0/16"
   */
  cidrBlock?: string;
}

/**
 * The database an Effect Cluster coordinates through, on AWS, as a
 * `Cluster.Database` Layer: Postgres on RDS, in a VPC of its own that the
 * runners join. Every runner joins one security group, which reaches the
 * database and the other runners on the runner port; nothing else does.
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
 * @primitive
 */
export const Database = (id: string, props: DatabaseProps = {}) =>
  Layer.effect(
    ClusterDatabase,
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) {
        // Runners read their database from their own environment at runtime.
        return { url: Redacted.make(""), shardGroups: undefined as never };
      }
      const network = yield* EC2.Network(`${id}Network`, {
        cidrBlock: props.cidrBlock ?? "10.44.0.0/16",
        availabilityZones: 2,
      });
      const runners = yield* EC2.SecurityGroup(`${id}RunnersGroup`, {
        vpcId: network.vpcId,
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
        vpcId: network.vpcId,
        description: "Effect Cluster database",
        ingress: [
          { ipProtocol: "tcp", fromPort: 5432, toPort: 5432, referencedGroupId: runners.groupId },
        ],
        egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
      });
      const subnets = yield* RDS.DBSubnetGroup(`${id}Subnets`, {
        description: "Effect Cluster database",
        subnetIds: network.publicSubnetIds,
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
          subnetIds: network.publicSubnetIds,
          securityGroupId: runners.groupId,
        },
        shardGroups: yield* clusterShardGroups(id),
      };
    }),
  );
