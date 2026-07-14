import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import * as Output from "@/Output";
import * as Test from "@/Test/Vitest";
import * as osis from "@distilled.cloud/aws/osis";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getPipeline on a nonexistent pipeline fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        osis.getPipeline({ PipelineName: "alchemy-nonexistent-probe" }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// Data Prepper configuration: HTTP source draining to an S3 sink. The role
// and bucket are provisioned by the same stack; interpolation defers the
// concrete values until deploy time.
const pipelineConfig = (
  roleArn: Output.Output<string>,
  bucketName: Output.Output<string>,
  region: string,
) => Output.interpolate`version: "2"
log-pipeline:
  source:
    http:
      path: "/logs/ingest"
  sink:
    - s3:
        aws:
          sts_role_arn: "${roleArn}"
          region: "${region}"
        bucket: "${bucketName}"
        threshold:
          event_collect_timeout: "60s"
        codec:
          ndjson:
`;

// Deletion is verified as INITIATED (status DELETING, irreversible) or fully
// gone. Full disappearance takes a few more minutes server-side.
const assertPipelineDeleting = (name: string) =>
  Effect.gen(function* () {
    const status = yield* osis.getPipeline({ PipelineName: name }).pipe(
      Effect.map((response) => response.Pipeline?.Status ?? "gone"),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("gone" as const),
      ),
    );
    if (status !== "gone" && status !== "DELETING") {
      return yield* Effect.fail(
        new Error(`pipeline '${name}' still exists (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(18),
      ]),
    }),
  );

// OSIS pipelines take ~5-10 minutes to provision and are billed per
// Ingestion-OCU-hour while they exist (minimum 1 OCU). The full lifecycle is
// gated behind AWS_TEST_SLOW=1 and always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create http-to-s3 pipeline, verify active, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { region } = yield* AWSEnvironment.current;

      const { pipeline } = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket("Sink", {
            forceDestroy: true,
          });
          const role = yield* AWS.IAM.Role("PipelineRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: ["osis-pipelines.amazonaws.com"] },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            inlinePolicies: {
              "s3-sink": {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["s3:PutObject", "s3:AbortMultipartUpload"],
                    Resource: [Output.interpolate`${bucket.bucketArn}/*`],
                  },
                  {
                    Effect: "Allow",
                    Action: ["s3:GetBucketLocation", "s3:ListBucket"],
                    Resource: [bucket.bucketArn],
                  },
                ],
              },
            },
          });
          const pipeline = yield* AWS.OSIS.Pipeline("Logs", {
            minUnits: 1,
            maxUnits: 1,
            pipelineConfigurationBody: pipelineConfig(
              role.roleArn,
              bucket.bucketName,
              region,
            ),
            tags: { fixture: "osis-pipeline" },
          });
          return { pipeline };
        }),
      );

      expect(pipeline.pipelineName).toBeDefined();
      expect(pipeline.pipelineArn).toContain(":pipeline/");
      expect(pipeline.status).toBe("ACTIVE");
      expect(pipeline.minUnits).toBe(1);
      expect(pipeline.maxUnits).toBe(1);
      expect(pipeline.ingestEndpointUrls?.length).toBeGreaterThan(0);

      // Out-of-band verification via distilled.
      const described = yield* osis.getPipeline({
        PipelineName: pipeline.pipelineName,
      });
      expect(described.Pipeline?.Status).toBe("ACTIVE");
      expect(described.Pipeline?.MinUnits).toBe(1);
      expect(described.Pipeline?.PipelineConfigurationBody).toContain(
        "log-pipeline",
      );

      // Destroy immediately — pipelines bill per OCU-hour — and verify
      // deletion was initiated out-of-band.
      yield* stack.destroy();
      yield* assertPipelineDeleting(pipeline.pipelineName);
    }),
  // create (~5-10 min) + delete initiation, one test.
  { timeout: 1_200_000 },
);
