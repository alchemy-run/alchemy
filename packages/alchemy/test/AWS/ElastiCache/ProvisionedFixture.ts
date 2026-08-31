import * as AWS from "@/AWS";
import * as ElastiCache from "@distilled.cloud/aws/elasticache";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/** A small owned network for every provisioned-cache lifecycle test. */
export const cacheFixture = (
  subnetGroupDescription = "alchemy provisioned cache subnets",
) =>
  Effect.gen(function* () {
    const network = yield* AWS.EC2.Network("Network", {
      cidrBlock: "10.92.0.0/16",
      availabilityZones: 2,
      nat: "none",
      tags: { fixture: "elasticache-provisioned" },
    });
    const securityGroup = yield* AWS.EC2.SecurityGroup("CacheSecurityGroup", {
      vpcId: network.vpcId,
      description: "ElastiCache integration-test cache access",
      tags: { fixture: "elasticache-provisioned" },
    });
    const subnetGroup = yield* AWS.ElastiCache.SubnetGroup("Subnets", {
      description: subnetGroupDescription,
      subnetIds: network.privateSubnetIds,
      tags: { fixture: "elasticache-provisioned" },
    });
    return { network, securityGroup, subnetGroup };
  });

export const assertReplicationGroupGone = (name: string) =>
  ElastiCache.describeReplicationGroups({ ReplicationGroupId: name }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`replication group '${name}' still exists`)),
    ),
    Effect.catchTag("ReplicationGroupNotFoundFault", () => Effect.void),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(18),
      ]),
    }),
  );

export const assertCacheClusterGone = (name: string) =>
  ElastiCache.describeCacheClusters({ CacheClusterId: name }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`cache cluster '${name}' still exists`)),
    ),
    Effect.catchTag("CacheClusterNotFoundFault", () => Effect.void),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(18),
      ]),
    }),
  );
