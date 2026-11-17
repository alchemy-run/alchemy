import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as rds from "@distilled.cloud/aws/rds";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:rds", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "RdsLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const { region } = yield* AWSEnvironment.current;
    const vpc = yield* AWS.EC2.Vpc("lookup-vpc", { cidrBlock: "10.47.0.0/16" });
    const subnetA = yield* AWS.EC2.Subnet("lookup-subnet-a", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.47.1.0/24",
      availabilityZone: `${region}a`,
    });
    const subnetB = yield* AWS.EC2.Subnet("lookup-subnet-b", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.47.2.0/24",
      availabilityZone: `${region}b`,
    });
    const subnetIds = [subnetA.subnetId, subnetB.subnetId];
    const subnetGroup = yield* AWS.RDS.DBSubnetGroup("lookup-subnet-group", {
      description: "lookup target",
      subnetIds,
    });
    const parameterGroup = yield* AWS.RDS.DBParameterGroup("lookup-parameter-group", {
      family: "postgres16",
      description: "lookup target",
    });
    const clusterParameterGroup = yield* AWS.RDS.DBClusterParameterGroup(
      "lookup-cluster-parameter-group",
      {
        family: "aurora-postgresql16",
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
            subnets: AWS.RDS.DBSubnetGroup.lookup({ dbSubnetGroupName: subnetGroupName })
              .dbSubnetGroupName,
            parameters: AWS.RDS.DBParameterGroup.lookup({
              dbParameterGroupName: parameterGroupName,
            }).dbParameterGroupName,
            clusterParameters: AWS.RDS.DBClusterParameterGroup.lookup({
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
      const { DBParameterGroups } = yield* rds.describeDBParameterGroups({
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
        "missing-instance": AWS.RDS.DBInstance.lookup({ dbInstanceIdentifier: name }).dbInstanceArn,
        "missing-cluster": AWS.RDS.DBCluster.lookup({ dbClusterIdentifier: name }).dbClusterArn,
        "missing-proxy": AWS.RDS.DBProxy.lookup({ dbProxyName: name }).dbProxyArn,
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
        AWS.RDS.DBParameterGroup("lookup-managed", {
          family: "postgres16",
          description: "lookup target",
        });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-subnet-group-consumer", {
              value: AWS.RDS.DBParameterGroup.lookup({
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
