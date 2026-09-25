import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as file from "@distilled.cloud/gcp/file_v1";
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

// Instance + backup each take several minutes; skip unless explicitly enabled.
const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_FILESTORE && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  file.getProjectsLocationsBackups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsBackups on a missing backup fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        file.getProjectsLocationsBackups({
          name: `projects/${project}/locations/us-central1/backups/alchemy-filestore-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* file
        .listProjectsLocationsBackups({
          parent: `projects/${project}/locations/-`,
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

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a filestore backup",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const nfs = yield* GCP.Filestore.Instance("Nfs", {
            location: "us-central1-a",
            tier: "BASIC_HDD",
            fileShares: [{ name: "share1", capacityGb: 1024 }],
            networks: [{ network: "default", modes: ["MODE_IPV4"] }],
            labels: { env: "test" },
          });
          const backup = yield* GCP.Filestore.Backup("Nightly", {
            sourceInstance: nfs.name,
            sourceFileShare: "share1",
            location: "us-central1",
            description: "alchemy-test-backup",
            labels: { env: "test" },
          });
          return { nfs, backup };
        }),
      );

      expect(created.backup.name).toContain("/backups/");
      expect(created.backup.backupId).toEqual(expect.any(String));
      expect(created.backup.location).toEqual("us-central1");
      expect(created.backup.sourceInstance).toEqual(created.nfs.name);
      expect(created.backup.sourceFileShare).toEqual("share1");
      expect(created.backup.description).toEqual("alchemy-test-backup");
      expect(created.backup.labels).toMatchObject({ env: "test" });
      expect(created.backup.state).toEqual("READY");

      const fetched = yield* file.getProjectsLocationsBackups({
        name: created.backup.name,
      });
      expect(fetched.name).toEqual(created.backup.name);
      expect(fetched.description).toEqual("alchemy-test-backup");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.sourceFileShare).toEqual("share1");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const nfs = yield* GCP.Filestore.Instance("Nfs", {
            instanceId: created.nfs.instanceId,
            location: "us-central1-a",
            tier: "BASIC_HDD",
            fileShares: [{ name: "share1", capacityGb: 1024 }],
            networks: [{ network: "default", modes: ["MODE_IPV4"] }],
            labels: { env: "test" },
          });
          const backup = yield* GCP.Filestore.Backup("Nightly", {
            sourceInstance: nfs.name,
            sourceFileShare: "share1",
            backupId: created.backup.backupId,
            location: "us-central1",
            description: "alchemy-prod-backup",
            labels: { env: "prod", role: "backup" },
          });
          return { nfs, backup };
        }),
      );

      expect(updated.backup.name).toEqual(created.backup.name);
      expect(updated.backup.description).toEqual("alchemy-prod-backup");
      expect(updated.backup.labels).toMatchObject({
        env: "prod",
        role: "backup",
      });

      const refetched = yield* file.getProjectsLocationsBackups({
        name: created.backup.name,
      });
      expect(refetched.description).toEqual("alchemy-prod-backup");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("backup");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.backup.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
