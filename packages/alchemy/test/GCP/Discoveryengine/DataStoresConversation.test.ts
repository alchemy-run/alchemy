import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { ensureDataStore } from "./parent.ts";

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
  !!process.env.GCP_TEST_DISCOVERYENGINE_LLM;
const project = process.env.GOOGLE_PROJECT_ID ?? "";
const parentId = "alchds3conv";

const waitUntilGone = (name: string) =>
  discoveryengine.getProjectsLocationsDataStoresConversations({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsDataStoresConversations on a missing conversation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsDataStoresConversations({
          name: `projects/${project}/locations/global/dataStores/alchemy-missing/conversations/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "createProjectsLocationsDataStoresConversations without the LLM add-on is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = yield* ensureDataStore(project, parentId, {
        contentConfig: "NO_CONTENT",
      });
      const error = yield* Effect.flip(
        discoveryengine.createProjectsLocationsDataStoresConversations({
          parent: parent.name ?? "",
          body: { userPseudoId: "alchemy-probe" },
        }),
      );
      expect(["BadRequest", "FailedPrecondition", "Forbidden"]).toContain(
        error._tag,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a data store conversation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = yield* ensureDataStore(project, parentId, {
        contentConfig: "NO_CONTENT",
      });

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Discoveryengine.DataStoresConversation("Support", {
            dataStore: parent.name ?? "",
          });
        }),
      );

      expect(created.name).toContain("/conversations/");
      expect(created.dataStore).toEqual(parent.name);

      const fetched =
        yield* discoveryengine.getProjectsLocationsDataStoresConversations({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Discoveryengine.DataStoresConversation("Support", {
            dataStore: parent.name ?? "",
            state: "COMPLETED",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.state).toEqual("COMPLETED");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
