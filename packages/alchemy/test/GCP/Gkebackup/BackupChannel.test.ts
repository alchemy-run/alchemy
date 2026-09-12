import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as gkebackup from "@distilled.cloud/gcp/gkebackup_v1";
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
  "getProjectsLocationsBackupChannels on a missing channel fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gkebackup.getProjectsLocationsBackupChannels({
          name: `projects/${project}/locations/us-central1/backupChannels/alchemy-missing-channel`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* gkebackup
        .listProjectsLocationsBackupChannels({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ backupChannels: [] as const }),
          ),
        );
      expect(Array.isArray(page.backupChannels ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create with same-project destination is rejected with BadRequest",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Gkebackup.BackupChannel("Channel", {
              destinationProject: `projects/${project}`,
              description: "alchemy-test-channel",
              labels: { env: "test" },
            });
          }),
        ),
      );
      expect(error._tag).toEqual("BadRequest");
      expect(error.message).toContain(
        "source and destination project cannot be same",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
