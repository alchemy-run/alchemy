import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { projectScopeChanged, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { sameMembers } from "../internal/equal.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import {
  generatedServerObjectName,
  isOnTarget,
  listOwnedServers,
  recordedTarget,
  SERVER_OBJECT_NAME_MAX_LENGTH,
  type ServerTarget,
} from "../internal/servers.ts";
import type { Providers } from "../Providers.ts";
import { getScheduleOrUndefined, listServerSchedules } from "./internal.ts";

/** What each backup a schedule takes looks like. */
export interface ScheduleBackupProperties {
  /** Name of each backup the schedule takes, up to 255 characters. */
  name: string;
  /** Days each backup is kept, from 1 to 36500. */
  retentionPeriod: number;
  /** Volumes to back up. All of the server's volumes if omitted. */
  volumeIds?: string[];
}

export interface ScheduleProps {
  /**
   * Server the schedule backs up. Pass it through a `Stackit.ServerBackup.Enablement` so the
   * schedule deploys after it. Changing it replaces the schedule.
   */
  serverId: string;
  /**
   * Name of the schedule, up to 255 characters. Updates in place.
   *
   * If omitted, a name is generated from the stack, stage and logical ID.
   */
  name?: string;
  /** When to run: an iCalendar (RFC 5545) recurrence rule. Updates in place. */
  rrule: string;
  /**
   * Whether the schedule runs. Updates in place.
   *
   * @default true
   */
  enabled?: boolean;
  /** What each backup looks like. Updates in place. */
  backupProperties: ScheduleBackupProperties;
  /**
   * Project of the server. Defaults to the profile's project. Changing it replaces the
   * schedule.
   */
  projectId?: string;
  /**
   * Region of the server. Defaults to the profile's region. Changing it replaces the schedule.
   */
  region?: string;
}

export interface ScheduleAttributes {
  /** STACKIT schedule id, as the string the API's paths take. Stable across updates. */
  scheduleId: string;
  /** Server the schedule backs up. */
  serverId: string;
  /** Project of the server. */
  projectId: string;
  /** Region of the server. */
  region: string;
  /** Name of the schedule. */
  name: string;
  /** The recurrence rule. */
  rrule: string;
  /** Whether the schedule runs. */
  enabled: boolean;
  /** What each backup looks like, if STACKIT reports it. */
  backupProperties: ScheduleBackupProperties | undefined;
}

export type Schedule = Resource<
  "Stackit.ServerBackup.Schedule",
  ScheduleProps,
  ScheduleAttributes,
  never,
  Providers
>;

