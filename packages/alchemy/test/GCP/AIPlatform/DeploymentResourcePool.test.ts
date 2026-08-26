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
  aiplatform.getProjectsLocationsDeploymentResourcePools({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsDeploymentResourcePools on a missing pool fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsDeploymentResourcePools({
          name: `${parent}/deploymentResourcePools/alchemy-aiplatform-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      const page = yield* aiplatform
        .listProjectsLocationsDeploymentResourcePools({
          parent,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["Forbidden", "BadRequest"], () =>
            Effect.succeed({ deploymentResourcePools: [] as const }),
          ),
        );
      expect(Array.isArray(page.deploymentResourcePools ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a deployment resource pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.DeploymentResourcePool("Shared", {
            location: "us-central1",
            dedicatedResources: {
              minReplicaCount: 1,
              maxReplicaCount: 1,
              machineSpec: { machineType: "n1-standard-2" },
            },
          });
        }),
      );

      expect(created.name).toContain("/deploymentResourcePools/");
      expect(created.deploymentResourcePoolId.startsWith("alch-")).toEqual(
        true,
      );
      expect(created.dedicatedResources?.minReplicaCount).toEqual(1);

      const fetched =
        yield* aiplatform.getProjectsLocationsDeploymentResourcePools({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.DeploymentResourcePool("Shared", {
            deploymentResourcePoolId: created.deploymentResourcePoolId,
            location: "us-central1",
            dedicatedResources: {
              minReplicaCount: 1,
              maxReplicaCount: 2,
              machineSpec: { machineType: "n1-standard-2" },
            },
            disableContainerLogging: true,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.disableContainerLogging).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
