import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as retail from "@distilled.cloud/gcp/retail_v2";
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

// Retail create returns Forbidden: "AI Commerce Search API has not been
// used in project … or it is disabled."
const runLifecycle =
  hasGcpCreds && !process.env.FAST && process.env.GCP_TEST_RETAIL === "1";
const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  retail.getProjectsLocationsCatalogsModels({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsCatalogsModels on a missing model fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        retail.getProjectsLocationsCatalogsModels({
          name: `projects/${project}/locations/global/catalogs/default_catalog/models/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain(
          "AI Commerce Search API has not been used",
        );
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a catalog model",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Retail.CatalogsModel("Homepage", {
            displayName: "homepage recs",
            type: "recommended-for-you",
            trainingState: "PAUSED",
            filteringOption: "RECOMMENDATIONS_FILTERING_DISABLED",
          });
        }),
      );

      expect(created.name).toContain("/models/");
      expect(created.type).toEqual("recommended-for-you");

      const fetched = yield* retail.getProjectsLocationsCatalogsModels({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toMatch(/\[alc/);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Retail.CatalogsModel("Homepage", {
            modelId: created.modelId,
            catalog: created.catalog,
            displayName: "homepage recs",
            type: "recommended-for-you",
            trainingState: "PAUSED",
            filteringOption: "RECOMMENDATIONS_FILTERING_ENABLED",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.filteringOption).toEqual(
        "RECOMMENDATIONS_FILTERING_ENABLED",
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
