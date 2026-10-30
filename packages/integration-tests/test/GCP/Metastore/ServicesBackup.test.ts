import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as metastore from "@distilled.cloud/gcp/metastore_v1";
import * as Effect from "effect/Effect";
import { MetastoreApi, hiveService, logLevel, parentOf, waitUntilGone } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsServicesBackups on a missing backup fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const parent = yield* parentOf;
      yield* stack.destroy();
      yield* stack.deploy(MetastoreApi);

      const error = yield* Effect.flip(
        metastore.getProjectsLocationsServicesBackups({
          name: `${parent}/services/alchemy-missing-service/backups/alchemy-missing-backup`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:metastore", "live"], timeout: 90_000 },
);

// A backup needs a running service, which takes 20–40 minutes to provision,
// so `--fast` skips the lifecycle.
test.provider.skipIf(!!process.env.FAST)(
  "create and delete a backup of a metastore service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          yield* MetastoreApi;
          const service = yield* hiveService({ env: "test" });
          const backup = yield* GCP.Metastore.ServicesBackup("Nightly", {
            service: service.name,
            description: "alchemy-test-backup",
          });
          return { service, backup };
        }),
      );
      expect(created.backup.name).toContain("/backups/");
      expect(created.backup.service).toEqual(created.service.name);
      expect(created.backup.description).toEqual("alchemy-test-backup");

      const fetched = yield* metastore.getProjectsLocationsServicesBackups({
        name: created.backup.name,
      });
      expect(fetched.state).toEqual("ACTIVE");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        metastore.getProjectsLocationsServices({ name: created.service.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:metastore", "live"], timeout: 3_600_000 },
);
