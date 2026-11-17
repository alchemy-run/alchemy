import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as memorydb from "@distilled.cloud/aws/memorydb";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:memorydb", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "MemoryDBLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const { region } = yield* AWSEnvironment.current;
    const vpc = yield* AWS.EC2.Vpc("lookup-vpc", { cidrBlock: "10.52.0.0/16" });
    const subnetA = yield* AWS.EC2.Subnet("lookup-subnet-a", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.52.1.0/24",
      availabilityZone: `${region}a`,
    });
    const subnetB = yield* AWS.EC2.Subnet("lookup-subnet-b", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.52.2.0/24",
      availabilityZone: `${region}b`,
    });
    const subnetIds = [subnetA.subnetId, subnetB.subnetId];
    const subnetGroup = yield* AWS.MemoryDB.SubnetGroup("lookup-subnet-group", {
      description: "lookup target",
      subnetIds,
    });
    const parameterGroup = yield* AWS.MemoryDB.ParameterGroup("lookup-parameter-group", {
      family: "memorydb_valkey7",
      description: "lookup target",
    });
    return {
      subnetGroupName: subnetGroup.subnetGroupName.as<string>(),
      parameterGroupName: parameterGroup.parameterGroupName.as<string>(),
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
      const { subnetGroupName, parameterGroupName } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return {
            subnets: AWS.MemoryDB.SubnetGroup.lookup({ subnetGroupName: subnetGroupName })
              .subnetGroupName,
            parameters: AWS.MemoryDB.ParameterGroup.lookup({
              parameterGroupName: parameterGroupName,
            }).parameterGroupName,
          };
        },
        {
          subnets: subnetGroupName,
          parameters: parameterGroupName,
        },
      );
      const { SubnetGroups } = yield* memorydb.describeSubnetGroups({
        SubnetGroupName: subnetGroupName,
      });
      expect(SubnetGroups?.[0]?.Name).toBe(subnetGroupName);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing cluster, ACL or user fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-cluster": AWS.MemoryDB.Cluster.lookup({ clusterName: name }).clusterArn,
        "missing-acl": AWS.MemoryDB.ACL.lookup({ aclName: name }).aclArn,
        "missing-user": AWS.MemoryDB.User.lookup({ userName: name }).userArn,
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

test.provider(
  "a lookup of a parameter group this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        AWS.MemoryDB.ParameterGroup("lookup-managed", {
          family: "memorydb_valkey7",
          description: "lookup target",
        });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-subnet-group-consumer", {
              value: AWS.MemoryDB.ParameterGroup.lookup({
                parameterGroupName: attrs.parameterGroupName,
              }).parameterGroupName,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 240_000 },
);
