import * as service from "@distilled.cloud/clickhouse-cloud/service";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { FeatureUnavailable, requireResult } from "../Errors.ts";
import type { Providers } from "../Providers.ts";

/** One window of the schedule: the scaling a service has on some weekdays between two hours. */
export interface ScalingScheduleEntry {
  /** Name of the window, unique in the schedule. */
  name: string;
  /** Days the window applies, `0` (Sunday) to `6` (Saturday). */
  weekdays: number[];
  /** Hour the window starts, UTC, 0-23. */
  startHourUtc: number;
  /** Hour the window ends, UTC, 0-24. */
  endHourUtc: number;
  /** `vertical` or `horizontal` autoscaling while the window is active. */
  autoscalingMode?: "vertical" | "horizontal";
  /** Minimum memory per replica in GB. */
  minReplicaMemoryGb?: number;
  /** Maximum memory per replica in GB. */
  maxReplicaMemoryGb?: number;
  /** Fixed replica count (vertical autoscaling). */
  numReplicas?: number;
  /** Minimum replicas (horizontal autoscaling). */
  minReplicas?: number;
  /** Maximum replicas (horizontal autoscaling). */
  maxReplicas?: number;
  /** Whether the service may idle during the window. */
  idleScaling?: boolean;
  /** Idle timeout in minutes during the window. */
  idleTimeoutMinutes?: number;
}

export interface ScalingScheduleProps {
  /** ID of the service, e.g. a `ClickHouseCloud.Service.Service`'s `serviceId`. Changing it replaces the resource. */
  serviceId: string;
  /** The schedule's windows; at least one. The whole schedule is replaced on change. */
  entries: ScalingScheduleEntry[];
}

export interface ScalingScheduleAttributes {
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** The windows, each with its server `id` and whether it is active now. */
  entries: Array<ScalingScheduleEntry & { id: string; isActiveNow: boolean }>;
  /** The scaling the service returns to outside every window (the service's own settings). */
  baseConfig: service.ScalingScheduleBaseConfig;
  /** The window active now, if any. */
  activeEntryId: string | undefined;
}

export type ScalingSchedule = Resource<
  "ClickHouseCloud.Service.ScalingSchedule",
  ScalingScheduleProps,
  ScalingScheduleAttributes,
  never,
  Providers
>;

/**
 * A service's scheduled autoscaling: windows during which the service
 * scales differently, e.g. more memory during business hours. Outside every
 * window the service runs with its own scaling settings (the
 * `ClickHouseCloud.Service.Service` props), which this resource never
 * changes.
 *
 * A service has one schedule, replaced as a whole on every change.
 * Destroying the resource deletes the schedule; if a window is active, the
 * service returns to its own settings. Needs the scheduled-autoscaling
 * feature (Scale and Enterprise tiers).
 * @see https://clickhouse.com/docs/manage/scaling
 *
 * ### Scaling on a Schedule
 * **Example:** More memory on weekday business hours
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 *   minReplicaMemoryGb: 8,
 *   maxReplicaMemoryGb: 8,
 * });
 * yield* ClickHouseCloud.Service.ScalingSchedule("BusinessHours", {
 *   serviceId: analytics.serviceId,
 *   entries: [
 *     {
 *       name: "business-hours",
 *       weekdays: [1, 2, 3, 4, 5],
 *       startHourUtc: 8,
 *       endHourUtc: 18,
 *       minReplicaMemoryGb: 16,
 *       maxReplicaMemoryGb: 32,
 *     },
 *   ],
 * });
 * ```
 *
 * :::caution
 * Changing `serviceId` replaces the resource: the old service's schedule
 * is deleted.
 * :::
 *
 * @resource
 * @product Service
 */
export const ScalingSchedule = Resource<ScalingSchedule>("ClickHouseCloud.Service.ScalingSchedule");

const ENTRY_KEYS = [
  "name",
  "weekdays",
  "startHourUtc",
  "endHourUtc",
  "autoscalingMode",
  "minReplicaMemoryGb",
  "maxReplicaMemoryGb",
  "numReplicas",
  "minReplicas",
  "maxReplicas",
  "idleScaling",
  "idleTimeoutMinutes",
] as const satisfies ReadonlyArray<keyof ScalingScheduleEntry>;

/** Whether an observed window matches a declared one in every declared field. */
const covers = (have: service.ScalingScheduleEntry, want: ScalingScheduleEntry) =>
  ENTRY_KEYS.every((key) =>
    want[key] === undefined
      ? true
      : key === "weekdays"
        ? deepEqual(
            [...have.weekdays].sort((a, b) => a - b),
            [...want.weekdays].sort((a, b) => a - b),
          )
        : (have as unknown as Record<string, unknown>)[key] === want[key],
  );

const toAttributes = (
  organizationId: string,
  serviceId: string,
  schedule: service.ScalingSchedule,
): ScalingScheduleAttributes => ({
  serviceId,
  organizationId,
  entries: schedule.entries.map((e) => ({
    id: e.id,
    isActiveNow: e.isActiveNow,
    name: e.name,
    weekdays: [...e.weekdays],
    startHourUtc: e.startHourUtc,
    endHourUtc: e.endHourUtc,
    autoscalingMode: e.autoscalingMode,
    minReplicaMemoryGb: e.minReplicaMemoryGb,
    maxReplicaMemoryGb: e.maxReplicaMemoryGb,
    minReplicas: e.minReplicas,
    maxReplicas: e.maxReplicas,
    idleScaling: e.idleScaling,
    idleTimeoutMinutes: e.idleTimeoutMinutes,
  })),
  baseConfig: schedule.baseConfig,
  activeEntryId: schedule.activeEntryId,
});

const getSchedule = (organizationId: string, serviceId: string) =>
  service.getScalingSchedule({ organizationId, serviceId }).pipe(
    Effect.flatMap(requireResult("getScalingSchedule")),
    // No schedule, or no service.
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const ScalingScheduleProvider = () =>
  Provider.effect(
    ScalingSchedule,
    Effect.succeed({
      stables: ["serviceId", "organizationId"],
      // One per service: deleting the services removes them.
      nuke: { singleton: true, dependsOn: ["ClickHouseCloud.Service.Service"] },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (news.serviceId !== olds.serviceId) return { action: "replace" } as const;
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const serviceId = output?.serviceId ?? olds.serviceId;
        const schedule = yield* getSchedule(organizationId, serviceId);
        return schedule === undefined
          ? undefined
          : toAttributes(organizationId, serviceId, schedule);
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId } = news;
        // An empty list would clear the schedule, which is what destroy is for.
        if (news.entries.length === 0) {
          return yield* new FeatureUnavailable({
            feature: "ScalingSchedule",
            reason: "a schedule needs at least one entry; remove the resource to clear it",
          });
        }
        // Observe
        const observed = yield* getSchedule(organizationId, serviceId);
        const inSync =
          observed !== undefined &&
          observed.entries.length === news.entries.length &&
          news.entries.every((want) =>
            observed.entries.some((have) => have.name === want.name && covers(have, want)),
          );
        if (inSync) return toAttributes(organizationId, serviceId, observed);
        // Ensure + sync: the upsert replaces the whole schedule.
        const updated = yield* service
          .upsertScalingSchedule({ organizationId, serviceId, entries: news.entries })
          .pipe(Effect.flatMap(requireResult("upsertScalingSchedule")));
        return toAttributes(organizationId, serviceId, updated);
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* service
          .deleteScalingSchedule({
            organizationId: output.organizationId,
            serviceId: output.serviceId,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
