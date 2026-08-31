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

const { test } = Test.make({ providers: AWS.providers() });
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "updates a Valkey replication group to a newer supported engine version",
  (stack) =>
    Effect.gen(function* () {
      const versions =
        (yield* ElastiCache.describeCacheEngineVersions({
          Engine: "valkey",
        })).CacheEngineVersions?.map((version) => version.EngineVersion).filter(
          (version): version is string => version !== undefined,
        ) ?? [];
      const ordered = [...new Set(versions)].sort((left, right) =>
        left.localeCompare(right, undefined, { numeric: true }),
      );
      const sameMajorUpgrade = ordered
        .map((initialVersion, index) => [initialVersion, ordered[index + 1]])
        .find(
          ([initialVersion, updatedVersion]) =>
            updatedVersion !== undefined &&
            initialVersion.split(".")[0] === updatedVersion.split(".")[0],
        );
      const [initialVersion, updatedVersion] = sameMajorUpgrade ?? [
        ordered[0],
        ordered[1],
      ];
      if (
        !initialVersion ||
        !updatedVersion ||
        initialVersion === updatedVersion
      ) {
        return yield* Effect.fail(
          new Error(
            "AWS did not advertise two distinct Valkey engine versions",
          ),
        );
      }

      yield* stack.destroy();
      const program = (engineVersion: string) =>
        Effect.gen(function* () {
          const fixture = yield* cacheFixture();
          const cache = yield* AWS.ElastiCache.ReplicationGroup("Cache", {
            description: "alchemy engine upgrade cache",
            engine: "valkey",
            engineVersion,
            nodeType: "cache.t4g.micro",
            subnetGroupName: fixture.subnetGroup.subnetGroupName,
            securityGroupIds: [fixture.securityGroup.groupId],
            replicasPerNodeGroup: 0,
            transitEncryptionEnabled: true,
          });
          return { cache, vpcId: fixture.network.vpcId };
        });

      const created = yield* stack.deploy(program(initialVersion));
      const updated = yield* stack.deploy(program(updatedVersion));
      expect(updated.cache.replicationGroupId).toBe(
        created.cache.replicationGroupId,
      );
      const group = yield* ElastiCache.describeReplicationGroups({
        ReplicationGroupId: updated.cache.replicationGroupId,
      });
      const memberId = group.ReplicationGroups?.[0]?.MemberClusters?.[0];
      if (!memberId)
        return yield* Effect.fail(
          new Error("replication group has no member cluster"),
        );
      const member = yield* ElastiCache.describeCacheClusters({
        CacheClusterId: memberId,
      });
      // The API accepts a major/minor target such as `9.1`, but reports the
      // fully resolved patch release (for example `9.1.0`).
      expect(
        member.CacheClusters?.[0]?.EngineVersion?.startsWith(updatedVersion),
      ).toBe(true);

      yield* stack.destroy();
      yield* assertReplicationGroupGone(updated.cache.replicationGroupId);
      yield* assertVpcGone(updated.vpcId);
    }),
  { timeout: 2_700_000 },
);
