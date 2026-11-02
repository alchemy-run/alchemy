import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { slow, ubuntuImageId } from "../IaaS/compute.ts";
import { backedUpServer, DAILY, serviceEnabled, untilBackupGone } from "./servers.ts";

const { test } = makeStackitTest();

// Billed per started hour: one g1.1 server with its boot volume (about EUR 0.05) and the
// service (EUR 0.0064), plus a small backup, under EUR 0.10 per run. Gated with the server.
const options = { tags: stackitTags("serverbackup", "enablement"), timeout: 1_800_000 } as const;

const enabled = (imageId: string, forceDestroy: boolean | undefined, backupPolicyId?: string) =>
  Effect.gen(function* () {
    const server = yield* backedUpServer("BackupEnable", imageId, "10.231.48.0/24");
    const enablement = yield* Stackit.ServerBackup.Enablement("BackupEnable", {
      serverId: server.serverId,
      ...(forceDestroy !== undefined ? { forceDestroy } : {}),
      ...(backupPolicyId !== undefined ? { backupPolicyId } : {}),
    });
    return { server, enablement };
  });

test.provider.skipIf(slow)(
  "enable, refuse to disable over a foreign schedule, then force it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const imageId = yield* ubuntuImageId(projectId, region);
      yield* stack.destroy();

      const created = yield* stack.deploy(enabled(imageId, undefined));
      const target = { projectId, region, serverId: created.server.serverId };
      expect(created.enablement).toMatchObject({ ...target, enabled: true });
      expect(yield* serviceEnabled(target)).toBe(true);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(enabled(imageId, undefined));
      expect(plan.resources.BackupEnable).toMatchObject({ action: "noop" });

      // Something this stack didn't make stops the disable, and survives.
      const foreign = yield* serverBackup.createBackupSchedule({
        ...target,
        name: "alchemy-test-foreign-schedule",
        rrule: DAILY,
        enabled: false,
        backupProperties: { name: "foreign", retentionPeriod: 1 },
      });
      // A new policy deletes the enablement first, so it can't get through: the plan fails, and
      // an opt-in in the same deploy doesn't reach the old enablement's delete.
      const refusedPlan = yield* stack
        .plan(enabled(imageId, true, "00000000-0000-0000-0000-000000000000"))
        .pipe(Effect.flip);
      expect(refusedPlan).toMatchObject({
        _tag: "Stackit.ServerBackup.EnablementNotEmpty",
        schedules: ["alchemy-test-foreign-schedule"],
      });

      const refused = yield* stack.destroy().pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "Stackit.ServerBackup.EnablementNotEmpty",
        serverId: target.serverId,
        schedules: ["alchemy-test-foreign-schedule"],
        backups: [],
      });
      expect(yield* serviceEnabled(target)).toBe(true);
      const survivor = yield* serverBackup.getBackupSchedule({
        ...target,
        backupScheduleId: String(foreign.id),
      });
      expect(survivor.name).toEqual("alchemy-test-foreign-schedule");

      // A foreign backup too, once the prop opts in, goes with the service.
      const job = yield* serverBackup.createBackup({
        ...target,
        name: "alchemy-test-foreign-backup",
        retentionPeriod: 1,
      });
      yield* stack.deploy(enabled(imageId, true));
      yield* stack.destroy();

      const schedule = yield* serverBackup
        .getBackupSchedule({ ...target, backupScheduleId: String(foreign.id) })
        .pipe(
          Effect.as("present"),
          Effect.catchTag("NotFound", () => Effect.succeed("gone")),
        );
      expect(schedule).toEqual("gone");
      expect(yield* untilBackupGone(target, job.id)).toEqual("gone");
      expect(yield* serviceEnabled(target)).toBe(false);
    }).pipe(logLevel),
  options,
);
