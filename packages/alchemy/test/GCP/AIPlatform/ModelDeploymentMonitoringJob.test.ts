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
  aiplatform.getProjectsLocationsModelDeploymentMonitoringJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsModelDeploymentMonitoringJobs on a missing job fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsModelDeploymentMonitoringJobs({
          name: `${parent}/modelDeploymentMonitoringJobs/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
      if (String(error._tag) === "BadRequest") {
        yield* stack.destroy();
        return;
      }

      const page = yield* aiplatform
        .listProjectsLocationsModelDeploymentMonitoringJobs({
          parent,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["Forbidden"], () =>
            Effect.succeed({ modelDeploymentMonitoringJobs: [] as const }),
          ),
        );
      expect(Array.isArray(page.modelDeploymentMonitoringJobs ?? [])).toEqual(
        true,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a model deployment monitoring job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const endpoint = yield* GCP.AIPlatform.Endpoint("Predictor", {
            location: "us-central1",
            displayName: "alchemy-mdm-endpoint",
            labels: { env: "test" },
          });
          const job = yield* GCP.AIPlatform.ModelDeploymentMonitoringJob(
            "Watch",
            {
              location: "us-central1",
              displayName: "alchemy-mdm",
              endpoint: endpoint.name,
              loggingSamplingStrategy: {
                randomSampleConfig: { sampleRate: 0.1 },
              },
              modelDeploymentMonitoringScheduleConfig: {
                monitorInterval: "3600s",
              },
              modelDeploymentMonitoringObjectiveConfigs: [
                {
                  deployedModelId: "0",
                  objectiveConfig: {
                    predictionDriftDetectionConfig: {},
                  },
                },
              ],
              labels: { env: "test" },
            },
          );
          return { endpoint, job };
        }),
      );

      expect(created.job.name).toContain("/modelDeploymentMonitoringJobs/");
      expect(created.job.endpoint).toEqual(created.endpoint.name);
      expect(created.job.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* aiplatform.getProjectsLocationsModelDeploymentMonitoringJobs({
          name: created.job.name,
        });
      expect(fetched.name).toEqual(created.job.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const endpoint = yield* GCP.AIPlatform.Endpoint("Predictor", {
            endpointId: created.endpoint.endpointId,
            location: "us-central1",
            displayName: "alchemy-mdm-endpoint",
            labels: { env: "test" },
          });
          const job = yield* GCP.AIPlatform.ModelDeploymentMonitoringJob(
            "Watch",
            {
              location: "us-central1",
              displayName: "alchemy-mdm-v2",
              endpoint: endpoint.name,
              loggingSamplingStrategy: {
                randomSampleConfig: { sampleRate: 0.2 },
              },
              modelDeploymentMonitoringScheduleConfig: {
                monitorInterval: "3600s",
              },
              modelDeploymentMonitoringObjectiveConfigs: [
                {
                  deployedModelId: "0",
                  objectiveConfig: {
                    predictionDriftDetectionConfig: {},
                  },
                },
              ],
              labels: { env: "prod" },
            },
          );
          return { endpoint, job };
        }),
      );

      expect(updated.job.name).toEqual(created.job.name);
      expect(updated.job.displayName).toEqual("alchemy-mdm-v2");
      expect(updated.job.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.job.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
