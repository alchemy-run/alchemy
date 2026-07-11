import * as AWS from "@/AWS";
import {
  Application,
  ApplicationCloudWatchLoggingOption,
} from "@/AWS/KinesisAnalyticsV2";
import * as Test from "@/Test/Vitest";
import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as s3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { makeDummyFlinkCodeZip } from "./dummy-zip.ts";

const { test } = Test.make({ providers: AWS.providers() });

const codeKey = "code/app.zip";

class ApplicationStillExists extends Data.TaggedError(
  "ApplicationStillExists",
) {}

const assertApplicationDeleted = Effect.fn(function* (applicationName: string) {
  yield* analytics
    .describeApplication({ ApplicationName: applicationName })
    .pipe(
      Effect.flatMap(() => Effect.fail(new ApplicationStillExists())),
      Effect.retry({
        while: (e: { _tag: string }) => e._tag === "ApplicationStillExists",
        schedule: Schedule.fixed("3 seconds").pipe(
          Schedule.both(Schedule.recurs(40)),
        ),
      }),
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    );
});

describe.skipIf(!!process.env.FAST)(
  "AWS.KinesisAnalyticsV2.ApplicationCloudWatchLoggingOption",
  () => {
    test.provider(
      "attach a CloudWatch logging option, detach it, destroy",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const staged = yield* stack.deploy(
            Effect.gen(function* () {
              const bucket = yield* AWS.S3.Bucket("FlinkLoggingBucket", {
                forceDestroy: true,
              });
              return { bucket };
            }),
          );
          const zip = yield* Effect.sync(() => makeDummyFlinkCodeZip());
          yield* s3.putObject({
            Bucket: staged.bucket.bucketName,
            Key: codeKey,
            Body: zip,
          });

          const makeBase = Effect.gen(function* () {
            const bucket = yield* AWS.S3.Bucket("FlinkLoggingBucket", {
              forceDestroy: true,
            });
            const logGroup = yield* AWS.Logs.LogGroup("FlinkLogGroup", {});
            const logStream = yield* AWS.Logs.LogStream("FlinkLogStream", {
              logGroupName: logGroup.logGroupName,
            });
            const app = yield* Application("LoggedFlinkApp", {
              runtimeEnvironment: "FLINK-1_20",
              code: { bucketArn: bucket.bucketArn, fileKey: codeKey },
            });
            return { bucket, logGroup, logStream, app };
          });

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const base = yield* makeBase;
              const logging = yield* ApplicationCloudWatchLoggingOption(
                "FlinkLogging",
                {
                  applicationName: base.app.applicationName,
                  logStreamArn: base.logStream.logStreamArn.as<string>(),
                },
              );
              return { ...base, logging };
            }),
          );

          expect(deployed.logging.applicationName).toEqual(
            deployed.app.applicationName,
          );
          expect(deployed.logging.cloudWatchLoggingOptionId).toBeDefined();
          expect(deployed.logging.logStreamArn).toContain(":log-stream:");

          // Out-of-band: the option is visible on the application.
          const described = yield* analytics.describeApplication({
            ApplicationName: deployed.app.applicationName,
          });
          const options =
            described.ApplicationDetail.CloudWatchLoggingOptionDescriptions ??
            [];
          expect(options).toHaveLength(1);
          expect(options[0]?.LogStreamARN).toEqual(
            deployed.logging.logStreamArn,
          );

          // Remove the option while the application stays deployed — the
          // engine deletes just the sub-resource.
          const detached = yield* stack.deploy(makeBase);
          expect(detached.app.applicationName).toEqual(
            deployed.app.applicationName,
          );

          const afterDetach = yield* analytics.describeApplication({
            ApplicationName: deployed.app.applicationName,
          });
          expect(
            afterDetach.ApplicationDetail.CloudWatchLoggingOptionDescriptions ??
              [],
          ).toHaveLength(0);

          yield* stack.destroy();

          yield* assertApplicationDeleted(deployed.app.applicationName);
        }),
      { timeout: 300_000 },
    );
  },
);
