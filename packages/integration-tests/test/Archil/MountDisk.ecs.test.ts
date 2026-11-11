import * as Archil from "@alchemy.run/archil";
import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Objects from "@distilled.cloud/archil/Objects";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../AWS/DefaultVpc.ts";
import MountTask, { ECS_MARKER_KEY, ECS_MARKER_TEXT, EcsDisk } from "./fixtures/mount-task.ts";

const providers = Layer.mergeAll(Archil.providers(), AWS.providers());
const { test } = Test.make({ providers });

/**
 * One EC2 container instance in the default VPC, registered with the
 * cluster by its user data. Fargate has no FUSE, so mounts need EC2.
 */
const EcsHost = Effect.gen(function* () {
  const cluster = yield* AWS.ECS.Cluster("ArchilMountCluster", {});
  const role = yield* AWS.IAM.Role("ArchilMountHostRole", {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: ["ec2.amazonaws.com"] },
          Action: ["sts:AssumeRole"],
        },
      ],
    },
    managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"],
  });
  const profile = yield* AWS.IAM.InstanceProfile("ArchilMountHostProfile", {
    roleName: role.roleName,
  });
  yield* AWS.EC2.Instance("ArchilMountHost", {
    imageId: AWS.EC2.image({ owners: ["amazon"], name: ["al2023-ami-ecs-hvm-*-x86_64"] }),
    instanceType: "t3.medium",
    instanceProfileName: profile.instanceProfileName,
    userData: Output.interpolate`#!/bin/bash
echo ECS_CLUSTER=${cluster.clusterName} >> /etc/ecs/ecs.config
`,
  });
  return cluster;
});

test.provider.skipIf(!!process.env.FAST)(
  "an ECS task on EC2 mounts a disk with its own disk user and writes through it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* getDefaultVpc;

      const { cluster, task, disk } = yield* stack.deploy(
        Effect.gen(function* () {
          const disk = yield* EcsDisk;
          const cluster = yield* EcsHost;
          const task = yield* MountTask;
          return { cluster, task, disk };
        }),
      );

      // The instance boots and its ECS agent registers with the cluster.
      yield* ecs.listContainerInstances({ cluster: cluster.clusterName }).pipe(
        Effect.map((r) => r.containerInstanceArns ?? []),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (arns) => arns.length > 0,
          times: 36,
        }),
      );

      const started = yield* ecs.runTask({
        cluster: cluster.clusterName,
        taskDefinition: task.taskDefinitionArn,
        launchType: "EC2",
        count: 1,
      });
      expect(started.failures ?? []).toEqual([]);
      const taskArn = started.tasks?.[0]?.taskArn;
      expect(taskArn).toMatch(/^arn:aws:ecs:/);

      const stopped = yield* ecs
        .describeTasks({ cluster: cluster.clusterName, tasks: [taskArn!] })
        .pipe(
          Effect.map((r) => r.tasks?.[0]),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (t) => t?.lastStatus === "STOPPED",
            times: 48,
          }),
        );
      const container = stopped?.containers?.find((c) => c.name === task.containerName);
      // The reason rides along so a failed mount shows why the task stopped.
      expect({ exitCode: container?.exitCode, reason: container?.reason }).toEqual({
        exitCode: 0,
        reason: undefined,
      });

      // The write landed on the disk, read back over the object API.
      const text = yield* Objects.getObjectText({ disk: disk.diskId }, ECS_MARKER_KEY).pipe(
        Effect.provide(Objects.ObjectCredentialsFromApiKey),
      );
      expect(text).toBe(ECS_MARKER_TEXT);

      yield* stack.destroy();

      const after = yield* ecs.describeClusters({ clusters: [cluster.clusterName] });
      expect((after.clusters ?? []).filter((c) => c.status === "ACTIVE")).toEqual([]);
    }),
  {
    tags: ["provider:archil", "provider:aws", "provider:aws:ecs", "live"],
    timeout: 900_000,
  },
);
