import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as batch from "@distilled.cloud/aws/batch";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Alchemy from "alchemy";
import * as State from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import EnvJob, { ENV_MARKER, jobEnv } from "./fixtures/env-job.ts";
import { BatchTestNetwork } from "./TestNetwork.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const Stack = Alchemy.Stack(
  "AlchemyBatchEnvStack",
  { providers: AWS.providers(), state: State.localState() },
  Effect.gen(function* () {
    const network = yield* BatchTestNetwork;
    const computeEnvironment = yield* AWS.Batch.ComputeEnvironment("EnvCE", {
      subnets: network.subnetIds,
      securityGroupIds: network.securityGroupIds,
    });
    const queue = yield* AWS.Batch.JobQueue("EnvQueue", {
      computeEnvironments: [computeEnvironment.computeEnvironmentArn],
    });
    const job = yield* EnvJob;
    return { jobQueueArn: queue.jobQueueArn, jobDefinitionArn: job.jobDefinitionArn };
  }),
);

// Docker build + push + compute environment / queue.
const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

test.provider.skipIf(!!process.env.FAST)(
  "Batch job reads every env value as the expected string",
  () =>
    Effect.gen(function* () {
      const { jobQueueArn, jobDefinitionArn } = yield* stack;

      const submitted = yield* batch.submitJob({
        jobName: "alchemy-env-run",
        jobQueue: jobQueueArn,
        jobDefinition: jobDefinitionArn!,
      });
      const job = yield* batch.describeJobs({ jobs: [submitted.jobId] }).pipe(
        Effect.map((result) => result.jobs?.[0]),
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (j): boolean => j?.status === "SUCCEEDED" || j?.status === "FAILED",
          times: 40,
        }),
      );
      expect(`${job?.status}: ${job?.statusReason ?? ""}`).toMatch(/^SUCCEEDED:/);

      const logStreamName = job?.container?.logStreamName;
      expect(logStreamName).toBeTruthy();
      const line = yield* logs
        .getLogEvents({ logGroupName: "/aws/batch/job", logStreamName: logStreamName! })
        .pipe(
          Effect.map(
            (r) => (r.events ?? []).find((e) => e.message?.startsWith(ENV_MARKER))?.message,
          ),
          Effect.flatMap((m) =>
            m ? Effect.succeed(m) : Effect.fail(new Error("env line not logged yet")),
          ),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 12 }),
        );
      expect(JSON.parse(line.slice(ENV_MARKER.length))).toEqual(jobEnv.expected);
    }),
  { tags: ["provider:aws", "provider:aws:batch", "live"], timeout: 600_000 },
);
