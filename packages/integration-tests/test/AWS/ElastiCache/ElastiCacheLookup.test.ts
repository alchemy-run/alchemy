import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as elasticache from "@distilled.cloud/aws/elasticache";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:elasticache", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "ElastiCacheLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const { region } = yield* AWSEnvironment.current;
    const vpc = yield* AWS.EC2.Vpc("lookup-vpc", { cidrBlock: "10.53.0.0/16" });
    const subnetA = yield* AWS.EC2.Subnet("lookup-subnet-a", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.53.1.0/24",
      availabilityZone: `${region}a`,
    });
    const subnetB = yield* AWS.EC2.Subnet("lookup-subnet-b", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.53.2.0/24",
      availabilityZone: `${region}b`,
    });
    const subnetIds = [subnetA.subnetId, subnetB.subnetId];
    const subnetGroup = yield* AWS.ElastiCache.SubnetGroup("lookup-subnet-group", {
      description: "lookup target",
      subnetIds,
    });
    return {
      subnetGroupName: subnetGroup.subnetGroupName.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "subnet and parameter groups resolve by name, and survive destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { subnetGroupName } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return {
            subnets: AWS.ElastiCache.SubnetGroup.lookup({ subnetGroupName: subnetGroupName })
              .subnetGroupName,
          };
        },
        {
          subnets: subnetGroupName,
        },
      );
      const { CacheSubnetGroups } = yield* elasticache.describeCacheSubnetGroups({
        CacheSubnetGroupName: subnetGroupName,
      });
      expect(CacheSubnetGroups?.[0]?.CacheSubnetGroupName).toBe(subnetGroupName);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing cache or cluster fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-replication": AWS.ElastiCache.ReplicationGroup.lookup({ replicationGroupId: name })
          .replicationGroupArn,
        "missing-cluster": AWS.ElastiCache.CacheCluster.lookup({ cacheClusterId: name })
          .cacheClusterArn,
        "missing-serverless": AWS.ElastiCache.ServerlessCache.lookup({ serverlessCacheName: name })
          .serverlessCacheArn,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(stack.deploy(AWS.SSM.Parameter(id, { value })), [
          "LookupNotFoundError",
        ]);
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 240_000 },
);
