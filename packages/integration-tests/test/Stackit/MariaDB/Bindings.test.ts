import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import MariaDBBindingsWorker, { AppCredential, Instance } from "./fixtures/worker.ts";
import { slow } from "./mariadb.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitMariaDBBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* MariaDBBindingsWorker;
    const instance = yield* Instance;
    const credential = yield* AppCredential;
    return {
      url: worker.url.as<string>(),
      instanceName: instance.name,
      planName: instance.planName,
      credentialId: credential.credentialId,
      username: credential.username,
      host: credential.host,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

const options = { timeout: 600_000 } as const;

// The instance is billed per started hour: gated behind STACKIT_TEST_SLOW, like the
// suites of the same resources. Backups, restarts and updates act on one instance, so
// the bindings run one after another, each after the instance has settled.
describe.sequential.skipIf(slow)(
  "STACKIT MariaDB bindings on a Cloudflare Worker",
  { tags: [...stackitTags("mariadb", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 2_700_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 2_700_000 });

    /** One attempt at a route. */
    const fetchRoute = (route: string, id?: string | number) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        const query = id === undefined ? "" : `?id=${encodeURIComponent(String(id))}`;
        return yield* HttpClient.get(`${url}${route}${query}`).pipe(
          Effect.timeout("20 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
        );
      });

    // A fresh workers.dev URL, the created key and the account's new memberships take a
    // while to propagate, and an instance mid-change rejects calls: retry until the route
    // answers `ok`, then report the last answer so a real failure shows its STACKIT error.
    const call = (route: string, id?: string | number) =>
      fetchRoute(route, id).pipe(
        Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
        Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 30 }),
        Effect.catch((body) => Effect.succeed(body as Body)),
      );

    /** Wait until the instance reports `active` again after a change. */
    const settled = call("/get-instance").pipe(
      Effect.repeat({
        schedule: Schedule.spaced("15 seconds"),
        until: (body) => body.result?.status === "active",
        times: 30,
      }),
    );

    /** The first backup that can be downloaded, once `CreateBackup` has produced one. */
    const finishedBackup = call("/list-backups").pipe(
      Effect.repeat({
        schedule: Schedule.spaced("15 seconds"),
        until: (body) =>
          (body.result ?? []).some((backup: { downloadable?: boolean }) => backup.downloadable),
        times: 30,
      }),
      Effect.map(
        (body): number =>
          body.result.find((backup: { downloadable?: boolean }) => backup.downloadable).id,
      ),
    );

    describe("GetInstance", () => {
      test.provider(
        "reads the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceName, planName } = yield* stack;
            const body = yield* call("/get-instance");
            expectOk(body);
            expect(body.result).toEqual({ name: instanceName, status: "active", planName });
          }),
        options,
      );
    });

    describe("ListCredentials", () => {
      test.provider(
        "lists the instance's credentials",
        (_stack) =>
          Effect.gen(function* () {
            const { credentialId } = yield* stack;
            const body = yield* call("/list-credentials");
            expectOk(body);
            expect(body.result.credentialsList.map((item: { id: string }) => item.id)).toContain(
              credentialId,
            );
          }),
        options,
      );
    });

    describe("GetCredential", () => {
      test.provider(
        "reads a credential by id, with its password redacted",
        (_stack) =>
          Effect.gen(function* () {
            const { credentialId, username } = yield* stack;
            const body = yield* call("/get-credential", credentialId);
            expectOk(body);
            expect(body.result).toEqual({ id: credentialId, username, hasPassword: true });
          }),
        options,
      );
    });

    describe("GetMetrics", () => {
      test.provider(
        "reads the instance's metrics",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/get-metrics");
            expectOk(body);
            expect(body.result.memoryTotal).toBeGreaterThan(0);
          }),
        options,
      );
    });

    describe("GetUpdates", () => {
      test.provider(
        "reads the update settings",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/get-updates");
            expectOk(body);
            expect(body.result.automaticUpdatesEnabled).toEqual(expect.any(Boolean));
            expect(body.result.availableUpdates).toEqual(expect.any(Number));
          }),
        options,
      );
    });

    describe("CreateBackup", () => {
      test.provider(
        "starts a backup",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/create-backup");
            expectOk(body);
            expect(body.result.id).toEqual(expect.any(Number));
          }),
        options,
      );
    });

    describe("ListBackups", () => {
      test.provider(
        "lists the backup just started",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-backups");
            expectOk(body);
            expect(body.result.length).toBeGreaterThan(0);
          }),
        options,
      );
    });

    describe("DownloadBackup", () => {
      test.provider(
        "downloads a finished backup as bytes",
        (_stack) =>
          Effect.gen(function* () {
            const backupId = yield* finishedBackup;
            const body = yield* call("/download-backup", backupId);
            expectOk(body);
            expect(body.result.size).toBeGreaterThan(0);
          }),
        options,
      );
    });

    describe("TriggerRestore", () => {
      test.provider(
        "restores a finished backup",
        (_stack) =>
          Effect.gen(function* () {
            const backupId = yield* finishedBackup;
            const body = yield* call("/trigger-restore", backupId);
            expectOk(body);
            expect(body.result.id).toEqual(expect.any(Number));
            yield* settled;
          }),
        options,
      );
    });

    describe("ListRestores", () => {
      test.provider(
        "lists the restore just started",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-restores");
            expectOk(body);
            expect(body.result.instanceRestores.length).toBeGreaterThan(0);
          }),
        options,
      );
    });

    describe("TriggerUpdate", () => {
      test.provider(
        "starts the available updates, or reports the documented conflict",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/trigger-update");
            expectOk(body);
            // A fresh instance can have nothing to update.
            expect(body.result.conflict ?? body.result.instanceId).toBeTruthy();
            yield* settled;
          }),
        options,
      );
    });

    describe("TriggerRestart", () => {
      test.provider(
        "restarts the instance",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/trigger-restart");
            expectOk(body);
            expect(body.result.instanceId).toEqual(expect.any(String));
            yield* settled;
          }),
        options,
      );
    });

    describe("TriggerRecreate", () => {
      test.provider(
        "recreates the instance's machines",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/trigger-recreate");
            expectOk(body);
            expect(body.result.instanceId).toEqual(expect.any(String));
            yield* settled;
          }),
        options,
      );
    });

    describe("Connect", () => {
      test.provider(
        "resolves the connection settings without opening a socket",
        (_stack) =>
          Effect.gen(function* () {
            const { host, username } = yield* stack;
            const body = yield* call("/connect");
            expectOk(body);
            expect(body.result).toMatchObject({
              host,
              username,
              hasPassword: true,
              hasUrl: true,
            });
          }),
        options,
      );
    });
  },
);
