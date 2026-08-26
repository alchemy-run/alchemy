import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const entitled = process.env.GCP_TEST_DATAPIPELINES === "1";
const runBindings = hasGcpCreds && entitled && !process.env.FAST;

test.provider.skipIf(!runBindings)(
  "RunPipeline and StopPipeline on a data pipeline",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("PipelineBindTmp", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const pipeline = yield* GCP.Datapipelines.Pipeline("BindBatch", {
            type: "PIPELINE_TYPE_BATCH",
            displayName: "bind-batch",
            workload: {
              dataflowLaunchTemplateRequest: {
                projectId: project,
                location: "us-central1",
                gcsPath: "gs://dataflow-templates/latest/Word_Count",
                launchParameters: {
                  jobName: "alchemy-bind-word-count",
                  parameters: {
                    inputFile: "gs://dataflow-samples/shakespeare/kinglear.txt",
                    output: Output.interpolate`gs://${bucket.bucketName}/out`,
                  },
                  environment: {
                    tempLocation: Output.interpolate`gs://${bucket.bucketName}/tmp`,
                  },
                },
              },
            },
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* pipeline.name;
              const runPipeline =
                yield* GCP.Datapipelines.RunPipeline(pipeline);
              const stopPipeline =
                yield* GCP.Datapipelines.StopPipeline(pipeline);
              return Effect.fn(function* () {
                const ran = yield* runPipeline();
                const stopped = yield* stopPipeline();
                return { ran, stopped };
              });
            }),
          );
          return { pipeline, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.ran.job?.name ?? out.pipeline.name).toEqual(
        expect.any(String),
      );
      expect(out.probe.stopped.state).toEqual("STATE_ARCHIVED");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
