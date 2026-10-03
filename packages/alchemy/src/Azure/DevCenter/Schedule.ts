import * as devcenter from "@distilled.cloud/azure/devcenter";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { sameArm } from "./Common.ts";

export interface ScheduleProps {
  /** Resource group of the project. Changing it replaces the schedule. */
  resourceGroup: string;
  /** Name of the project. Changing it replaces the schedule. */
  project: string;
  /** Name of the pool. Changing it replaces the schedule. */
  pool: string;
  /**
   * Schedule name. Dev Box currently accepts only `default` (the pool's
   * auto-stop schedule). Changing it replaces the schedule.
   * @default "default"
   */
  name?: string;
  /**
   * Action the schedule performs. Changing it replaces the schedule.
   * @default "StopDevBox"
   */
  type?: "StopDevBox";
  /**
   * How often the schedule runs.
   * @default "Daily"
   */
  frequency?: "Daily";
  /** Time of day the schedule runs, as `HH:mm` (24-hour clock). */
  time: string;
  /** IANA time zone of `time`, e.g. `America/Los_Angeles`. */
  timeZone: string;
  /**
   * Whether the schedule is enabled.
   * @default Azure's default (`Enabled`)
   */
  state?: "Enabled" | "Disabled";
  /**
   * User tags (stored in the schedule's `properties.tags`). Alchemy
   * ownership tags are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Schedule extends Resource<
  "Azure.DevCenter.Schedule",
  ScheduleProps,
  {
    /** Name of the schedule. */
    scheduleName: string;
    /** ARM resource ID of the schedule. */
    scheduleId: string;
    /** Name of the pool. */
    pool: string;
    /** Name of the project. */
    project: string;
    /** Resource group of the project. */
    resourceGroup: string;
    /** Action the schedule performs. */
    type: string;
    /** How often the schedule runs. */
    frequency: string;
    /** Time of day the schedule runs (`HH:mm`). */
    time: string;
    /** IANA time zone of `time`. */
    timeZone: string;
    /** Whether the schedule is enabled. */
    state: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A dev box pool schedule — stops every running dev box of the pool at a
 * fixed time each day so idle dev boxes stop accruing compute charges.
 *
 * @see https://learn.microsoft.com/azure/dev-box/how-to-configure-stop-schedule
 *
 * ### Auto-stop
 * **Example:** Stop dev boxes at 7 PM Pacific
 * ```typescript
 * const schedule = yield* Azure.DevCenter.Schedule("stop", {
 *   resourceGroup: group.resourceGroupName,
 *   project: project.projectName,
 *   pool: pool.poolName,
 *   time: "19:00",
 *   timeZone: "America/Los_Angeles",
 * });
 * ```
 *
 * @resource
 */
export const Schedule = Resource<Schedule>("Azure.DevCenter.Schedule");

type Observed = devcenter.GetScheduleResponse;

const getSchedule = (
  subscriptionId: string,
  resourceGroupName: string,
  projectName: string,
  poolName: string,
  scheduleName: string,
) =>
  orUndefinedIfNotFound(
    devcenter.GetSchedule({
      subscriptionId,
      resourceGroupName,
      projectName,
      poolName,
      scheduleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  project: string,
  pool: string,
  name: string,
  observed: Observed,
): Schedule["Attributes"] => ({
  scheduleName: name,
  scheduleId: observed.id ?? "",
  pool,
  project,
  resourceGroup,
  type: observed.properties?.type ?? "",
  frequency: observed.properties?.frequency ?? "",
  time: observed.properties?.time ?? "",
  timeZone: observed.properties?.timeZone ?? "",
  state: observed.properties?.state,
  tags: userTags(observed.properties?.tags),
});

const stateOf = (observed: Observed) => observed.properties?.provisioningState;

export const ScheduleProvider = () =>
  Provider.succeed(Schedule, {
    stables: ["scheduleName", "scheduleId", "pool", "project", "resourceGroup"],

    // Schedules live inside a pool; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.project, output.project) ||
        !sameArm(news.pool, output.pool) ||
        !sameArm(news.name ?? "default", output.scheduleName) ||
        !sameArm(news.type ?? "StopDevBox", output.type)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const project = output?.project ?? olds?.project;
      const pool = output?.pool ?? olds?.pool;
      if (
        resourceGroup === undefined ||
        project === undefined ||
        pool === undefined
      ) {
        return undefined;
      }
      const name = output?.scheduleName ?? olds?.name ?? "default";
      const observed = yield* getSchedule(
        subscriptionId,
        resourceGroup,
        project,
        pool,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, project, pool, name, observed);
      return (yield* isOwned(id, observed.properties?.tags))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DevCenter");
      const { resourceGroup, project, pool } = news;
      const name = news.name ?? "default";
      const tags = yield* desiredTags(id, news.tags);
      const desired = {
        type: news.type ?? "StopDevBox",
        frequency: news.frequency ?? "Daily",
        time: news.time,
        timeZone: news.timeZone,
        state: news.state,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        projectName: project,
        poolName: pool,
        scheduleName: name,
      };
      const label = `dev box pool schedule ${name}`;
      const get = getSchedule(
        subscriptionId,
        resourceGroup,
        project,
        pool,
        name,
      );

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation.
      if (observed === undefined) {
        yield* devcenter.SchedulesCreateOrUpdate({
          ...where,
          properties: { ...desired, tags },
        });
      }
      observed = yield* waitForProvisioned(label, get, stateOf, {
        interval: "5 seconds",
        times: 60,
      });

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const props = observed.properties;
      const delta: devcenter.ScheduleUpdateProperties = {};
      if (props?.frequency !== desired.frequency) {
        delta.frequency = desired.frequency;
      }
      if (props?.time !== desired.time) delta.time = desired.time;
      if (props?.timeZone !== desired.timeZone) {
        delta.timeZone = desired.timeZone;
      }
      if (desired.state !== undefined && props?.state !== desired.state) {
        delta.state = desired.state;
      }
      if (tagsDiffer(props?.tags, tags)) delta.tags = tags;
      if (Object.keys(delta).length > 0) {
        yield* devcenter.UpdateSchedule({ ...where, properties: delta });
        observed = yield* waitForProvisioned(label, get, stateOf, {
          interval: "5 seconds",
          times: 60,
        });
      }

      return toAttrs(resourceGroup, project, pool, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devcenter.DeleteSchedule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          projectName: output.project,
          poolName: output.pool,
          scheduleName: output.scheduleName,
        }),
      );
      yield* waitUntilGone(
        `dev box pool schedule ${output.scheduleName}`,
        getSchedule(
          subscriptionId,
          output.resourceGroup,
          output.project,
          output.pool,
          output.scheduleName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.DevCenter.Pool", "Azure.Resources.ResourceGroup"],
    },
  });
