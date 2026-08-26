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
  aiplatform.getProjectsLocationsDataLabelingJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsDataLabelingJobs on a missing job fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsDataLabelingJobs({
          name: `${parent}/dataLabelingJobs/alchemy-aiplatform-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* aiplatform
        .listProjectsLocationsDataLabelingJobs({
          parent,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["Forbidden"], () =>
            Effect.succeed({ dataLabelingJobs: [] as const }),
          ),
        );
      expect(Array.isArray(page.dataLabelingJobs ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a data labeling job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.AIPlatform.Dataset("ToLabel", {
            location: "us-central1",
            displayName: "label-source",
            metadataSchemaUri:
              "gs://google-cloud-aiplatform/schema/dataset/metadata/image_1.0.0.yaml",
            metadata: {},
            labels: { env: "test" },
          });
          return yield* GCP.AIPlatform.DataLabelingJob("Label", {
            location: "us-central1",
            displayName: "alchemy-label",
            datasets: [dataset.name],
            labelerCount: 1,
            instructionUri: "gs://cloud-samples-data/ai-platform/label.pdf",
            inputsSchemaUri:
              "gs://google-cloud-aiplatform/schema/datalabelingjob/inputs/image_classification_1.0.0.yaml",
            inputs: { annotationSpecs: ["cat", "dog"] },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/dataLabelingJobs/");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* aiplatform.getProjectsLocationsDataLabelingJobs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
