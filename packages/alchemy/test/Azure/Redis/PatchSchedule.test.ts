import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as redis from "@distilled.cloud/azure/redis";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSchedule = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    return yield* redis.GetPatchSchedule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      name,
      default: "default",
    });
  });

const program = (entries: Azure.Redis.PatchScheduleEntry[]) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const cache = yield* Azure.Redis.Cache("Cache", {
      resourceGroup: group.resourceGroupName,
      sku: "Basic",
      capacity: 0,
    });
    const schedule = yield* Azure.Redis.PatchSchedule("Schedule", {
      resourceGroup: group.resourceGroupName,
      cache: cache.cacheName,
      scheduleEntries: entries,
    });
    return { group, cache, schedule };
  });

// Needs a Basic C0 cache (~$0.02/hour): cents per run, but 15-20 minutes
// to provision the cache.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a redis patch schedule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cache, schedule } = yield* stack.deploy(
        program([{ dayOfWeek: "Saturday", startHourUtc: 2 }]),
      );
      expect(schedule.scheduleEntries).toEqual([
        { dayOfWeek: "Saturday", startHourUtc: 2, maintenanceWindow: "PT5H" },
      ]);
      const observed = yield* getSchedule(
        group.resourceGroupName,
        cache.cacheName,
      );
      expect(observed.properties.scheduleEntries).toEqual([
        { dayOfWeek: "Saturday", startHourUtc: 2, maintenanceWindow: "PT5H" },
      ]);

      // In-place: move and add windows.
      const updated = yield* stack.deploy(
        program([
          { dayOfWeek: "Sunday", startHourUtc: 4, maintenanceWindow: "PT6H" },
          { dayOfWeek: "Wednesday", startHourUtc: 1 },
        ]),
      );
      expect(updated.schedule.patchScheduleId).toEqual(schedule.patchScheduleId);
      const reobserved = yield* getSchedule(
        group.resourceGroupName,
        cache.cacheName,
      );
      expect(
        [...reobserved.properties.scheduleEntries].sort((a, b) =>
          a.dayOfWeek.localeCompare(b.dayOfWeek),
        ),
      ).toEqual([
        { dayOfWeek: "Sunday", startHourUtc: 4, maintenanceWindow: "PT6H" },
        { dayOfWeek: "Wednesday", startHourUtc: 1, maintenanceWindow: "PT5H" },
      ]);

      yield* stack.destroy();
      expect(
        yield* waitGone(getSchedule(group.resourceGroupName, cache.cacheName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);
