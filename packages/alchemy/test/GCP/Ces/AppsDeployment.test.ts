import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as ces from "@distilled.cloud/gcp/ces_v1";
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

const runLifecycle =
  hasGcpCreds && !process.env.FAST && process.env.GCP_TEST_CES === "1";

const waitUntilGone = (name: string) =>
  ces.getProjectsLocationsAppsDeployments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsAppsDeployments on a missing deployment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        ces.getProjectsLocationsAppsDeployments({
          name: `projects/${project}/locations/us-central1/apps/missing/deployments/missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.Ces.App("Support", {
            displayName: "support",
          });
          const deployment = yield* GCP.Ces.AppsDeployment("Prod", {
            app: app.name,
            displayName: "prod",
            channelProfile: { channelType: "API", profileId: "api" },
          });
          return { app, deployment };
        }),
      );

      expect(created.deployment.name).toContain("/deployments/");
      expect(created.deployment.app).toEqual(created.app.name);
      expect(created.deployment.displayName).toEqual("prod");
      expect(created.deployment.channelProfile?.channelType).toEqual("API");

      const fetched = yield* ces.getProjectsLocationsAppsDeployments({
        name: created.deployment.name,
      });
      expect(fetched.name).toEqual(created.deployment.name);
      expect(fetched.displayName).toContain("alchemy-");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.Ces.App("Support", {
            appId: created.app.appId,
            location: created.app.location,
            displayName: "support",
          });
          const deployment = yield* GCP.Ces.AppsDeployment("Prod", {
            app: app.name,
            deploymentId: created.deployment.deploymentId,
            displayName: "prod-api",
            channelProfile: { channelType: "API", profileId: "api" },
          });
          return { app, deployment };
        }),
      );

      expect(updated.deployment.name).toEqual(created.deployment.name);
      expect(updated.deployment.displayName).toEqual("prod-api");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.deployment.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
