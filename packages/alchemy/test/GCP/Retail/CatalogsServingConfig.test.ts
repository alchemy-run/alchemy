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
  retail.getProjectsLocationsCatalogsServingConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsCatalogsServingConfigs on a missing serving config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        retail.getProjectsLocationsCatalogsServingConfigs({
          name: `projects/${project}/locations/global/catalogs/default_catalog/servingConfigs/alchemy-missing`,
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
  "create, update, and delete a catalog serving config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Retail.CatalogsServingConfig("Preview", {
            displayName: "preview search",
          });
        }),
      );

      expect(created.name).toContain("/servingConfigs/");
      expect(created.solutionTypes).toEqual(
        expect.arrayContaining(["SOLUTION_TYPE_SEARCH"]),
      );

      const fetched = yield* retail.getProjectsLocationsCatalogsServingConfigs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toMatch(/\[alc/);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Retail.CatalogsServingConfig("Preview", {
            servingConfigId: created.servingConfigId,
            catalog: created.catalog,
            displayName: "preview search updated",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("preview search updated");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
