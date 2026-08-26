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

const waitUntilGone = (tenant: string, name: string) =>
  discoveryengine
    .getProjectsLocationsCollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfigs(
      { tenant, name },
    )
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
  "getProjectsLocationsCollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsCollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfigs(
          {
            tenant: `projects/${project}/locations/global/collections/default_collection/engines/alchemy-missing/assistants/alchemy-missing`,
            name: "tasks/alchemy-missing/pushNotificationConfigs/alchemy-missing",
          },
        ),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an A2A push notification config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.Discoveryengine.CollectionsDataStore(
            "Docs",
            {
              location: "global",
              displayName: "a2a-docs",
            },
          );
          const engine = yield* GCP.Discoveryengine.CollectionsEngine(
            "Search",
            {
              location: "global",
              dataStoreIds: [store.dataStoreId],
              displayName: "a2a engine",
            },
          );
          const assistant =
            yield* GCP.Discoveryengine.CollectionsEnginesAssistant("Help", {
              engine: engine.name,
              displayName: "a2a helper",
            });
          const config =
            yield* GCP.Discoveryengine.CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfig(
              "Notify",
              {
                tenant: assistant.name,
                parent: "tasks/alchemy-test-task",
                url: "https://example.com/hooks/a2a",
              },
            );
          return { store, engine, assistant, config };
        }),
      );

      expect(created.config.name).toContain("pushNotificationConfigs");
      expect(created.config.tenant).toEqual(created.assistant.name);
      expect(created.config.url).toEqual("https://example.com/hooks/a2a");

      const fetched =
        yield* discoveryengine.getProjectsLocationsCollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfigs(
          { tenant: created.config.tenant, name: created.config.name },
        );
      expect(fetched.name).toEqual(created.config.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.Discoveryengine.CollectionsDataStore(
            "Docs",
            {
              dataStoreId: created.store.dataStoreId,
              location: "global",
              displayName: "a2a-docs",
            },
          );
          const engine = yield* GCP.Discoveryengine.CollectionsEngine(
            "Search",
            {
              engineId: created.engine.engineId,
              location: "global",
              dataStoreIds: [store.dataStoreId],
              displayName: "a2a engine",
            },
          );
          const assistant =
            yield* GCP.Discoveryengine.CollectionsEnginesAssistant("Help", {
              engine: engine.name,
              assistantId: created.assistant.assistantId,
              displayName: "a2a helper",
            });
          const config =
            yield* GCP.Discoveryengine.CollectionsEnginesAssistantsAgentsA2aV1TasksPushNotificationConfig(
              "Notify",
              {
                tenant: assistant.name,
                parent: "tasks/alchemy-test-task",
                configId: created.config.configId,
                url: "https://example.com/hooks/a2a-prod",
              },
            );
          return { store, engine, assistant, config };
        }),
      );

      expect(updated.config.url).toEqual("https://example.com/hooks/a2a-prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.config.tenant,
        created.config.name,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
