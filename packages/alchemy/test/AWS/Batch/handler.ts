import * as Batch from "@/AWS/Batch";
import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class BatchTestFunction extends Lambda.Function<Lambda.Function>()(
  "BatchTestFunction",
) {}

export default BatchTestFunction.make(
  {
    main,
    url: true,
    // submit/describe fan out SDK calls — AWS's 3s default intermittently
    // times out under cold starts.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The whole Batch chain: Fargate CE (default-VPC networking) → queue →
    // busybox echo job definition.
    const computeEnvironment = yield* Batch.ComputeEnvironment("TestCE", {});
    const queue = yield* Batch.JobQueue("TestQueue", {
      computeEnvironments: [computeEnvironment.computeEnvironmentArn],
    });
    const executionRole = yield* IAM.Role("BatchExecutionRole", {
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
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
      ],
    });
    const jobDefinition = yield* Batch.JobDefinition("EchoJob", {
      image: "public.ecr.aws/docker/library/busybox:latest",
      command: ["echo", "hello-from-batch"],
      executionRoleArn: executionRole.roleArn,
      timeoutSeconds: 300,
    });

    const submitJob = yield* Batch.SubmitJob(queue, jobDefinition);
    const describeJobs = yield* Batch.DescribeJobs(queue);
    const terminateJob = yield* Batch.TerminateJob(queue);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "POST" && pathname === "/submit") {
          const body = (yield* request.json) as unknown as {
            jobName: string;
          };
          const result = yield* submitJob({ jobName: body.jobName });
          return yield* HttpServerResponse.json({
            jobId: result.jobId,
            jobName: result.jobName,
            jobArn: result.jobArn,
          });
        }

        if (request.method === "GET" && pathname === "/status") {
          const jobId = url.searchParams.get("jobId")!;
          const result = yield* describeJobs({ jobs: [jobId] });
          const job = result.jobs?.[0];
          return yield* HttpServerResponse.json({
            status: job?.status,
            statusReason: job?.statusReason,
            jobQueue: job?.jobQueue,
          });
        }

        if (request.method === "POST" && pathname === "/terminate") {
          const body = (yield* request.json) as unknown as {
            jobId: string;
            reason: string;
          };
          yield* terminateJob({ jobId: body.jobId, reason: body.reason });
          return yield* HttpServerResponse.json({ terminated: true });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Batch.SubmitJobHttp,
        Batch.DescribeJobsHttp,
        Batch.TerminateJobHttp,
      ),
    ),
  ),
);
