import * as AWS from "@/AWS";
import * as Test from "../EC2/VpcTest.ts";
import { assertVpcGone } from "../EC2/Gone.ts";
import * as ElastiCache from "@distilled.cloud/aws/elasticache";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  assertReplicationGroupGone,
  cacheFixture,
} from "./ProvisionedFixture.ts";

// Separate file on purpose: this can run alongside the Valkey lifecycle
// suite while VpcTest limits the account-wide custom-VPC concurrency to three.
const { test } = Test.make({ providers: AWS.providers() });
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create, update, verify, and destroy a provisioned Redis OSS replication group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (description: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const fixture = yield* cacheFixture();
            const cache = yield* AWS.ElastiCache.ReplicationGroup("Cache", {
              description,
              engine: "redis",
              nodeType: "cache.t4g.micro",
              subnetGroupName: fixture.subnetGroup.subnetGroupName,
              securityGroupIds: [fixture.securityGroup.groupId],
              replicasPerNodeGroup: 0,
              transitEncryptionEnabled: true,
              tags: { fixture: "elasticache-provisioned-redis" },
            });
            return { cache, vpcId: fixture.network.vpcId };
          }),
        );

      const { cache, vpcId } = yield* deploy("alchemy Redis OSS cache");
      const created = yield* ElastiCache.describeReplicationGroups({
        ReplicationGroupId: cache.replicationGroupId,
      });
      expect(created.ReplicationGroups?.[0]?.Engine).toBe("redis");
      expect(created.ReplicationGroups?.[0]?.Status).toBe("available");

      const { cache: updated } = yield* deploy("alchemy Redis OSS cache v2");
      expect(updated.replicationGroupId).toBe(cache.replicationGroupId);

      yield* stack.destroy();
      yield* assertReplicationGroupGone(cache.replicationGroupId);
      yield* assertVpcGone(vpcId);
    }),
  { timeout: 2_700_000 },
);
