import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as docdb from "@distilled.cloud/aws/docdb";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:docdb", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "DocDBLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const { region } = yield* AWSEnvironment.current;
    const vpc = yield* AWS.EC2.Vpc("lookup-vpc", { cidrBlock: "10.49.0.0/16" });
    const subnetA = yield* AWS.EC2.Subnet("lookup-subnet-a", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.49.1.0/24",
      availabilityZone: `${region}a`,
    });
    const subnetB = yield* AWS.EC2.Subnet("lookup-subnet-b", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.49.2.0/24",
      availabilityZone: `${region}b`,
    });
    const subnetIds = [subnetA.subnetId, subnetB.subnetId];
    const subnetGroup = yield* AWS.DocDB.DBSubnetGroup("lookup-subnet-group", {
      description: "lookup target",
      subnetIds,
    });
    return {
      subnetGroupName: subnetGroup.dbSubnetGroupName.as<string>(),
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
            subnets: AWS.DocDB.DBSubnetGroup.lookup({ dbSubnetGroupName: subnetGroupName })
              .dbSubnetGroupName,
          };
        },
        {
          subnets: subnetGroupName,
        },
      );
      const { DBSubnetGroups } = yield* docdb.describeDBSubnetGroups({
        DBSubnetGroupName: subnetGroupName,
      });
      expect(DBSubnetGroups?.[0]?.DBSubnetGroupName).toBe(subnetGroupName);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing cluster or instance fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-instance": AWS.DocDB.DBInstance.lookup({ dbInstanceIdentifier: name })
          .dbInstanceArn,
        "missing-cluster": AWS.DocDB.DBCluster.lookup({ dbClusterIdentifier: name }).dbClusterArn,
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
