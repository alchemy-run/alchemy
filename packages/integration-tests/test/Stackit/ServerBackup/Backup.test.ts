import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { MACHINE_TYPE, slow, ubuntuImageId } from "../IaaS/compute.ts";
import { backedUpServer, backupStatus, untilAvailable, untilBackupGone } from "./servers.ts";

const { test } = makeStackitTest();

// Billed per started hour: one g1.1 server with its boot volume (about EUR 0.05) and the
// service (EUR 0.0064), plus three small backups of a 10 GB volume, under EUR 0.10 per run.
// Gated with the server. Backups copy whole volumes, so this takes minutes.
const options = { tags: stackitTags("serverbackup", "backup"), timeout: 1_800_000 } as const;

const backedUp = (imageId: string, retentionPeriod: number, allowReplace?: boolean) =>
  Effect.gen(function* () {
    const server = yield* backedUpServer("BackupOnDemand", imageId, "10.231.51.0/24");
    const enablement = yield* Stackit.ServerBackup.Enablement("BackupOnDemandEnable", {
      serverId: server.serverId,
    });
    const backup = yield* Stackit.ServerBackup.Backup("BackupOnDemand", {
      serverId: enablement.serverId,
      retentionPeriod,
      ...(allowReplace !== undefined ? { allowReplace } : {}),
    });
    return { server, backup };
  });

test.provider.skipIf(slow)(
  "take a backup, replace it new-first, retake a lost one, and delete it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const imageId = yield* ubuntuImageId(projectId, region);
      yield* stack.destroy();

      const created = yield* stack.deploy(backedUp(imageId, 1));
      const target = { projectId, region, serverId: created.server.serverId };
      expect(created.backup.status).toEqual("available");
      expect(created.backup.volumeBackups.length).toBeGreaterThan(0);
      const first = created.backup.backupId;
      expect(yield* backupStatus(target, first)).toEqual("available");

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(backedUp(imageId, 1));
      expect(plan.resources.BackupOnDemand).toMatchObject({ action: "noop" });

      // A retention change can't apply to a taken backup, and a replacement would lose this
      // point in time: the plan fails, naming what changed, and nothing happens.
      const refused = yield* stack.deploy(backedUp(imageId, 2)).pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "Stackit.ServerBackup.BackupImmutable",
        backupId: first,
        changed: ["retentionPeriod"],
      });
      expect(yield* backupStatus(target, first)).toEqual("available");

      // Opted in: the plan says replace, the new one is available, then the old one goes.
      const replacePlan = yield* stack.plan(backedUp(imageId, 2, true));
      expect(replacePlan.resources.BackupOnDemand).toMatchObject({ action: "replace" });
      const replaced = yield* stack.deploy(backedUp(imageId, 2, true));
      const second = replaced.backup.backupId;
      expect(second).not.toEqual(first);
      expect(yield* backupStatus(target, second)).toEqual("available");
      expect(yield* untilBackupGone(target, first)).toEqual("gone");

      // A backup that went away between deploys is noticed at plan and taken again.
      yield* serverBackup.deleteBackup({ ...target, backupId: second });
      yield* untilBackupGone(target, second);
      const lostPlan = yield* stack.plan(backedUp(imageId, 2, true));
      expect(lostPlan.resources.BackupOnDemand).toMatchObject({ action: "update" });
      const retaken = yield* stack.deploy(backedUp(imageId, 2, true));
      expect(retaken.backup.backupId).not.toEqual(second);
      expect(yield* backupStatus(target, retaken.backup.backupId)).toEqual("available");

      yield* stack.destroy();
      expect(yield* untilBackupGone(target, retaken.backup.backupId)).toEqual("gone");
    }).pipe(logLevel),
  options,
);

/** A server on an interface of its own, so changing `userData` deletes it first. */
const nicServer = (prefix: string, imageId: string, cidr: string, userData: string) =>
  Effect.gen(function* () {
    const network = yield* Stackit.IaaS.Network(`${prefix}Network`, { ipv4: { prefix: cidr } });
    const nic = yield* Stackit.IaaS.NetworkInterface(`${prefix}Nic`, {
      networkId: network.networkId,
    });
    return yield* Stackit.IaaS.Server(`${prefix}Server`, {
      machineType: MACHINE_TYPE,
      bootVolume: { size: 10, source: { type: "image", id: imageId }, deleteOnTermination: true },
      networking: { networkInterfaceIds: [nic.networkInterfaceId] },
      agent: { provisioned: true },
      userData,
    });
  });

test.provider.skipIf(slow)(
  "a delete-first server replacement stops at plan, and keeps the backups",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const imageId = yield* ubuntuImageId(projectId, region);
      yield* stack.destroy();

      const program = (userData: string) =>
        Effect.gen(function* () {
          const server = yield* nicServer("BackupKept", imageId, "10.231.52.0/24", userData);
          const enablement = yield* Stackit.ServerBackup.Enablement("BackupKeptEnable", {
            serverId: server.serverId,
          });
          const backup = yield* Stackit.ServerBackup.Backup("BackupKept", {
            serverId: enablement.serverId,
            retentionPeriod: 1,
          });
          return { server, backup };
        });

      const created = yield* stack.deploy(program("#cloud-config\n"));
      const target = { projectId, region, serverId: created.server.serverId };

      const refused = yield* stack
        .deploy(program("#cloud-config\npackages: []\n"))
        .pipe(Effect.flip);
      // Each of the three refuses this at plan; whichever the plan reaches first reports it.
      expect([
        "Stackit.IaaS.ServerHasBackups",
        "Stackit.ServerBackup.EnablementNotEmpty",
        "Stackit.ServerBackup.BackupImmutable",
      ]).toContain(refused._tag);
      expect((yield* iaas.getServer(target)).id).toEqual(target.serverId);
      expect(yield* backupStatus(target, created.backup.backupId)).toEqual("available");

      yield* stack.destroy();
      expect(yield* untilBackupGone(target, created.backup.backupId)).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "a backup the stack doesn't hold stops the server's delete, until the server opts in",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const imageId = yield* ubuntuImageId(projectId, region);
      yield* stack.destroy();

      const FIRST = "#cloud-config\n";
      const created = yield* stack.deploy(
        nicServer("BackupForeign", imageId, "10.231.53.0/24", FIRST),
      );
      const target = { projectId, region, serverId: created.serverId };

      yield* serverBackup.enableServiceResource(target);
      const job = yield* serverBackup.createBackup({
        ...target,
        name: "alchemy-test-foreign-backup",
        retentionPeriod: 1,
      });
      yield* untilAvailable(target, job.id);

      const refusal = {
        _tag: "Stackit.IaaS.ServerHasBackups",
        serverId: target.serverId,
        backups: ["alchemy-test-foreign-backup"],
      };
      // A change that deletes the server first fails at plan, and a destroy fails at the delete.
      const SECOND = "#cloud-config\npackages: []\n";
      expect(
        yield* stack
          .deploy(nicServer("BackupForeign", imageId, "10.231.53.0/24", SECOND))
          .pipe(Effect.flip),
      ).toMatchObject(refusal);
      expect(yield* stack.destroy().pipe(Effect.flip)).toMatchObject(refusal);
      expect((yield* iaas.getServer(target)).id).toEqual(target.serverId);
      expect(yield* backupStatus(target, job.id)).toEqual("available");

      // Deleting it by hand clears the way.
      yield* serverBackup.deleteBackup({ ...target, backupId: job.id });
      yield* untilBackupGone(target, job.id);
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
