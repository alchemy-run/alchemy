import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as workstations from "@distilled.cloud/gcp/workstations_v1";
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

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsWorkstationClustersWorkstationConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        workstations.getProjectsLocationsWorkstationClustersWorkstationConfigs({
          name: `projects/${project}/locations/us-central1/workstationClusters/alchemy-missing-cluster/workstationConfigs/alchemy-missing-config`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* workstations
        .listProjectsLocationsWorkstationClustersWorkstationConfigs({
          parent: `projects/${project}/locations/-/workstationClusters/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ workstationConfigs: [] as const }),
          ),
        );
      expect(Array.isArray(page.workstationConfigs ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create against a missing cluster is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Workstations.WorkstationClustersWorkstationConfig(
              "Code",
              {
                workstationCluster: `projects/${project}/locations/us-central1/workstationClusters/alchemy-missing-cluster`,
                displayName: "alchemy-test-config",
                labels: { env: "test" },
              },
            );
          }),
        ),
      );
      expect([
        "BadRequest",
        "NotFound",
        "Forbidden",
        "GCP.Workstations.OperationFailed",
        "GCP.Workstations.ResourceNotResolved",
      ]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
