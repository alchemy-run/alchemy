import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:ecs", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "EcsLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const cluster = yield* AWS.ECS.Cluster("lookup-target");
    const task = yield* AWS.ECS.TaskDefinition("lookup-target-task", {
      containerDefinitions: [
        { name: "app", image: "public.ecr.aws/docker/library/busybox:stable", essential: true },
      ],
    });
    return {
      clusterName: cluster.clusterName.as<string>(),
      clusterArn: cluster.clusterArn.as<string>(),
      family: task.family.as<string>(),
      taskDefinitionArn: task.taskDefinitionArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up cluster resolves by name and by ARN, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { clusterName, clusterArn, family, taskDefinitionArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const byName = AWS.ECS.Cluster.lookup({ clusterName });
          const byArn = AWS.ECS.Cluster.lookup({ clusterName: clusterArn });
          return { arn: byName.clusterArn, name: byArn.clusterName };
        },
        {
          arn: clusterArn,
          name: clusterName,
        },
      );
      const { clusters } = yield* ecs.describeClusters({ clusters: [clusterArn] });
      expect(clusters?.[0]?.status).toBe("ACTIVE");
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a looked-up task definition resolves to its latest active revision",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { clusterName, clusterArn, family, taskDefinitionArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const task = AWS.ECS.TaskDefinition.lookup({ family });
          return { arn: task.taskDefinitionArn };
        },
        {
          arn: taskDefinitionArn,
        },
      );
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing cluster fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-cluster", {
            value: AWS.ECS.Cluster.lookup({ clusterName: name }).clusterArn,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a cluster this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.ECS.Cluster("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-cluster-consumer", {
              value: AWS.ECS.Cluster.lookup({ clusterName: attrs.clusterName }).clusterArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
