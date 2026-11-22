import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as batch from "@distilled.cloud/aws/batch";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";
import { BatchTestNetwork } from "./TestNetwork.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:batch", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "BatchLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const network = yield* BatchTestNetwork;
    const environment = yield* AWS.Batch.ComputeEnvironment("lookup-target-env", {
      subnets: network.subnetIds,
      securityGroupIds: network.securityGroupIds,
    });
    const queue = yield* AWS.Batch.JobQueue("lookup-target-queue", {
      computeEnvironments: [environment.computeEnvironmentArn],
    });
    const executionRole = yield* AWS.IAM.Role("lookup-target-execution", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ecs-tasks.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"],
    });
    const job = yield* AWS.Batch.JobDefinition("lookup-target-job", {
      image: "public.ecr.aws/docker/library/busybox:latest",
      executionRoleArn: executionRole.roleArn,
    });
    return {
      computeEnvironmentName: environment.computeEnvironmentName.as<string>(),
      computeEnvironmentArn: environment.computeEnvironmentArn.as<string>(),
      jobQueueName: queue.jobQueueName.as<string>(),
      jobQueueArn: queue.jobQueueArn.as<string>(),
      jobDefinitionName: job.jobDefinitionName.as<string>(),
      jobDefinitionArn: job.jobDefinitionArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "compute environments, job queues and job definitions resolve by name, and survive destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const {
        computeEnvironmentName,
        computeEnvironmentArn,
        jobQueueName,
        jobQueueArn,
        jobDefinitionName,
        jobDefinitionArn,
      } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return {
            environment: AWS.Batch.ComputeEnvironment.lookup({ computeEnvironmentName })
              .computeEnvironmentArn,
            queue: AWS.Batch.JobQueue.lookup({ jobQueueName }).jobQueueArn,
            job: AWS.Batch.JobDefinition.lookup({ jobDefinitionName }).jobDefinitionArn,
          };
        },
        {
          environment: computeEnvironmentArn,
          queue: jobQueueArn,
          job: jobDefinitionArn,
        },
      );
      const { jobQueues } = yield* batch.describeJobQueues({ jobQueues: [jobQueueArn] });
      expect(jobQueues?.[0]?.jobQueueArn).toBe(jobQueueArn);
    }),
  { tags, timeout: 600_000 },
);

test.provider(
  "a lookup of a missing compute environment, queue or job definition fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-environment": AWS.Batch.ComputeEnvironment.lookup({ computeEnvironmentName: name })
          .computeEnvironmentArn,
        "missing-queue": AWS.Batch.JobQueue.lookup({ jobQueueName: name }).jobQueueArn,
        "missing-job": AWS.Batch.JobDefinition.lookup({ jobDefinitionName: name }).jobDefinitionArn,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(stack.deploy(AWS.SSM.Parameter(id, { value })), [
          "LookupNotFoundError",
        ]);
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 600_000 },
);