/**
 * A recurring backup of a server with STACKIT Server Backup Management, on an iCalendar
 * recurrence rule. The server needs a `Stackit.ServerBackup.Enablement`.
 *
 * Everything but the server, project and region updates in place. Schedules have no labels:
 * Alchemy recognizes its own by the id in state or the generated name, which holds the
 * resource's instance id. A schedule with the same explicit `name` found without state is
 * reported as unowned, and only taken over with `--adopt`. `alchemy unsafe nuke` enumerates
 * only schedules on Alchemy's servers whose name has the generated shape.
 *
 * ### Scheduling Backups
 * **Example:** A nightly backup kept for 14 days
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const server = yield* Stackit.IaaS.Server("Db", {
 *   machineType: "g1.1",
 *   bootVolume: { size: 20, source: { type: "image", id: "<image id>" } },
 *   networking: { networkId: network.networkId },
 * });
 * const backups = yield* Stackit.ServerBackup.Enablement("DbBackups", {
 *   serverId: server.serverId,
 * });
 * const nightly = yield* Stackit.ServerBackup.Schedule("Nightly", {
 *   serverId: backups.serverId,
 *   rrule: "DTSTART;TZID=Europe/Berlin:20260101T020000 RRULE:FREQ=DAILY;INTERVAL=1",
 *   backupProperties: { name: "nightly", retentionPeriod: 14 },
 * });
 * ```
 *
 * ### Backing Up Some Volumes
 * **Example:** Only back up one volume, on a schedule that starts paused
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const server = yield* Stackit.IaaS.Server("Db", {
 *   machineType: "g1.1",
 *   bootVolume: { size: 20, source: { type: "image", id: "<image id>" } },
 *   networking: { networkId: network.networkId },
 * });
 * const data = yield* Stackit.IaaS.Volume("DbData", { size: 100 });
 * const backups = yield* Stackit.ServerBackup.Enablement("DbBackups", {
 *   serverId: server.serverId,
 * });
 * yield* Stackit.ServerBackup.Schedule("DataOnly", {
 *   serverId: backups.serverId,
 *   name: "data-only",
 *   enabled: false,
 *   rrule: "DTSTART;TZID=Europe/Berlin:20260101T030000 RRULE:FREQ=WEEKLY;INTERVAL=1",
 *   backupProperties: {
 *     name: "data",
 *     retentionPeriod: 30,
 *     volumeIds: [data.volumeId],
 *   },
 * });
 * ```
 *
 * ### Pausing at Runtime
 * **Example:** Pause the schedule from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Layer from "effect/Layer";
 *
 * export const Nightly = Stackit.ServerBackup.Schedule("Nightly", {
 *   serverId: "00000000-0000-0000-0000-000000000000",
 *   rrule: "DTSTART;TZID=Europe/Berlin:20260101T020000 RRULE:FREQ=DAILY;INTERVAL=1",
 *   backupProperties: { name: "nightly", retentionPeriod: 14 },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getSchedule = yield* Stackit.ServerBackup.GetSchedule(yield* Nightly);
 *     const updateSchedule = yield* Stackit.ServerBackup.UpdateSchedule(yield* Nightly);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getSchedule();
 *         yield* updateSchedule({
 *           name: live.name,
 *           rrule: live.rrule,
 *           backupProperties: live.backupProperties,
 *           enabled: false,
 *         });
 *         return HttpServerResponse.text("paused");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(
 *         Stackit.ServerBackup.GetScheduleHttp,
 *         Stackit.ServerBackup.UpdateScheduleHttp,
 *       ),
 *     ),
 *   ),
 * ) {}
 * ```
 *
 * ### What Deleting Does <!-- api-prose -->
 * A delete makes one call, to delete this one schedule by its id. It asks STACKIT to delete
 * no backups: a backup the schedule took is a separate object with its own retention. A
 * schedule that's already gone counts as deleted.
 *
 * ### Replacement Cautions <!-- api-prose -->
 * Changing `serverId`, `projectId` or `region` creates a schedule at the new place and
 * deletes the old one, with the old schedule going first if the new server isn't known at
 * plan and the schedule has an explicit `name`. A schedule changed in the portal, or by
 * `Stackit.ServerBackup.UpdateSchedule`, keeps its live values until a deploy changes the
 * schedule's props.
 *
 * @resource
 * @product STACKIT Server Backup Management
 * @category ServerBackup
 */
export const Schedule = Resource<Schedule>("Stackit.ServerBackup.Schedule");

const toBackupProperties = (
  properties: serverBackup.BackupProperties | undefined,
): ScheduleBackupProperties | undefined =>
  properties === undefined
    ? undefined
    : {
        name: properties.name,
        retentionPeriod: properties.retentionPeriod,
        ...(properties.volumeIds !== undefined ? { volumeIds: [...properties.volumeIds] } : {}),
      };

const toAttrs = (
  target: ServerTarget,
  schedule: serverBackup.BackupSchedule,
): ScheduleAttributes => ({
  ...recordedTarget(target),
  scheduleId: String(schedule.id),
  name: schedule.name,
  rrule: schedule.rrule,
  enabled: schedule.enabled,
  backupProperties: toBackupProperties(schedule.backupProperties),
});

/** The full document a PUT sends. Unset `volumeIds` means all volumes. */
const desiredOf = (news: ScheduleProps, name: string) => ({
  name,
  rrule: news.rrule,
  enabled: news.enabled ?? true,
  backupProperties: {
    name: news.backupProperties.name,
    retentionPeriod: news.backupProperties.retentionPeriod,
    ...(news.backupProperties.volumeIds !== undefined
      ? { volumeIds: [...news.backupProperties.volumeIds] }
      : {}),
  },
});

