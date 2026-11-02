import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/** The newest public Ubuntu image of the region, resolved at plan. */
const ubuntuImage = Output.fromEffect(
  Effect.gen(function* () {
    const { projectId, region } = yield* Stackit.StackitEnvironment.current;
    const { items } = yield* iaas.listImages({ projectId, region, all: true });
    return items
      .filter((image) => image.scope === "public" && /ubuntu/i.test(image.name) && image.id)
      .sort((a, b) => b.name.localeCompare(a.name))[0]!.id!;
  }).pipe(Effect.orDie),
);

export const Network = Stackit.IaaS.Network("BackupBindingsNetwork", {
  ipv4: { prefix: "10.231.52.0/24" },
});

export const Host = Network.pipe(
  Effect.flatMap((network) =>
    Stackit.IaaS.Server("BackupBindingsServer", {
      machineType: "g1.1",
      bootVolume: {
        size: 10,
        source: { type: "image", id: ubuntuImage },
        deleteOnTermination: true,
      },
      networking: { networkId: network.networkId },
      agent: { provisioned: true },
    }),
  ),
);

export const Backups = Host.pipe(
  Effect.flatMap((server) =>
    Stackit.ServerBackup.Enablement("BackupBindingsEnable", {
      serverId: server.serverId,
      // The suite's backups are made at runtime, so the stack doesn't know them.
      forceDestroy: true,
    }),
  ),
);

export const Nightly = Backups.pipe(
  Effect.flatMap((enablement) =>
    Stackit.ServerBackup.Schedule("BackupBindingsSchedule", {
      serverId: enablement.serverId,
      rrule: "DTSTART;TZID=Europe/Berlin:20260101T020000 RRULE:FREQ=DAILY;INTERVAL=1",
      enabled: false,
      backupProperties: { name: "alchemy-test", retentionPeriod: 1 },
    }),
  ),
);

/** A volume for `RestoreVolumeBackup` to restore onto. */
export const RestoreTarget = Stackit.IaaS.Volume("BackupBindingsRestoreTarget", { size: 10 });

/**
 * A Cloudflare Worker with every Server Backup binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class ServerBackupBindingsWorker extends Cloudflare.Worker<ServerBackupBindingsWorker>()(
  "StackitServerBackupBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const server = yield* Host;
    const schedule = yield* Nightly;
    const network = yield* Network;
    const getService = yield* Stackit.ServerBackup.GetService(server);
    const listSchedules = yield* Stackit.ServerBackup.ListSchedules(server);
    const createBackup = yield* Stackit.ServerBackup.CreateBackup(server);
    const getBackup = yield* Stackit.ServerBackup.GetBackup(server);
    const listBackups = yield* Stackit.ServerBackup.ListBackups(server);
    const deleteBackup = yield* Stackit.ServerBackup.DeleteBackup(server);
    const restoreBackup = yield* Stackit.ServerBackup.RestoreBackup(server);
    const restoreVolumeBackup = yield* Stackit.ServerBackup.RestoreVolumeBackup(server);
    const deleteVolumeBackup = yield* Stackit.ServerBackup.DeleteVolumeBackup(server);
    const getSchedule = yield* Stackit.ServerBackup.GetSchedule(schedule);
    const updateSchedule = yield* Stackit.ServerBackup.UpdateSchedule(schedule);
    const listPolicies = yield* Stackit.ServerBackup.ListPolicies(network);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        switch (url.pathname) {
          case "/get-service":
            return yield* respond(getService());
          case "/list-schedules":
            return yield* respond(listSchedules());
          case "/create-backup":
            return yield* respond(createBackup({ name: param("name"), retentionPeriod: 1 }));
          case "/get-backup":
            return yield* respond(getBackup({ backupId: param("id") }));
          case "/list-backups":
            return yield* respond(listBackups());
          case "/delete-backup":
            return yield* respond(deleteBackup({ backupId: param("id") }));
          case "/restore-backup":
            return yield* respond(
              restoreBackup({ backupId: param("id"), startServerAfterRestore: true }),
            );
          case "/restore-volume-backup":
            return yield* respond(
              restoreVolumeBackup({
                backupId: param("id"),
                volumeBackupId: param("volumeBackup"),
                restoreVolumeId: param("volume"),
              }),
            );
          case "/delete-volume-backup":
            return yield* respond(
              deleteVolumeBackup({ backupId: param("id"), volumeBackupId: param("volumeBackup") }),
            );
          case "/get-schedule":
            return yield* respond(getSchedule());
          case "/update-schedule":
            return yield* respond(
              updateSchedule({
                name: param("name"),
                rrule: "DTSTART;TZID=Europe/Berlin:20260101T030000 RRULE:FREQ=WEEKLY;INTERVAL=1",
                enabled: false,
                backupProperties: { name: "alchemy-test-updated", retentionPeriod: 2 },
              }),
            );
          case "/list-policies":
            return yield* respond(listPolicies());
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.ServerBackup.GetServiceHttp,
        Stackit.ServerBackup.ListSchedulesHttp,
        Stackit.ServerBackup.CreateBackupHttp,
        Stackit.ServerBackup.GetBackupHttp,
        Stackit.ServerBackup.ListBackupsHttp,
        Stackit.ServerBackup.DeleteBackupHttp,
        Stackit.ServerBackup.RestoreBackupHttp,
        Stackit.ServerBackup.RestoreVolumeBackupHttp,
        Stackit.ServerBackup.DeleteVolumeBackupHttp,
        Stackit.ServerBackup.GetScheduleHttp,
        Stackit.ServerBackup.UpdateScheduleHttp,
        Stackit.ServerBackup.ListPoliciesHttp,
      ),
    ),
  ),
) {}
