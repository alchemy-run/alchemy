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

const runLifecycle = hasGcpCreds && !process.env.FAST;
const project = process.env.GOOGLE_PROJECT_ID ?? "";
const parentId = "alchds3site";

const waitUntilGone = (name: string) =>
  discoveryengine
    .getProjectsLocationsDataStoresSiteSearchEngineTargetSites({ name })
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
  "getProjectsLocationsDataStoresSiteSearchEngineTargetSites on a missing site fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsDataStoresSiteSearchEngineTargetSites(
          {
            name: `projects/${project}/locations/global/dataStores/alchemy-missing/siteSearchEngine/targetSites/alchemy-missing`,
          },
        ),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a site search target site",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = yield* ensureDataStore(project, parentId, {
        contentConfig: "PUBLIC_WEBSITE",
      });

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Discoveryengine.DataStoresSiteSearchEngineTargetSite(
            "Docs",
            {
              dataStore: parent.name ?? "",
              type: "INCLUDE",
            },
          );
        }),
      );

      expect(created.name).toContain("/targetSites/");
      expect(
        created.providedUriPattern ?? created.generatedUriPattern,
      ).toBeDefined();

      const fetched =
        yield* discoveryengine.getProjectsLocationsDataStoresSiteSearchEngineTargetSites(
          { name: created.name },
        );
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Discoveryengine.DataStoresSiteSearchEngineTargetSite(
            "Docs",
            {
              dataStore: parent.name ?? "",
              providedUriPattern: created.providedUriPattern,
              type: created.type ?? "INCLUDE",
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
