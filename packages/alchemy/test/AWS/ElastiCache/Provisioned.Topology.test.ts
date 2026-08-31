import * as AWS from "@/AWS";
import * as Test from "../EC2/VpcTest.ts";
import { assertVpcGone } from "../EC2/Gone.ts";
import * as ElastiCache from "@distilled.cloud/aws/elasticache";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  assertReplicationGroupGone,
  cacheFixture,
} from "./ProvisionedFixture.ts";
const { test } = Test.make({ providers: AWS.providers() });
const waitForAvailable = (replicationGroupId: string) =>
  ElastiCache.describeReplicationGroups({
    ReplicationGroupId: replicationGroupId,
  }).pipe(
    Effect.flatMap((response) =>
      response.ReplicationGroups?.[0]?.Status === "available"
        ? Effect.succeed(response.ReplicationGroups[0])
        : Effect.fail(
            new Error(
              `replication group '${replicationGroupId}' is not available`,
            ),
          ),
    ),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("15 seconds"),
        Schedule.recurs(60),
      ]),
    }),
  );

test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "adds a Valkey replica online and enables high availability",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (numNodeGroups: number, replicasPerNodeGroup: number) =>
        stack.deploy(
          Effect.gen(function* () {
            const fixture = yield* cacheFixture();
            const cache = yield* AWS.ElastiCache.ReplicationGroup("Cache", {
              description: "alchemy topology cache",
              engine: "valkey",
              nodeType: "cache.t4g.micro",
              subnetGroupName: fixture.subnetGroup.subnetGroupName,
              securityGroupIds: [fixture.securityGroup.groupId],
              numNodeGroups,
              replicasPerNodeGroup,
              automaticFailoverEnabled: replicasPerNodeGroup > 0,
              multiAzEnabled: replicasPerNodeGroup > 0,
              transitEncryptionEnabled: true,
            });
            return { cache, vpcId: fixture.network.vpcId };
          }),
        );

      const created = yield* deploy(1, 0);
      const withReplica = yield* deploy(1, 1);
      const replicaGroup = yield* waitForAvailable(
        withReplica.cache.replicationGroupId,
      );
      expect(replicaGroup.AutomaticFailover).toBe("enabled");
      expect(replicaGroup.MultiAZ).toBe("enabled");
      expect(replicaGroup.NodeGroups?.[0]?.NodeGroupMembers).toHaveLength(2);

      yield* stack.destroy();
      yield* assertReplicationGroupGone(created.cache.replicationGroupId);
      yield* assertVpcGone(created.vpcId);
    }),
  { timeout: 2_700_000 },
);

test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "scales shards online for a cluster-mode-enabled Valkey group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (numNodeGroups: number) =>
        stack.deploy(
          Effect.gen(function* () {
            const fixture = yield* cacheFixture();
            const cache = yield* AWS.ElastiCache.ReplicationGroup("Cache", {
              description: "alchemy shard topology cache",
              engine: "valkey",
              nodeType: "cache.t4g.micro",
              subnetGroupName: fixture.subnetGroup.subnetGroupName,
              securityGroupIds: [fixture.securityGroup.groupId],
              numNodeGroups,
              replicasPerNodeGroup: 0,
              transitEncryptionEnabled: true,
            });
            return { cache, vpcId: fixture.network.vpcId };
          }),
        );

      const created = yield* deploy(2);
      const scaled = yield* deploy(3);
      const group = yield* waitForAvailable(scaled.cache.replicationGroupId);
      expect(group.NodeGroups).toHaveLength(3);
      expect(
        group.NodeGroups?.every(
          (shard) => shard.NodeGroupMembers?.length === 1,
        ),
      ).toBe(true);

      yield* stack.destroy();
      yield* assertReplicationGroupGone(created.cache.replicationGroupId);
      yield* assertVpcGone(created.vpcId);
    }),
  { timeout: 2_700_000 },
);

test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "reconciles a highly available replication group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const fixture = yield* cacheFixture();
            const cache = yield* AWS.ElastiCache.ReplicationGroup("Cache", {
              description: "alchemy failover cache",
              engine: "valkey",
              nodeType: "cache.t4g.micro",
              subnetGroupName: fixture.subnetGroup.subnetGroupName,
              securityGroupIds: [fixture.securityGroup.groupId],
              replicasPerNodeGroup: 1,
              automaticFailoverEnabled: true,
              multiAzEnabled: true,
              transitEncryptionEnabled: true,
            });
            return { cache, vpcId: fixture.network.vpcId };
          }),
        );

      const { cache, vpcId } = yield* deploy();

      const before = yield* waitForAvailable(cache.replicationGroupId);
      const nodeGroupId = before.NodeGroups?.[0]?.NodeGroupId;
      if (!nodeGroupId)
        return yield* Effect.fail(
          new Error("replication group has no node group"),
        );
      yield* ElastiCache.testFailover({
        ReplicationGroupId: cache.replicationGroupId,
        NodeGroupId: nodeGroupId,
      });
      const reconciled = yield* deploy();
      expect(reconciled.cache.replicationGroupId).toBe(
        cache.replicationGroupId,
      );
      const after = yield* waitForAvailable(cache.replicationGroupId);
      expect(after.AutomaticFailover).toBe("enabled");
      expect(after.MultiAZ).toBe("enabled");
      expect(after.NodeGroups?.[0]?.NodeGroupMembers).toHaveLength(2);

      yield* stack.destroy();
      yield* assertReplicationGroupGone(cache.replicationGroupId);
      yield* assertVpcGone(vpcId);
    }),
  { timeout: 2_700_000 },
);
