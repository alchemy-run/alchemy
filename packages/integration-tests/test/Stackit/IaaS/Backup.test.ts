import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, GONE, PRESENT, slow } from "./compute.ts";

const { test } = makeStackitTest();

// A backup copies the whole volume into backup storage, which takes
// several minutes even for 1 GB. Cost is a fraction of a cent, but the
// duration exceeds the default suite budget: gated behind STACKIT_TEST_SLOW.
const options = { tags: stackitTags("iaas", "backup"), timeout: 1_800_000 } as const;

const presence = (projectId: string, region: string, backupId: string) =>
  iaas.getBackup({ projectId, region, backupId }).pipe(
    Effect.as(PRESENT),
    Effect.catchTag("NotFound", () => Effect.succeed(GONE)),
  );

const backupOf = (source: "volume" | "snapshot", labels: Record<string, string>) =>
  Effect.gen(function* () {
    const volume = yield* Stackit.IaaS.Volume("BackupVolume", { size: 1 });
    const snapshot = yield* Stackit.IaaS.Snapshot("BackupSnapshot", {
      volumeId: volume.volumeId,
    });
    const backup = yield* Stackit.IaaS.Backup("Backup", {
      source:
        source === "volume"
          ? { type: "volume", id: volume.volumeId }
          : { type: "snapshot", id: snapshot.snapshotId },
      description: "alchemy test backup",
      labels,
    });
    return { volume, snapshot, backup };
  });

test.provider.skipIf(slow)(
  "back up a volume, relabel, switch to a snapshot source, and delete",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(backupOf("volume", { env: "test" }));
      expect(created.backup.backupId).toEqual(expect.any(String));
      expect(created.backup.volumeId).toEqual(created.volume.volumeId);
      expect(created.backup.status).toEqual("AVAILABLE");

      const fetched = yield* iaas.getBackup({
        projectId,
        region,
        backupId: created.backup.backupId,
      });
      expect(fetched.volumeId).toEqual(created.volume.volumeId);
      expect(fetched.description).toEqual("alchemy test backup");
      expect(Stackit.labelRecord(fetched.labels)).toMatchObject({ "alchemy.id": "Backup" });

      // Labels update in place.
      const relabeled = yield* stack.deploy(backupOf("volume", { env: "prod" }));
      expect(relabeled.backup.backupId).toEqual(created.backup.backupId);
      const refetched = yield* iaas.getBackup({
        projectId,
        region,
        backupId: created.backup.backupId,
      });
      expect(Stackit.stripInternalLabels(refetched.labels)).toEqual({ env: "prod" });

      // A snapshot source replaces the backup.
      const replaced = yield* stack.deploy(backupOf("snapshot", { env: "prod" }));
      expect(replaced.backup.backupId).not.toEqual(created.backup.backupId);
      expect(replaced.backup.snapshotId).toEqual(replaced.snapshot.snapshotId);
      yield* expectGone(presence(projectId, region, created.backup.backupId));

      yield* stack.destroy();
      yield* expectGone(presence(projectId, region, replaced.backup.backupId));
    }).pipe(logLevel),
  options,
);