const drifted = (
  observed: serverBackup.BackupSchedule,
  desired: ReturnType<typeof desiredOf>,
): boolean =>
  observed.name !== desired.name ||
  observed.rrule !== desired.rrule ||
  observed.enabled !== desired.enabled ||
  observed.backupProperties?.name !== desired.backupProperties.name ||
  observed.backupProperties?.retentionPeriod !== desired.backupProperties.retentionPeriod ||
  !sameMembers(observed.backupProperties?.volumeIds, desired.backupProperties.volumeIds);

export const ScheduleProvider = () =>
  Provider.succeed(Schedule, {
    stables: ["scheduleId", "serverId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.ServerBackup.Enablement"] },

    // No labels: only generated names on Alchemy's servers are enumerated.
    list: Effect.fn(function* () {
      const servers = yield* listOwnedServers;
      const owned: ScheduleAttributes[] = [];
      for (const target of servers) {
        for (const schedule of yield* listServerSchedules(target)) {
          if (isGeneratedPhysicalName(schedule.name, SERVER_OBJECT_NAME_MAX_LENGTH)) {
            owned.push(toAttrs(target, schedule));
          }
        }
      }
      return owned;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // The spec doesn't say whether a name is unique per server, so an explicit name goes
      // first when the new schedule may land on the same server. A generated one carries
      // the generation, so it can't collide.
      if (hasUnresolvedTrigger<ScheduleProps>(news, ["serverId", "projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<ScheduleProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<ScheduleProps>(news);
      const scopeChanged = yield* projectScopeChanged(resolved, output);
      if (scopeChanged || resolved.serverId !== output.serverId) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const serverId = output?.serverId ?? olds?.serverId;
      if (serverId === undefined) return undefined;
      const target = { ...scope, serverId };
      if (output !== undefined) {
        const byId = yield* getScheduleOrUndefined(target, output.scheduleId);
        if (byId !== undefined) return toAttrs(target, byId);
      }
      const schedules = yield* listServerSchedules(target);
      if (olds?.name === undefined) {
        // A generated name holds this generation's instance id, so finding it proves it's ours.
        const generated = yield* generatedServerObjectName(id, instanceId);
        const found = schedules.find((schedule) => schedule.name === generated);
        return found === undefined ? undefined : toAttrs(target, found);
      }
      // A name found twice is evidently no identity, so it claims nothing.
      const named = schedules.filter((schedule) => schedule.name === olds.name);
      if (named.length !== 1) return undefined;
      const attrs = toAttrs(target, named[0]!);
      const isPrevious = isOnTarget(previous, target) && previous?.scheduleId === attrs.scheduleId;
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const target = { ...scope, serverId: news.serverId };
      const generated = yield* generatedServerObjectName(id, instanceId);
      const name = news.name ?? output?.name ?? generated;
      const desired = desiredOf(news, name);

      // 1. Observe — `output` is a cache for the id, and only names the desired schedule on
      // the same server. Without it, only this generation's generated name can be claimed.
      let current: serverBackup.BackupSchedule | undefined =
        output !== undefined && isOnTarget(output, target)
          ? yield* getScheduleOrUndefined(target, output.scheduleId)
          : undefined;
      if (current === undefined && name === generated) {
        const schedules = yield* listServerSchedules(target);
        current = schedules.find((schedule) => schedule.name === generated);
      }

      // 2. Ensure
      if (current === undefined) {
        current = yield* serverBackup.createBackupSchedule({ ...target, ...desired });
      }

      // 3. Sync — a PUT replaces the whole schedule, so send all of it on any delta.
      if (drifted(current, desired)) {
        current = yield* serverBackup.updateBackupSchedule({
          ...target,
          backupScheduleId: String(current.id),
          ...desired,
        });
      }

      // 4. Return
      return toAttrs(target, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* serverBackup
        .deleteBackupSchedule({
          ...recordedTarget(output),
          backupScheduleId: output.scheduleId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
