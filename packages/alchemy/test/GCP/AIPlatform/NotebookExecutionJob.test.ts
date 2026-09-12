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
  aiplatform.getProjectsLocationsNotebookExecutionJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const emptyNotebook =
  "eyJuYmZvcm1hdCI6NCwibmJmb3JtYXRfbWlub3IiOjUsIm1ldGFkYXRhIjp7fSwiY2VsbHMiOltdfQ==";

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsNotebookExecutionJobs on a missing job fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsNotebookExecutionJobs({
          name: `${parent}/notebookExecutionJobs/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
      if (String(error._tag) === "BadRequest") {
        yield* stack.destroy();
        return;
      }

      const page = yield* aiplatform
        .listProjectsLocationsNotebookExecutionJobs({
          parent,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["Forbidden"], () =>
            Effect.succeed({ notebookExecutionJobs: [] as const }),
          ),
        );
      expect(Array.isArray(page.notebookExecutionJobs ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a notebook execution job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.AIPlatform.NotebookRuntimeTemplate(
            "Runtime",
            {
              location: "us-central1",
              displayName: "alchemy-notebook-runtime",
              machineSpec: { machineType: "e2-standard-4" },
              labels: { env: "test" },
            },
          );
          return yield* GCP.AIPlatform.NotebookExecutionJob("Nightly", {
            location: "us-central1",
            displayName: "alchemy-notebook-job",
            notebookRuntimeTemplateResourceName: template.name,
            directNotebookSource: { content: emptyNotebook },
            gcsOutputUri: "gs://alchemy-aiplatform-test/notebook-out",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/notebookExecutionJobs/");
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* aiplatform.getProjectsLocationsNotebookExecutionJobs({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
