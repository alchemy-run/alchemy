import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as serverUpdate from "@distilled.cloud/stackit/server_update";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { slow, ubuntuImageId } from "../IaaS/compute.ts";
import { DAILY, serviceEnabled, updatedServer } from "./servers.ts";

const { test } = makeStackitTest();

// Billed per started hour: one g1.1 server with its boot volume (about EUR 0.05) and the
// service (EUR 0.005), under EUR 0.06 per run. Gated with the server.
const options = { tags: stackitTags("serverupdate", "enablement"), timeout: 1_800_000 } as const;

const enabled = (imageId: string, forceDestroy: boolean | undefined, updatePolicyId?: string) =>
  Effect.gen(function* () {
    const server = yield* updatedServer("UpdateEnable", imageId, "10.231.53.0/24");
    const enablement = yield* Stackit.ServerUpdate.Enablement("UpdateEnable", {
      serverId: server.serverId,
      ...(forceDestroy !== undefined ? { forceDestroy } : {}),
      ...(updatePolicyId !== undefined ? { updatePolicyId } : {}),
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
      expect(plan.resources.UpdateEnable).toMatchObject({ action: "noop" });

      // A schedule this stack didn't make stops the disable, and survives.
      const foreign = yield* serverUpdate.createUpdateSchedule({
        ...target,
        name: "alchemy-test-foreign-schedule",
        rrule: DAILY,
        enabled: false,
        maintenanceWindow: 1,
      });
      // A new policy deletes the enablement first, so it can't get through: the plan fails, and
      // an opt-in in the same deploy doesn't reach the old enablement's delete.
      const refusedPlan = yield* stack
        .plan(enabled(imageId, true, "00000000-0000-0000-0000-000000000000"))
        .pipe(Effect.flip);
      expect(refusedPlan).toMatchObject({
        _tag: "Stackit.ServerUpdate.EnablementNotEmpty",
        schedules: ["alchemy-test-foreign-schedule"],
      });

      const refused = yield* stack.destroy().pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "Stackit.ServerUpdate.EnablementNotEmpty",
        serverId: target.serverId,
        schedules: ["alchemy-test-foreign-schedule"],
      });
      expect(yield* serviceEnabled(target)).toBe(true);
      const survivor = yield* serverUpdate.getUpdateSchedule({
        ...target,
        scheduleId: String(foreign.id),
      });
      expect(survivor.name).toEqual("alchemy-test-foreign-schedule");

      // Once the prop opts in, it goes with the service.
      yield* stack.deploy(enabled(imageId, true));
      yield* stack.destroy();

      const schedule = yield* serverUpdate
        .getUpdateSchedule({ ...target, scheduleId: String(foreign.id) })
        .pipe(
          Effect.as("present"),
          Effect.catchTag("NotFound", () => Effect.succeed("gone")),
        );
      expect(schedule).toEqual("gone");
      expect(yield* serviceEnabled(target)).toBe(false);
    }).pipe(logLevel),
  options,
);
