import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as serverUpdate from "@distilled.cloud/stackit/server_update";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { slow, ubuntuImageId } from "../IaaS/compute.ts";
import { DAILY, updatedServer, WEEKLY } from "./servers.ts";

const { test } = makeStackitTest();

// Billed per started hour: one g1.1 server with its boot volume (about EUR 0.05) and the
// service (EUR 0.005), for each of the two cases, under EUR 0.12 per run. The schedules start
// paused, so nothing is patched. Gated with the server.
const options = { tags: stackitTags("serverupdate", "schedule"), timeout: 1_800_000 } as const;

const scheduled = (
  imageId: string,
  props: Pick<
    Stackit.ServerUpdate.ScheduleProps,
    "name" | "rrule" | "enabled" | "maintenanceWindow"
  >,
) =>
  Effect.gen(function* () {
    const server = yield* updatedServer("UpdateSchedule", imageId, "10.231.54.0/24");
    const enablement = yield* Stackit.ServerUpdate.Enablement("UpdateScheduleEnable", {
      serverId: server.serverId,
    });
    const schedule = yield* Stackit.ServerUpdate.Schedule("UpdateSchedule", {
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

      const props = { rrule: DAILY, enabled: false, maintenanceWindow: 1 };
      const created = yield* stack.deploy(scheduled(imageId, props));
      const target = { projectId, region, serverId: created.server.serverId };
      const scheduleId = created.schedule.scheduleId;
      expect(scheduleId).toEqual(expect.any(String));
      const fetched = yield* serverUpdate.getUpdateSchedule({ ...target, scheduleId });
      expect(fetched).toMatchObject({
        name: created.schedule.name,
        rrule: DAILY,
        enabled: false,
        maintenanceWindow: 1,
      });

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(scheduled(imageId, props));
      expect(plan.resources.UpdateSchedule).toMatchObject({ action: "noop" });

      // Every mutable aspect updates in place, under the same id.
      const updated = yield* stack.deploy(
        scheduled(imageId, {
          name: "alchemy-test-schedule-renamed",
          rrule: WEEKLY,
          enabled: false,
          maintenanceWindow: 3,
        }),
      );
      expect(updated.schedule.scheduleId).toEqual(scheduleId);
      const changed = yield* serverUpdate.getUpdateSchedule({ ...target, scheduleId });
      expect(changed).toMatchObject({
        name: "alchemy-test-schedule-renamed",
        rrule: WEEKLY,
        maintenanceWindow: 3,
      });

      // A schedule this stack didn't make, on the same server, is left alone by the
      // schedule's delete. Its only effect is that the enablement then refuses.
      const foreign = yield* serverUpdate.createUpdateSchedule({
        ...target,
        name: "alchemy-test-other-schedule",
        rrule: DAILY,
        enabled: false,
        maintenanceWindow: 1,
      });
      const refused = yield* stack.destroy().pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "Stackit.ServerUpdate.EnablementNotEmpty",
        schedules: ["alchemy-test-other-schedule"],
      });
      const { items } = yield* serverUpdate.listUpdateSchedules(target);
      expect(items?.map((schedule) => String(schedule.id))).toEqual([String(foreign.id)]);

      yield* serverUpdate.deleteUpdateSchedule({ ...target, scheduleId: String(foreign.id) });
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
          const server = yield* updatedServer("UpdateOwned", imageId, "10.231.55.0/24");
          const enablement = yield* Stackit.ServerUpdate.Enablement("UpdateOwnedEnable", {
            serverId: server.serverId,
          });
          if (withSchedule) {
            yield* Stackit.ServerUpdate.Schedule("UpdateOwnedSchedule", {
              serverId: enablement.serverId,
              name: "alchemy-test-taken-name",
              rrule: DAILY,
              enabled: false,
              maintenanceWindow: 1,
            });
          }
          return { server };
        });

      const { server } = yield* stack.deploy(host(false));
      const target = { projectId, region, serverId: server.serverId };
      const foreign = yield* serverUpdate.createUpdateSchedule({
        ...target,
        name: "alchemy-test-taken-name",
        rrule: WEEKLY,
        enabled: false,
        maintenanceWindow: 1,
      });

      const error = yield* stack.deploy(host(true)).pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");
      const untouched = yield* serverUpdate.getUpdateSchedule({
        ...target,
        scheduleId: String(foreign.id),
      });
      expect(untouched.rrule).toEqual(WEEKLY);

      yield* serverUpdate.deleteUpdateSchedule({ ...target, scheduleId: String(foreign.id) });
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
