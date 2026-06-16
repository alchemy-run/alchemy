import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import { Task } from "@/AWS/ECS/Task.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as ecs from "@distilled.cloud/aws/ecs";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Deploying a full `Task` requires a Docker build + ECR push, which is far too
// heavy for a `list()` test. Instead we register a task definition out-of-band
// in the exact shape the provider produces (single container whose image is an
// ECR `<repoUri>:<hash>`, task/execution role ARNs, an awslogs log group), then
// assert `list()` reconstructs the full Attributes and includes it, and finally
// deregister it. This live-verifies the listTaskDefinitions -> describe ->
// Attributes reconstruction path without the container build overhead.
test.provider(
  "list enumerates registered task definitions",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;

      const family = "alchemy-test-ecs-task-list";
      const repositoryName = "alchemy-test-ecs-task-list-repo";
      const repositoryUri = `${accountId}.dkr.ecr.${region}.amazonaws.com/${repositoryName}`;
      const hash = "listtest";
      const imageUri = `${repositoryUri}:${hash}`;
      const logGroupName = "/alchemy/test/ecs-task-list";
      const taskRoleName = "alchemy-test-ecs-task-list-task-role";
      const executionRoleName = "alchemy-test-ecs-task-list-execution-role";

      const registered = yield* ecs.registerTaskDefinition({
        family,
        taskRoleArn: `arn:aws:iam::${accountId}:role/${taskRoleName}`,
        executionRoleArn: `arn:aws:iam::${accountId}:role/${executionRoleName}`,
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        cpu: "256",
        memory: "512",
        containerDefinitions: [
          {
            name: family,
            image: imageUri,
            essential: true,
            portMappings: [
              { containerPort: 3000, hostPort: 3000, protocol: "tcp" },
            ],
            logConfiguration: {
              logDriver: "awslogs",
              options: {
                "awslogs-group": logGroupName,
                "awslogs-region": region,
                "awslogs-stream-prefix": family,
              },
            },
          },
        ],
      });
      const arn = registered.taskDefinition?.taskDefinitionArn;
      expect(arn).toBeDefined();

      const provider = yield* Provider.findProvider(Task);
      const all = yield* provider.list();

      const found = all.find((t) => t.taskDefinitionArn === arn);
      expect(found).toBeDefined();
      expect(found?.taskFamily).toBe(family);
      expect(found?.containerName).toBe(family);
      expect(found?.port).toBe(3000);
      expect(found?.imageUri).toBe(imageUri);
      expect(found?.repositoryName).toBe(repositoryName);
      expect(found?.repositoryUri).toBe(repositoryUri);
      expect(found?.code.hash).toBe(hash);
      expect(found?.logGroupName).toBe(logGroupName);
      expect(found?.logGroupArn).toBe(
        `arn:aws:logs:${region}:${accountId}:log-group:${logGroupName}`,
      );
      expect(found?.taskRoleName).toBe(taskRoleName);
      expect(found?.executionRoleName).toBe(executionRoleName);

      yield* ecs
        .deregisterTaskDefinition({ taskDefinition: arn! })
        .pipe(Effect.catchTag("ClientException", () => Effect.void));
    }),
  { timeout: 240_000 },
);
