import * as GCP from "@/GCP";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as datapipelines from "@distilled.cloud/gcp/datapipelines_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

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
const parent = `projects/${project}/locations/us-central1`;

// Data Pipelines is entitlement-gated on the default testing project
// (`Forbidden`: "Data pipelines API has not been used in project
// alchemy-gcp-testing-83661 before or it is disabled."). Set
// GCP_TEST_DATAPIPELINES=1 on an entitled project to run the lifecycle.
const entitled = process.env.GCP_TEST_DATAPIPELINES === "1";
const runLifecycle = hasGcpCreds && entitled && !process.env.FAST;

const waitUntilGone = (name: string) =>
  datapipelines.getProjectsLocationsPipelines({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsPipelines on a missing pipeline fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datapipelines.getProjectsLocationsPipelines({
          name: `${parent}/pipelines/alchemy-missing-pipeline`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain("Data pipelines API has not been used");
      }

      const page = yield* datapipelines
        .listProjectsLocationsPipelines({
          parent,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ pipelines: [] }),
          ),
        );
      expect(Array.isArray(page.pipelines ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || entitled)(
  "createProjectsLocationsPipelines is rejected with Forbidden when Data Pipelines is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datapipelines.createProjectsLocationsPipelines({
          parent,
          body: {
            displayName: "alchemy-probe",
            type: "PIPELINE_TYPE_BATCH",
            state: "STATE_ACTIVE",
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain("Data pipelines API has not been used");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a data pipeline",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("PipelineTmp", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.Datapipelines.Pipeline("WordCount", {
            type: "PIPELINE_TYPE_BATCH",
            displayName: "word-count",
            scheduleInfo: { schedule: "0 0 1 1 *", timeZone: "UTC" },
            workload: {
              dataflowLaunchTemplateRequest: {
                projectId: project,
                location: "us-central1",
                gcsPath: "gs://dataflow-templates/latest/Word_Count",
                launchParameters: {
                  jobName: "alchemy-word-count",
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
        }),
      );

      expect(created.name).toContain("/pipelines/");
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("word-count");
      expect(created.type).toEqual("PIPELINE_TYPE_BATCH");
      expect(created.scheduleInfo?.schedule).toEqual("0 0 1 1 *");
      expect(created.pipelineId.length).toBeGreaterThan(0);

      const fetched = yield* datapipelines.getProjectsLocationsPipelines({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("word-count");
      expect(fetched.pipelineSources?.["alchemy-id"]).toEqual(
        expect.any(String),
      );
      expect(fetched.type).toEqual("PIPELINE_TYPE_BATCH");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("PipelineTmp", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return yield* GCP.Datapipelines.Pipeline("WordCount", {
            pipelineId: created.pipelineId,
            location: created.location,
            type: "PIPELINE_TYPE_BATCH",
            displayName: "word-count-v2",
            scheduleInfo: { schedule: "0 0 1 2 *", timeZone: "UTC" },
            workload: {
              dataflowLaunchTemplateRequest: {
                projectId: project,
                location: "us-central1",
                gcsPath: "gs://dataflow-templates/latest/Word_Count",
                launchParameters: {
                  jobName: "alchemy-word-count",
                  parameters: {
                    inputFile: "gs://dataflow-samples/shakespeare/kinglear.txt",
                    output: Output.interpolate`gs://${bucket.bucketName}/out-v2`,
                  },
                  environment: {
                    tempLocation: Output.interpolate`gs://${bucket.bucketName}/tmp`,
                  },
                },
              },
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("word-count-v2");
      expect(updated.scheduleInfo?.schedule).toEqual("0 0 1 2 *");

      const fetchedUpdate = yield* datapipelines.getProjectsLocationsPipelines({
        name: updated.name,
      });
      expect(fetchedUpdate.displayName).toEqual("word-count-v2");
      expect(fetchedUpdate.scheduleInfo?.schedule).toEqual("0 0 1 2 *");
      expect(fetchedUpdate.pipelineSources?.["alchemy-id"]).toEqual(
        expect.any(String),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
