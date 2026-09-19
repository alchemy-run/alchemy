import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as metastore from "@distilled.cloud/gcp/metastore_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

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

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsServices on a missing service fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        metastore.getProjectsLocationsServices({
          name: `projects/${project}/locations/us-central1/services/alchemy-missing-service`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* metastore
        .listProjectsLocationsServices({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ services: [] as const }),
          ),
        );
      expect(Array.isArray(page.services ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create is rejected when the Dataproc Metastore API is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Metastore.Service("Hive", {
              location: "us-central1",
              hiveMetastoreConfig: { version: "3.1.2" },
              tier: "DEVELOPER",
              labels: { env: "test" },
            });
          }),
        ),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain("Dataproc Metastore API");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
