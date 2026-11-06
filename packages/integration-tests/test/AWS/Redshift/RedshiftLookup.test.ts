import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as redshift from "@distilled.cloud/aws/redshift";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:redshift", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "RedshiftLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const { region } = yield* AWSEnvironment.current;
    const vpc = yield* AWS.EC2.Vpc("lookup-vpc", { cidrBlock: "10.50.0.0/16" });
    const subnetA = yield* AWS.EC2.Subnet("lookup-subnet-a", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.50.1.0/24",
      availabilityZone: `${region}a`,
    });
    const subnetB = yield* AWS.EC2.Subnet("lookup-subnet-b", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.50.2.0/24",
      availabilityZone: `${region}b`,
    });
    const subnetIds = [subnetA.subnetId, subnetB.subnetId];
    const subnetGroup = yield* AWS.Redshift.ClusterSubnetGroup("lookup-subnet-group", {
      description: "lookup target",
      subnetIds,
    });
    const parameterGroup = yield* AWS.Redshift.ClusterParameterGroup("lookup-parameter-group", {
      family: "redshift-2.0",
      description: "lookup target",
    });
    return {
      subnetGroupName: subnetGroup.clusterSubnetGroupName.as<string>(),
      parameterGroupName: parameterGroup.clusterParameterGroupName.as<string>(),
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
            subnets: AWS.Redshift.ClusterSubnetGroup.lookup({
              clusterSubnetGroupName: subnetGroupName,
            }).clusterSubnetGroupName,
            parameters: AWS.Redshift.ClusterParameterGroup.lookup({
              clusterParameterGroupName: parameterGroupName,
            }).clusterParameterGroupName,
          };
        },
        {
          subnets: subnetGroupName,
          parameters: parameterGroupName,
        },
      );
      const { ParameterGroups } = yield* redshift.describeClusterParameterGroups({
        ParameterGroupName: parameterGroupName,
      });
      expect(ParameterGroups?.[0]?.ParameterGroupName).toBe(parameterGroupName);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing cluster, namespace or workgroup fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-cluster": AWS.Redshift.Cluster.lookup({ clusterIdentifier: name }).clusterArn,
        "missing-namespace": AWS.RedshiftServerless.Namespace.lookup({ namespaceName: name })
          .namespaceArn,
        "missing-workgroup": AWS.RedshiftServerless.Workgroup.lookup({ workgroupName: name })
          .workgroupArn,
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
        AWS.Redshift.ClusterParameterGroup("lookup-managed", {
          family: "redshift-2.0",
          description: "lookup target",
        });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-subnet-group-consumer", {
              value: AWS.Redshift.ClusterParameterGroup.lookup({
                clusterParameterGroupName: attrs.clusterParameterGroupName,
              }).clusterParameterGroupName,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 240_000 },
);
