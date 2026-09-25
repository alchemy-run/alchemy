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
  "getProjectsLocationsServicesBackups on a missing backup fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        metastore.getProjectsLocationsServicesBackups({
          name: `projects/${project}/locations/us-central1/services/alchemy-missing-service/backups/alchemy-missing-backup`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* metastore
        .listProjectsLocationsServicesBackups({
          parent: `projects/${project}/locations/-/services/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ backups: [] as const }),
          ),
        );
      expect(Array.isArray(page.backups ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create against a missing service is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Metastore.ServicesBackup("Nightly", {
              service: `projects/${project}/locations/us-central1/services/alchemy-missing-service`,
              description: "alchemy-test-backup",
            });
          }),
        ),
      );
      expect([
        "BadRequest",
        "NotFound",
        "Forbidden",
        "GCP.Metastore.OperationFailed",
        "GCP.Metastore.ResourceFailed",
        "GCP.Metastore.ResourceNotReady",
        "GCP.Metastore.ResourceNotResolved",
      ]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
