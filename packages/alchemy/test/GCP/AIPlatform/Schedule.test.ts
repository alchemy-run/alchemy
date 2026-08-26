import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as ScheduleLib from "effect/Schedule";

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

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsSchedules({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: ScheduleLib.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsSchedules on a missing schedule fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsSchedules({
          name: `projects/${project}/locations/us-central1/schedules/alchemy-sched-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, pause, and delete a vertex schedule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.Schedule("Nightly", {
            location: "us-central1",
            displayName: "nightly",
            cron: "CRON_TZ=UTC 0 8 * * *",
            paused: true,
            maxRunCount: "1",
            createPipelineJobRequest: {
              pipelineJob: {
                displayName: "nightly-hello",
                templateUri:
                  "https://us-kfp.pkg.dev/ml-pipeline/google-cloud-registry/hello-world/latest",
              },
            },
          });
        }),
      );

      expect(created.name).toContain("/schedules/");
      expect(created.paused).toEqual(true);
      expect(created.cron).toContain("0 8 * * *");

      const fetched = yield* aiplatform.getProjectsLocationsSchedules({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.Schedule("Nightly", {
            location: "us-central1",
            displayName: "nightly-v2",
            cron: "CRON_TZ=UTC 0 9 * * *",
            paused: true,
            maxRunCount: "1",
            createPipelineJobRequest: {
              pipelineJob: {
                displayName: "nightly-hello",
                templateUri:
                  "https://us-kfp.pkg.dev/ml-pipeline/google-cloud-registry/hello-world/latest",
              },
            },
          });
        }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.cron).toContain("0 9 * * *");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
