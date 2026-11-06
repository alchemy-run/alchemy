import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as neptune from "@distilled.cloud/aws/neptune";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:neptune", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "NeptuneLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const { region } = yield* AWSEnvironment.current;
    const vpc = yield* AWS.EC2.Vpc("lookup-vpc", { cidrBlock: "10.48.0.0/16" });
    const subnetA = yield* AWS.EC2.Subnet("lookup-subnet-a", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.48.1.0/24",
      availabilityZone: `${region}a`,
    });
    const subnetB = yield* AWS.EC2.Subnet("lookup-subnet-b", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.48.2.0/24",
      availabilityZone: `${region}b`,
    });
    const subnetIds = [subnetA.subnetId, subnetB.subnetId];
    const subnetGroup = yield* AWS.Neptune.DBSubnetGroup("lookup-subnet-group", {
      description: "lookup target",
      subnetIds,
    });
    const parameterGroup = yield* AWS.Neptune.DBParameterGroup("lookup-parameter-group", {
      family: "neptune1.3",
      description: "lookup target",
    });
    const clusterParameterGroup = yield* AWS.Neptune.DBClusterParameterGroup(
      "lookup-cluster-parameter-group",
      {
        family: "neptune1.3",
        description: "lookup target",
      },
    );
    return {
      subnetGroupName: subnetGroup.dbSubnetGroupName.as<string>(),
      parameterGroupName: parameterGroup.dbParameterGroupName.as<string>(),
      clusterParameterGroupName: clusterParameterGroup.dbClusterParameterGroupName.as<string>(),
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
      const { subnetGroupName, parameterGroupName, clusterParameterGroupName } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return {
            subnets: AWS.Neptune.DBSubnetGroup.lookup({ dbSubnetGroupName: subnetGroupName })
              .dbSubnetGroupName,
            parameters: AWS.Neptune.DBParameterGroup.lookup({
              dbParameterGroupName: parameterGroupName,
            }).dbParameterGroupName,
            clusterParameters: AWS.Neptune.DBClusterParameterGroup.lookup({
              dbClusterParameterGroupName: clusterParameterGroupName,
            }).dbClusterParameterGroupName,
          };
        },
        {
          subnets: subnetGroupName,
          parameters: parameterGroupName,
          clusterParameters: clusterParameterGroupName,
        },
      );
      const { DBParameterGroups } = yield* neptune.describeDBParameterGroups({
        DBParameterGroupName: parameterGroupName,
      });
      expect(DBParameterGroups?.[0]?.DBParameterGroupName).toBe(parameterGroupName);
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
        "missing-instance": AWS.Neptune.DBInstance.lookup({ dbInstanceIdentifier: name })
          .dbInstanceArn,
        "missing-cluster": AWS.Neptune.DBCluster.lookup({ dbClusterIdentifier: name }).dbClusterArn,
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
        AWS.Neptune.DBParameterGroup("lookup-managed", {
          family: "neptune1.3",
          description: "lookup target",
        });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-subnet-group-consumer", {
              value: AWS.Neptune.DBParameterGroup.lookup({
                dbParameterGroupName: attrs.dbParameterGroupName,
              }).dbParameterGroupName,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 240_000 },
);
