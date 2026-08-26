import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
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

const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_VERTEX && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsTrainingPipelines({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsTrainingPipelines on a missing pipeline fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsTrainingPipelines({
          name: `projects/${project}/locations/us-central1/trainingPipelines/alchemy-missing-pipeline`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* aiplatform
        .listProjectsLocationsTrainingPipelines({
          parent: `projects/${project}/locations/us-central1`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ trainingPipelines: [] as const }),
          ),
        );
      expect(Array.isArray(page.trainingPipelines ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, refresh, and delete a training pipeline",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.TrainingPipeline("Train", {
            location: "us-central1",
            displayName: "alchemy-test-pipeline",
            trainingTaskDefinition:
              "gs://google-cloud-aiplatform/schema/trainingjob/definition/custom_task_1.0.0.yaml",
            trainingTaskInputs: {
              workerPoolSpecs: [
                {
                  machineSpec: { machineType: "n1-standard-4" },
                  replicaCount: "1",
                  containerSpec: {
                    imageUri:
                      "us-docker.pkg.dev/vertex-ai/training/tf-cpu.2-12.py310:latest",
                    command: ["echo", "ok"],
                  },
                },
              ],
            },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/trainingPipelines/");
      expect(created.trainingPipelineId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* aiplatform.getProjectsLocationsTrainingPipelines({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.TrainingPipeline("Train", {
            trainingPipelineId: created.trainingPipelineId,
            location: "us-central1",
            displayName: "alchemy-test-pipeline",
            trainingTaskDefinition: created.trainingTaskDefinition ?? "",
            trainingTaskInputs: created.trainingTaskInputs,
            labels: { env: "prod" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.trainingPipelineId).toEqual(created.trainingPipelineId);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
