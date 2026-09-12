import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudsearch from "@distilled.cloud/gcp/cloudsearch_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { hasGcpCreds, logLevel, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  cloudsearch.getSettingsDatasources({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getSettingsDatasources on a missing datasource fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudsearch.getSettingsDatasources({
          name: "datasources/alchemy-missing-datasource",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CLOUDSEARCH)(
  "createSettingsDatasources without Cloud Search admin fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudsearch.createSettingsDatasources({
          body: {
            displayName: "Alchemy Cloud Search Probe",
            shortName: "alchprobe",
          },
        }),
      );
      expect(["Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a datasource",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Cloudsearch.SettingsDatasource("Wiki", {
            displayName: "Wiki",
            shortName: "wiki",
            returnThumbnailUrls: true,
          });
        }),
      );

      expect(created.name.startsWith("datasources/")).toEqual(true);
      expect(created.datasourceId.length).toBeGreaterThan(0);
      expect(created.displayName).toEqual("Wiki");
      expect(created.shortName).toEqual("wiki");
      expect(created.returnThumbnailUrls).toEqual(true);

      const fetched = yield* cloudsearch.getSettingsDatasources({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Cloudsearch.SettingsDatasource("Wiki", {
            datasourceId: created.datasourceId,
            displayName: "Knowledge base",
            shortName: "wiki",
            disableServing: true,
            returnThumbnailUrls: true,
          });
        }),
      );

      expect(updated.datasourceId).toEqual(created.datasourceId);
      expect(updated.displayName).toEqual("Knowledge base");
      expect(updated.disableServing).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
