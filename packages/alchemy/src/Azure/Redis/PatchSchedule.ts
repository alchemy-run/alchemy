import * as redis from "@distilled.cloud/azure/redis";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { cacheOwnedByStage, lower, whileCacheBusy } from "./Common.ts";

export type PatchScheduleDay =
  | "Monday"
  | "Tuesday"
  | "Wednesday"
  | "Thursday"
  | "Friday"
  | "Saturday"
  | "Sunday"
  | "Everyday"
  | "Weekend";

/** One weekly maintenance window. */
export interface PatchScheduleEntry {
  /** Day (or `Everyday` / `Weekend`) the window opens. */
  dayOfWeek: PatchScheduleDay;
  /** Hour (0-23, UTC) the window opens. */
  startHourUtc: number;
  /**
   * ISO 8601 duration of the window; at least 5 hours.
   * @default "PT5H"
   */
  maintenanceWindow?: string;
}

export interface PatchScheduleProps {
  /** Resource group of the cache. Changing it replaces the schedule. */
  resourceGroup: string;
  /** Name of the `Azure.Redis.Cache`. Changing it replaces the schedule. */
  cache: string;
  /** Weekly windows in which Azure may patch the cache. */
  scheduleEntries: PatchScheduleEntry[];
}

export interface PatchSchedule extends Resource<
  "Azure.Redis.PatchSchedule",
  PatchScheduleProps,
  {
    /** ARM resource ID of the schedule. */
    patchScheduleId: string;
    /** Name of the cache. */
    cache: string;
    /** Resource group of the cache. */
    resourceGroup: string;
    /** Windows as Azure stores them (with the effective `maintenanceWindow`). */
    scheduleEntries: PatchScheduleEntry[];
  },
  never,
  Providers
> {}

/**
 * The maintenance windows in which Azure applies Redis server updates to
 * an `Azure.Redis.Cache`. A cache has at most one schedule; deleting it
 * returns the cache to Azure-chosen patch times.
 *
 * @see https://learn.microsoft.com/azure/azure-cache-for-redis/cache-administration#schedule-updates
 *
 * ### Scheduling Updates
 * **Example:** Patch on Saturday and Sunday nights
 * ```typescript
 * const cache = yield* Azure.Redis.Cache("cache", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Redis.PatchSchedule("patching", {
 *   resourceGroup: group.resourceGroupName,
 *   cache: cache.cacheName,
 *   scheduleEntries: [
 *     { dayOfWeek: "Saturday", startHourUtc: 2 },
 *     { dayOfWeek: "Sunday", startHourUtc: 2, maintenanceWindow: "PT6H" },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const PatchSchedule = Resource<PatchSchedule>(
  "Azure.Redis.PatchSchedule",
);

const DEFAULT_WINDOW = "PT5H";

const getSchedule = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    redis.GetPatchSchedule({
      subscriptionId,
      resourceGroupName,
      name,
      default: "default",
    }),
  );

const normalize = (entries: readonly PatchScheduleEntry[]) =>
  entries
    .map(
      (entry) =>
        `${entry.dayOfWeek.toLowerCase()}/${entry.startHourUtc}/${(entry.maintenanceWindow ?? DEFAULT_WINDOW).toUpperCase()}`,
    )
    .sort()
    .join(",");

const toAttrs = (
  resourceGroup: string,
  cache: string,
  schedule: redis.GetPatchScheduleResponse,
): PatchSchedule["Attributes"] => ({
  patchScheduleId: schedule.id ?? "",
  cache,
  resourceGroup,
  scheduleEntries: schedule.properties.scheduleEntries.map((entry) => ({
    dayOfWeek: entry.dayOfWeek as PatchScheduleDay,
    startHourUtc: entry.startHourUtc,
    maintenanceWindow: entry.maintenanceWindow,
  })),
});

export const PatchScheduleProvider = () =>
  Provider.succeed(PatchSchedule, {
    stables: ["patchScheduleId", "cache", "resourceGroup"],

    // The schedule lives inside a cache; nuke removes it with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.cache) !== lower(output.cache)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cache = output?.cache ?? olds?.cache;
      if (resourceGroup === undefined || cache === undefined) return undefined;
      const observed = yield* getSchedule(subscriptionId, resourceGroup, cache);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cache, observed);
      return (yield* cacheOwnedByStage(subscriptionId, resourceGroup, cache))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cache");
      const { resourceGroup, cache } = news;

      // Observe.
      let observed = yield* getSchedule(subscriptionId, resourceGroup, cache);

      // Ensure + sync: the singleton PUT is an upsert; send it only when the
      // windows differ from what Azure stores.
      if (
        observed === undefined ||
        normalize(observed.properties.scheduleEntries as PatchScheduleEntry[]) !==
          normalize(news.scheduleEntries)
      ) {
        yield* redis
          .PatchSchedulesCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            name: cache,
            default: "default",
            properties: { scheduleEntries: news.scheduleEntries },
          })
          .pipe(Effect.retry(whileCacheBusy));
        observed = yield* redis.GetPatchSchedule({
          subscriptionId,
          resourceGroupName: resourceGroup,
          name: cache,
          default: "default",
        });
      }
      return toAttrs(resourceGroup, cache, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        redis
          .DeletePatchSchedule({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            name: output.cache,
            default: "default",
          })
          .pipe(Effect.retry(whileCacheBusy)),
      );
      yield* waitUntilGone(
        `redis patch schedule of ${output.cache}`,
        getSchedule(subscriptionId, output.resourceGroup, output.cache),
        { interval: "5 seconds", times: 40 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Redis.Cache", "Azure.Resources.ResourceGroup"],
    },
  });
