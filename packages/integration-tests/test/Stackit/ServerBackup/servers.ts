import * as Stackit from "@alchemy.run/stackit";
import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { MACHINE_TYPE } from "../IaaS/compute.ts";

/** The server every suite here backs up, with the agent STACKIT's image may need. */
export const backedUpServer = (prefix: string, imageId: string, cidr: string) =>
  Effect.gen(function* () {
    const network = yield* Stackit.IaaS.Network(`${prefix}Network`, { ipv4: { prefix: cidr } });
    return yield* Stackit.IaaS.Server(`${prefix}Server`, {
      machineType: MACHINE_TYPE,
      bootVolume: { size: 10, source: { type: "image", id: imageId }, deleteOnTermination: true },
      networking: { networkId: network.networkId },
      agent: { provisioned: true },
    });
  });

export const DAILY = "DTSTART;TZID=Europe/Berlin:20260101T020000 RRULE:FREQ=DAILY;INTERVAL=1";
export const WEEKLY = "DTSTART;TZID=Europe/Berlin:20260101T030000 RRULE:FREQ=WEEKLY;INTERVAL=1";

export interface Target {
  readonly projectId: string;
  readonly region: string;
  readonly serverId: string;
}

/** Out of band: the service's switch, with a missing server or service as off. */
export const serviceEnabled = (target: Target) =>
  serverBackup.getServiceResource(target).pipe(
    Effect.map(({ enabled }) => enabled === true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

/** Out of band: a backup, until it reports `available`. */
export const untilAvailable = (target: Target, backupId: string) =>
  serverBackup.getBackup({ ...target, backupId }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("15 seconds"),
      until: (backup) => backup.status === "available",
      times: 80,
    }),
  );

/** Out of band: a backup's status, `gone` when the API no longer has it. */
export const backupStatus = (target: Target, backupId: string) =>
  serverBackup.getBackup({ ...target, backupId }).pipe(
    Effect.map((backup): string => backup.status),
    Effect.catchTag("NotFound", () => Effect.succeed("gone")),
  );

/** Out of band: bounded wait until a backup is gone. */
export const untilBackupGone = (target: Target, backupId: string) =>
  backupStatus(target, backupId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 60,
    }),
  );
