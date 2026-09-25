import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_DISCOVERYENGINE;
const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  discoveryengine
    .getProjectsLocationsCollectionsEnginesServingConfigs({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsCollectionsEnginesServingConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsCollectionsEnginesServingConfigs({
          name: `projects/${project}/locations/global/collections/default_collection/engines/alchemy-missing/servingConfigs/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an engine serving config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.Discoveryengine.CollectionsDataStore(
            "Docs",
            {
              location: "global",
              displayName: "serving-docs",
            },
          );
          const engine = yield* GCP.Discoveryengine.CollectionsEngine(
            "Search",
            {
              location: "global",
              dataStoreIds: [store.dataStoreId],
              displayName: "serving engine",
            },
          );
          const serving =
            yield* GCP.Discoveryengine.CollectionsEnginesServingConfig(
              "Primary",
              {
                engine: engine.name,
                displayName: "primary",
                solutionType: "SOLUTION_TYPE_SEARCH",
              },
            );
          return { store, engine, serving };
        }),
      );

      expect(created.serving.name).toContain("/servingConfigs/");
      expect(created.serving.engine).toEqual(created.engine.name);
      expect(created.serving.displayName).toEqual("primary");

      const fetched =
        yield* discoveryengine.getProjectsLocationsCollectionsEnginesServingConfigs(
          { name: created.serving.name },
        );
      expect(fetched.name).toEqual(created.serving.name);
      expect(fetched.displayName).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.Discoveryengine.CollectionsDataStore(
            "Docs",
            {
              dataStoreId: created.store.dataStoreId,
              location: "global",
              displayName: "serving-docs",
            },
          );
          const engine = yield* GCP.Discoveryengine.CollectionsEngine(
            "Search",
            {
              engineId: created.engine.engineId,
              location: "global",
              dataStoreIds: [store.dataStoreId],
              displayName: "serving engine",
            },
          );
          const serving =
            yield* GCP.Discoveryengine.CollectionsEnginesServingConfig(
              "Primary",
              {
                engine: engine.name,
                servingConfigId: created.serving.servingConfigId,
                displayName: "primary-prod",
                solutionType: "SOLUTION_TYPE_SEARCH",
              },
            );
          return { store, engine, serving };
        }),
      );

      expect(updated.serving.name).toEqual(created.serving.name);
      expect(updated.serving.displayName).toEqual("primary-prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.serving.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
