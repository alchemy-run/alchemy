import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as config from "@distilled.cloud/gcp/config_v1";
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

// Infra Manager (config.googleapis.com) is entitlement-gated. Live create
// returns Forbidden: "Infrastructure Manager API has not been used in
// project … before or it is disabled." Set GCP_TEST_CONFIG=1 on an
// entitled project to run the full lifecycle.
const entitled = process.env.GCP_TEST_CONFIG === "1";
const runLifecycle = hasGcpCreds && entitled && !process.env.FAST;

const waitUntilGone = (name: string) =>
  config.getProjectsLocationsDeploymentGroups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsDeploymentGroups on a missing group fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        config.getProjectsLocationsDeploymentGroups({
          name: `projects/${project}/locations/us-central1/deploymentGroups/alchemy-missing-group`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* config
        .listProjectsLocationsDeploymentGroups({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ deploymentGroups: [] as const }),
          ),
        );
      expect(Array.isArray(page.deploymentGroups ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || entitled)(
  "createProjectsLocationsDeploymentGroups is rejected with Forbidden when Infra Manager is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        config.createProjectsLocationsDeploymentGroups({
          parent: `projects/${project}/locations/us-central1`,
          deploymentGroupId: "alchemy-config-probe-group",
          body: {
            deploymentUnits: [{ id: "network", dependencies: [] }],
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain("config.googleapis.com");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a deployment group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Config.DeploymentGroup("App", {
            deploymentUnits: [{ id: "network", dependencies: [] }],
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/deploymentGroups/");
      expect(created.deploymentGroupId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.deploymentUnits[0]?.id).toEqual("network");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* config.getProjectsLocationsDeploymentGroups({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.deploymentUnits?.[0]?.id).toEqual("network");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Config.DeploymentGroup("App", {
            deploymentGroupId: created.deploymentGroupId,
            deploymentUnits: [
              { id: "network", dependencies: [] },
              { id: "cluster", dependencies: ["network"] },
            ],
            labels: { env: "prod", role: "config" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.deploymentUnits.map((unit) => unit.id)).toEqual([
        "network",
        "cluster",
      ]);
      expect(updated.labels).toMatchObject({ env: "prod", role: "config" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
