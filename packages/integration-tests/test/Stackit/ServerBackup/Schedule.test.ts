import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { slow, ubuntuImageId } from "../IaaS/compute.ts";
import { backedUpServer, DAILY, WEEKLY } from "./servers.ts";

const { test } = makeStackitTest();

// Billed per started hour: one g1.1 server with its boot volume (about EUR 0.05) and the
// service (EUR 0.0064), for each of the two cases, under EUR 0.12 per run. The schedules start
// paused, so no backup is taken. Gated with the server.
const options = { tags: stackitTags("serverbackup", "schedule"), timeout: 1_800_000 } as const;

const scheduled = (
  imageId: string,
  props: Pick<
    Stackit.ServerBackup.ScheduleProps,
    "name" | "rrule" | "enabled" | "backupProperties"
  >,
) =>
  Effect.gen(function* () {
    const server = yield* backedUpServer("BackupSchedule", imageId, "10.231.49.0/24");
    const enablement = yield* Stackit.ServerBackup.Enablement("BackupScheduleEnable", {
      serverId: server.serverId,
    });
    const schedule = yield* Stackit.ServerBackup.Schedule("BackupSchedule", {
      serverId: enablement.serverId,
      ...props,
    });
    return { server, schedule };
  });

test.provider.skipIf(slow)(
  "create a schedule, update it in place, and delete only it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const imageId = yield* ubuntuImageId(projectId, region);
      yield* stack.destroy();

      const props = {
        rrule: DAILY,
        enabled: false,
        backupProperties: { name: "alchemy-test", retentionPeriod: 1 },
      };
      const created = yield* stack.deploy(scheduled(imageId, props));
      const target = { projectId, region, serverId: created.server.serverId };
      const backupScheduleId = created.schedule.scheduleId;
      expect(backupScheduleId).toEqual(expect.any(String));
      const fetched = yield* serverBackup.getBackupSchedule({ ...target, backupScheduleId });
      expect(fetched).toMatchObject({
        name: created.schedule.name,
        rrule: DAILY,
        enabled: false,
        backupProperties: { name: "alchemy-test", retentionPeriod: 1 },
      });

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(scheduled(imageId, props));
      expect(plan.resources.BackupSchedule).toMatchObject({ action: "noop" });

      // Every mutable aspect updates in place, under the same id.
      const updated = yield* stack.deploy(
        scheduled(imageId, {
          name: "alchemy-test-schedule-renamed",
          rrule: WEEKLY,
          enabled: false,
          backupProperties: { name: "alchemy-test-2", retentionPeriod: 2 },
        }),
      );
      expect(updated.schedule.scheduleId).toEqual(backupScheduleId);
      const changed = yield* serverBackup.getBackupSchedule({ ...target, backupScheduleId });
      expect(changed).toMatchObject({
        name: "alchemy-test-schedule-renamed",
        rrule: WEEKLY,
        backupProperties: { name: "alchemy-test-2", retentionPeriod: 2 },
      });

      // A schedule this stack didn't make, on the same server, is left alone by the
      // schedule's delete. Its only effect is that the enablement then refuses.
      const foreign = yield* serverBackup.createBackupSchedule({
        ...target,
        name: "alchemy-test-other-schedule",
        rrule: DAILY,
        enabled: false,
        backupProperties: { name: "other", retentionPeriod: 1 },
      });
      const refused = yield* stack.destroy().pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "Stackit.ServerBackup.EnablementNotEmpty",
        schedules: ["alchemy-test-other-schedule"],
      });
      const { items } = yield* serverBackup.listBackupSchedules(target);
      expect(items?.map((schedule) => String(schedule.id))).toEqual([String(foreign.id)]);

      yield* serverBackup.deleteBackupSchedule({
        ...target,
        backupScheduleId: String(foreign.id),
      });
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "an explicit name found without state is unowned",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const imageId = yield* ubuntuImageId(projectId, region);
      yield* stack.destroy();

      const host = (withSchedule: boolean) =>
        Effect.gen(function* () {
          const server = yield* backedUpServer("BackupOwned", imageId, "10.231.50.0/24");
          const enablement = yield* Stackit.ServerBackup.Enablement("BackupOwnedEnable", {
            serverId: server.serverId,
          });
          if (withSchedule) {
            yield* Stackit.ServerBackup.Schedule("BackupOwnedSchedule", {
              serverId: enablement.serverId,
              name: "alchemy-test-taken-name",
              rrule: DAILY,
              enabled: false,
              backupProperties: { name: "taken", retentionPeriod: 1 },
            });
          }
          return { server };
        });

      const { server } = yield* stack.deploy(host(false));
      const target = { projectId, region, serverId: server.serverId };
      const foreign = yield* serverBackup.createBackupSchedule({
        ...target,
        name: "alchemy-test-taken-name",
        rrule: WEEKLY,
        enabled: false,
        backupProperties: { name: "foreign", retentionPeriod: 1 },
      });

      const error = yield* stack.deploy(host(true)).pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");
      const untouched = yield* serverBackup.getBackupSchedule({
        ...target,
        backupScheduleId: String(foreign.id),
      });
      expect(untouched.rrule).toEqual(WEEKLY);

      yield* serverBackup.deleteBackupSchedule({
        ...target,
        backupScheduleId: String(foreign.id),
      });
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
