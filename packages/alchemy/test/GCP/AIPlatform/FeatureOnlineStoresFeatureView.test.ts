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

const waitUntilGone = (name: string) =>
  aiplatform.getProjectsLocationsFeatureOnlineStoresFeatureViews({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsFeatureOnlineStoresFeatureViews on a missing view fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsFeatureOnlineStoresFeatureViews({
          name: `projects/${project}/locations/us-central1/featureOnlineStores/alchemy-missing/featureViews/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a feature online store feature view",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.AIPlatform.FeatureOnlineStore("Serving", {
            location: "us-central1",
            optimized: true,
            labels: { env: "test" },
          });
          const view = yield* GCP.AIPlatform.FeatureOnlineStoresFeatureView(
            "Users",
            {
              featureOnlineStore: store.name,
              location: "us-central1",
              labels: { env: "test" },
              featureRegistrySource: {
                featureGroups: [
                  { featureGroupId: "users", featureIds: ["age"] },
                ],
              },
              syncConfig: { cron: "0 * * * *" },
            },
          );
          return { store, view };
        }),
      );

      expect(created.view.name).toContain("/featureViews/");
      expect(created.view.featureOnlineStore).toEqual(created.store.name);
      expect(created.view.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* aiplatform.getProjectsLocationsFeatureOnlineStoresFeatureViews({
          name: created.view.name,
        });
      expect(fetched.name).toEqual(created.view.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.AIPlatform.FeatureOnlineStore("Serving", {
            featureOnlineStoreId: created.store.featureOnlineStoreId,
            location: "us-central1",
            optimized: true,
            labels: { env: "test" },
          });
          const view = yield* GCP.AIPlatform.FeatureOnlineStoresFeatureView(
            "Users",
            {
              featureOnlineStore: store.name,
              featureViewId: created.view.featureViewId,
              location: "us-central1",
              labels: { env: "prod" },
              featureRegistrySource: {
                featureGroups: [
                  { featureGroupId: "users", featureIds: ["age"] },
                ],
              },
              syncConfig: { cron: "0 * * * *" },
            },
          );
          return { store, view };
        }),
      );

      expect(updated.view.name).toEqual(created.view.name);
      expect(updated.view.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.view.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
