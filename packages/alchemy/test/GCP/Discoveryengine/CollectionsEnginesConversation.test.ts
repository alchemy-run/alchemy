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
    .getProjectsLocationsCollectionsEnginesConversations({ name })
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
  "getProjectsLocationsCollectionsEnginesConversations on a missing conversation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsCollectionsEnginesConversations({
          name: `projects/${project}/locations/global/collections/default_collection/engines/alchemy-missing/conversations/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an engine conversation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.Discoveryengine.CollectionsDataStore(
            "Docs",
            {
              location: "global",
              displayName: "conversation-docs",
            },
          );
          const engine = yield* GCP.Discoveryengine.CollectionsEngine(
            "Search",
            {
              location: "global",
              dataStoreIds: [store.dataStoreId],
              displayName: "conversation engine",
            },
          );
          const conversation =
            yield* GCP.Discoveryengine.CollectionsEnginesConversation("Chat", {
              engine: engine.name,
              state: "IN_PROGRESS",
            });
          return { store, engine, conversation };
        }),
      );

      expect(created.conversation.name).toContain("/conversations/");
      expect(created.conversation.engine).toEqual(created.engine.name);
      expect(created.conversation.state).toEqual("IN_PROGRESS");

      const fetched =
        yield* discoveryengine.getProjectsLocationsCollectionsEnginesConversations(
          { name: created.conversation.name },
        );
      expect(fetched.name).toEqual(created.conversation.name);
      expect(fetched.userPseudoId).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* GCP.Discoveryengine.CollectionsDataStore(
            "Docs",
            {
              dataStoreId: created.store.dataStoreId,
              location: "global",
              displayName: "conversation-docs",
            },
          );
          const engine = yield* GCP.Discoveryengine.CollectionsEngine(
            "Search",
            {
              engineId: created.engine.engineId,
              location: "global",
              dataStoreIds: [store.dataStoreId],
              displayName: "conversation engine",
            },
          );
          const conversation =
            yield* GCP.Discoveryengine.CollectionsEnginesConversation("Chat", {
              engine: engine.name,
              state: "COMPLETED",
            });
          return { store, engine, conversation };
        }),
      );

      expect(updated.conversation.name).toEqual(created.conversation.name);
      expect(updated.conversation.state).toEqual("COMPLETED");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.conversation.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
