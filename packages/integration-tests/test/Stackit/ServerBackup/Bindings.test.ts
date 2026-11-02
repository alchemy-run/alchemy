import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import { slow } from "../IaaS/compute.ts";
import ServerBackupBindingsWorker, { Host, Nightly, RestoreTarget } from "./fixtures/worker.ts";
import { backupStatus, untilAvailable, untilBackupGone } from "./servers.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitServerBackupBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* ServerBackupBindingsWorker;
    const server = yield* Host;
    const schedule = yield* Nightly;
    const restoreTarget = yield* RestoreTarget;
    return {
      url: worker.url.as<string>(),
      projectId: server.projectId,
      region: server.region,
      serverId: server.serverId,
      scheduleId: schedule.scheduleId,
      scheduleName: schedule.name,
      restoreVolumeId: restoreTarget.volumeId,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// One g1.1 server with its boot volume (about EUR 0.05), the service (EUR 0.0064), a 10 GB
// volume and two small backups, billed per started hour: under EUR 0.10 per run, or double if
// the backups push it past an hour. Gated with the server. The
// steps act on one server, and only one backup or restore runs at a time, so they run in order.
describe.sequential.skipIf(slow)(
  "STACKIT Server Backup bindings on a Cloudflare Worker",
  { tags: [...stackitTags("serverbackup", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 1_800_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 1_800_000 });

    // A fresh workers.dev URL, the created key and the account's new memberships take a
    // while to propagate: retry until the route answers `ok`, then report the last answer so
    // a real failure shows its STACKIT error.
    const call = (route: string, params: Record<string, string> = {}) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        const query = new URLSearchParams(params).toString();
        return yield* HttpClient.get(`${url}${route}?${query}`).pipe(
          Effect.timeout("20 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      });

    const target = Effect.gen(function* () {
      const { projectId, region, serverId } = yield* stack;
      return { projectId: projectId!, region: region!, serverId: serverId! };
    });

    const untilServerStatus = (status: string) =>
      Effect.gen(function* () {
        const server = yield* target;
        const live = yield* iaas.getServer(server).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (observed) => observed.status === status,
            times: 30,
          }),
        );
        expect(live.status).toEqual(status);
      });

    /** A backup taken through the binding, once available, with its first volume backup. */
    const takeBackup = (name: string) =>
      Effect.gen(function* () {
        const server = yield* target;
        const body = yield* call("/create-backup", { name });
        expectOk(body);
        const backupId: string = body.result.id;
        const available = yield* untilAvailable(server, backupId);
        return { backupId, volumeBackup: available.volumeBackups?.[0] };
      });

    describe("GetService", () => {
      test.provider(
        "reports the service on",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/get-service");
            expectOk(body);
            expect(body.result.enabled).toBe(true);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListSchedules", () => {
      test.provider(
        "lists the deployed schedule",
        (_stack) =>
          Effect.gen(function* () {
            const { scheduleId } = yield* stack;
            const body = yield* call("/list-schedules");
            expectOk(body);
            const ids = body.result.items.map((schedule: { id: number }) => String(schedule.id));
            expect(ids).toContain(scheduleId);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetSchedule", () => {
      test.provider(
        "reads the bound schedule",
        (_stack) =>
          Effect.gen(function* () {
            const { scheduleName } = yield* stack;
            const body = yield* call("/get-schedule");
            expectOk(body);
            expect(body.result.name).toEqual(scheduleName);
          }),
        { timeout: 240_000 },
      );
    });

    describe("UpdateSchedule", () => {
      test.provider(
        "replaces the bound schedule's settings",
        (_stack) =>
          Effect.gen(function* () {
            const { scheduleId, scheduleName } = yield* stack;
            const body = yield* call("/update-schedule", { name: scheduleName! });
            expectOk(body);
            const server = yield* target;
            const live = yield* serverBackup.getBackupSchedule({
              ...server,
              backupScheduleId: scheduleId!,
            });
            expect(live.backupProperties?.name).toEqual("alchemy-test-updated");
            expect(live.backupProperties?.retentionPeriod).toEqual(2);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListPolicies", () => {
      test.provider(
        "answers with the project's policies",
        (_stack) =>
          Effect.gen(function* () {
            const server = yield* target;
            const body = yield* call("/list-policies");
            expectOk(body);
            const direct = yield* serverBackup.listBackupPolicies({
              projectId: server.projectId,
            });
            expect(body.result.items?.length ?? 0).toEqual(direct.items?.length ?? 0);
          }),
        { timeout: 240_000 },
      );
    });

    describe("CreateBackup", () => {
      test.provider(
        "takes a backup STACKIT then reports available",
        (_stack) =>
          Effect.gen(function* () {
            const server = yield* target;
            const { backupId } = yield* takeBackup("alchemy-test-binding-create");
            expect(yield* backupStatus(server, backupId)).toEqual("available");
          }),
        { timeout: 1_500_000 },
      );
    });

    describe("ListBackups", () => {
      test.provider(
        "lists the backup just taken",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-backups");
            expectOk(body);
            const names = body.result.items.map((backup: { name: string }) => backup.name);
            expect(names).toContain("alchemy-test-binding-create");
          }),
        { timeout: 240_000 },
      );
    });

    /** The backup `CreateBackup` took, for the steps that act on it. */
    const firstBackup = Effect.gen(function* () {
      const server = yield* target;
      const { items } = yield* serverBackup.listBackups(server);
      const backup = items?.find(({ name }) => name === "alchemy-test-binding-create");
      expect(backup?.id).toEqual(expect.any(String));
      return backup!;
    });

    describe("GetBackup", () => {
      test.provider(
        "reads a backup by id",
        (_stack) =>
          Effect.gen(function* () {
            const backup = yield* firstBackup;
            const body = yield* call("/get-backup", { id: backup.id });
            expectOk(body);
            expect(body.result.name).toEqual("alchemy-test-binding-create");
          }),
        { timeout: 240_000 },
      );
    });

    describe("RestoreBackup", () => {
      test.provider(
        "restores the server from a backup, and it comes back",
        (_stack) =>
          Effect.gen(function* () {
            const server = yield* target;
            const backup = yield* firstBackup;
            // Stopped first, as a restore replaces the volumes it runs from.
            yield* iaas.stopServer(server);
            yield* untilServerStatus("INACTIVE");
            const body = yield* call("/restore-backup", { id: backup.id });
            expectOk(body);
            yield* untilServerStatus("ACTIVE");
            yield* untilAvailable(server, backup.id);
          }),
        { timeout: 1_200_000 },
      );
    });

    describe("RestoreVolumeBackup", () => {
      test.provider(
        "restores one volume backup onto a volume",
        (_stack) =>
          Effect.gen(function* () {
            const { restoreVolumeId } = yield* stack;
            const server = yield* target;
            const backup = yield* firstBackup;
            const volumeBackup = backup.volumeBackups?.[0];
            expect(volumeBackup?.id).toEqual(expect.any(String));
            const body = yield* call("/restore-volume-backup", {
              id: backup.id,
              volumeBackup: volumeBackup!.id!,
              volume: restoreVolumeId!,
            });
            expectOk(body);
            const available = yield* untilAvailable(server, backup.id);
            expect(available.status).toEqual("available");
          }),
        { timeout: 1_200_000 },
      );
    });

    describe("DeleteVolumeBackup", () => {
      test.provider(
        "deletes one volume backup of a backup",
        (_stack) =>
          Effect.gen(function* () {
            const server = yield* target;
            const backup = yield* firstBackup;
            const volumeBackupId = backup.volumeBackups?.[0]?.id;
            expect(volumeBackupId).toEqual(expect.any(String));
            const body = yield* call("/delete-volume-backup", {
              id: backup.id,
              volumeBackup: volumeBackupId!,
            });
            expectOk(body);
            const remaining = yield* serverBackup
              .getBackup({ ...server, backupId: backup.id })
              .pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("10 seconds"),
                  until: (observed) =>
                    !observed.volumeBackups?.some((volume) => volume.id === volumeBackupId),
                  times: 30,
                }),
                Effect.map((observed) => observed.volumeBackups?.map((volume) => volume.id)),
                // Its only volume backup can take the whole backup with it.
                Effect.catchTag("NotFound", () => Effect.succeed<Array<string | undefined>>([])),
              );
            expect(remaining).not.toContain(volumeBackupId);
          }),
        { timeout: 600_000 },
      );
    });

    describe("DeleteBackup", () => {
      test.provider(
        "deletes a backup by id",
        (_stack) =>
          Effect.gen(function* () {
            const server = yield* target;
            const { backupId } = yield* takeBackup("alchemy-test-binding-delete");
            const body = yield* call("/delete-backup", { id: backupId });
            expectOk(body);
            expect(yield* untilBackupGone(server, backupId)).toEqual("gone");
          }),
        { timeout: 1_500_000 },
      );
    });
  },
);
