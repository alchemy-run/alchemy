import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as netapp from "@distilled.cloud/gcp/netapp_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withNetworkSlot } from "../networkQuota.ts";
import { NetAppNetwork } from "./fixtures/network.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Volumes mount through Private Service Access to `netapp.servicenetworking.goog`,
// so the lifecycle builds its own network (see fixtures/network.ts). The 2 TiB
// STANDARD pool fills a region's default quota
// (StandardStoragePoolCapacityGiBPerRegion = 2048), so each suite creates its
// pool in `us-west2`, one suite at a time. Pools take minutes to create, so
// `--fast` skips the lifecycle.
const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  netapp.getProjectsLocationsBackupVaultsBackups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsBackupVaultsBackups on a missing backup fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        netapp.getProjectsLocationsBackupVaultsBackups({
          name: `projects/${project}/locations/us-central1/backupVaults/alchemy-missing-vault/backups/alchemy-missing-backup`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* netapp.listProjectsLocationsBackupVaultsBackups({
        parent: `projects/${project}/locations/-/backupVaults/-`,
        pageSize: 10,
      });
      expect((page.backups ?? []).map((item) => item.name)).not.toContain(
        `projects/${project}/locations/us-central1/backupVaults/alchemy-missing-vault/backups/alchemy-missing-backup`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:netapp", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a backup",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* GCP.NetApp.StoragePool("Pool", {
            location: "us-west2",
            network: yield* NetAppNetwork,
            serviceLevel: "STANDARD",
            capacityGib: 2048,
            labels: { env: "test" },
          });
          const volume = yield* GCP.NetApp.Volume("Share", {
            location: "us-west2",
            storagePool: pool.name,
            protocols: ["NFSV3"],
            capacityGib: 100,
            labels: { env: "test" },
          });
          const vault = yield* GCP.NetApp.BackupVault("Vault", {
            location: "us-west2",
            labels: { env: "test" },
          });
          return yield* GCP.NetApp.BackupVaultsBackup("Nightly", {
            location: "us-west2",
            backupVault: vault.name,
            sourceVolume: volume.name,
            description: "alchemy-test-backup",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/backups/");
      expect(created.sourceVolume).toContain("/volumes/");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* netapp.getProjectsLocationsBackupVaultsBackups({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* GCP.NetApp.StoragePool("Pool", {
            location: "us-west2",
            network: yield* NetAppNetwork,
            serviceLevel: "STANDARD",
            capacityGib: 2048,
            labels: { env: "test" },
          });
          const volume = yield* GCP.NetApp.Volume("Share", {
            location: "us-west2",
            storagePool: pool.name,
            protocols: ["NFSV3"],
            capacityGib: 100,
            labels: { env: "test" },
          });
          const vault = yield* GCP.NetApp.BackupVault("Vault", {
            location: "us-west2",
            labels: { env: "test" },
          });
          return yield* GCP.NetApp.BackupVaultsBackup("Nightly", {
            location: "us-west2",
            backupId: created.backupId,
            backupVault: vault.name,
            sourceVolume: volume.name,
            description: "alchemy-prod-backup",
            labels: { env: "prod", role: "backup" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("alchemy-prod-backup");
      expect(updated.labels).toMatchObject({ env: "prod", role: "backup" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(withNetworkSlot, logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:netapp", "live"],
    timeout: 3_600_000,
    exclusive: "gcp:netapp-pools",
  },
);
