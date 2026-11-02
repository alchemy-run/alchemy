import * as serverUpdate from "@distilled.cloud/stackit/server_update";
import * as Effect from "effect/Effect";
import type { ServerTarget } from "../internal/servers.ts";

/**
 * Shared scaffolding of the Server Update resources. Not exported from the namespace barrel.
 *
 * Every read treats `NotFound` as missing: the spec documents it for a missing server, for a
 * missing object, and on the service read for "Server, or service, Not Found".
 */

/** Whether the service is on for the server. A missing server or service is off. */
export const isUpdateServiceEnabled = (target: ServerTarget) =>
  serverUpdate.getServiceResource(target).pipe(
    Effect.map(({ enabled }) => enabled === true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

export const listServerSchedules = (target: ServerTarget) =>
  serverUpdate.listUpdateSchedules(target).pipe(
    Effect.map(({ items }) => [...(items ?? [])]),
    Effect.catchTag("NotFound", () => Effect.succeed<serverUpdate.UpdateSchedule[]>([])),
  );

export const getScheduleOrUndefined = (target: ServerTarget, scheduleId: string) =>
  serverUpdate
    .getUpdateSchedule({ ...target, scheduleId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
