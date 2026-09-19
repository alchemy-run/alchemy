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
  hasGcpCreds &&
  !process.env.FAST &&
  !!(process.env.GCP_TEST_AIPLATFORM || process.env.GCP_TEST_VERTEX);

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const parent = `projects/${project}/locations/us-central1`;

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsHyperparameterTuningJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const studySpec = {
  metrics: [{ metricId: "accuracy", goal: "MAXIMIZE" as const }],
  parameters: [
    {
      parameterId: "lr",
      doubleValueSpec: { minValue: 0.001, maxValue: 0.1 },
    },
  ],
};

const trialJobSpec = {
  workerPoolSpecs: [
    {
      machineSpec: { machineType: "n1-standard-4" },
      replicaCount: "1",
      containerSpec: {
        imageUri: "gcr.io/cloud-aiplatform/training/tf-cpu.2-8:latest",
        command: ["echo", "ok"],
      },
    },
  ],
};

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsHyperparameterTuningJobs on a missing job fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsHyperparameterTuningJobs({
          name: `${parent}/hyperparameterTuningJobs/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
      if (String(error._tag) === "BadRequest") {
        yield* stack.destroy();
        return;
      }

      const page = yield* aiplatform
        .listProjectsLocationsHyperparameterTuningJobs({
          parent,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["Forbidden"], () =>
            Effect.succeed({ hyperparameterTuningJobs: [] as const }),
          ),
        );
      expect(Array.isArray(page.hyperparameterTuningJobs ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a hyperparameter tuning job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.HyperparameterTuningJob("Tune", {
            location: "us-central1",
            displayName: "alchemy-hpt",
            maxTrialCount: 1,
            parallelTrialCount: 1,
            studySpec,
            trialJobSpec,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/hyperparameterTuningJobs/");
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* aiplatform.getProjectsLocationsHyperparameterTuningJobs({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
