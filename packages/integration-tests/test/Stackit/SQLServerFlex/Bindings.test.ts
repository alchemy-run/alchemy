import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import SqlServerFlexBindingsWorker, { AppDatabase, AppUser, Db, ROLES } from "./fixtures/worker.ts";
import { gated, observeDatabase } from "./sqlserver.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitSqlServerFlexBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* SqlServerFlexBindingsWorker;
    const db = yield* Db;
    const user = yield* AppUser;
    const database = yield* AppDatabase;
    return {
      url: worker.url.as<string>(),
      projectId: db.projectId,
      region: db.region,
      instanceId: db.instanceId,
      host: user.host,
      port: user.port,
      userId: user.userId,
      userName: user.userName,
      databaseId: database.databaseId,
      databaseName: database.name,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// One instance for every binding, billed per started hour plus the licence: gated like
// the suites of the same resources. They run in order: a backup has to exist before it
// can be read or restored, and restoring comes last, since it acts on the database.
describe.sequential.skipIf(gated)(
  "STACKIT SQL Server Flex bindings on a Cloudflare Worker",
  { tags: [...stackitTags("sqlserverflex", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 2_700_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 2_700_000 });

    // A fresh workers.dev URL, the created key and the account's new memberships take
    // a while to propagate: retry until the route answers `ok`, then report the last
    // answer so a real failure shows its STACKIT error.
    const call = (route: string, params: Record<string, string | number> = {}) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        const query = new URLSearchParams(
          Object.entries(params).map(([key, value]) => [key, String(value)]),
        ).toString();
        return yield* HttpClient.get(`${url}${route}?${query}`).pipe(
          Effect.timeout("20 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      });

    /** The newest backup of the bound database, once the service reports one. */
    const firstBackup = Effect.gen(function* () {
      const { projectId, region, instanceId, databaseName } = yield* stack;
      return yield* sqlserver
        .listBackups({ projectId: projectId!, region: region!, instanceId: instanceId! })
        .pipe(
          Effect.map(
            (response) =>
              response.backups.find((entry) => entry.databaseName === databaseName)?.backups[0],
          ),
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (backup) => backup !== undefined,
            times: 60,
          }),
        );
    });

    describe("GetInstance", () => {
      test.provider(
        "reads the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId } = yield* stack;
            const body = yield* call("/get-instance");
            expectOk(body);
            expect(body.result.id).toEqual(instanceId);
            expect(body.result.state).toEqual("READY");
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListDatabases", () => {
      test.provider(
        "lists the instance's databases",
        (_stack) =>
          Effect.gen(function* () {
            const { databaseId } = yield* stack;
            const body = yield* call("/list-databases");
            expectOk(body);
            expect(body.result.databases.map((database: { id: number }) => database.id)).toContain(
              databaseId,
            );
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetDatabase", () => {
      test.provider(
        "reads a database by name",
        (_stack) =>
          Effect.gen(function* () {
            const { databaseId, databaseName, userName } = yield* stack;
            const body = yield* call("/get-database", { name: databaseName! });
            expectOk(body);
            expect(body.result.id).toEqual(databaseId);
            expect(body.result.owner).toEqual(userName);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListUsers", () => {
      test.provider(
        "lists the instance's users",
        (_stack) =>
          Effect.gen(function* () {
            const { userId } = yield* stack;
            const body = yield* call("/list-users");
            expectOk(body);
            expect(body.result.users.map((user: { id: number }) => user.id)).toContain(userId);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetUser", () => {
      test.provider(
        "reads a user by id, without a password",
        (_stack) =>
          Effect.gen(function* () {
            const { userId, userName } = yield* stack;
            const body = yield* call("/get-user", { id: userId! });
            expectOk(body);
            expect(body.result.username).toEqual(userName);
            expect([...body.result.roles].sort()).toEqual([...ROLES].sort());
            expect(body.result.password).toBeUndefined();
          }),
        { timeout: 240_000 },
      );
    });

    describe("ResetUser", () => {
      test.provider(
        "resets the password and keeps it in the Worker",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, instanceId, userId, userName } = yield* stack;
            const body = yield* call("/reset-user", { id: userId! });
            expectOk(body);
            expect(body.result).toEqual({ name: userName });
            // Out of band: the user survived the reset.
            const user = yield* sqlserver.getUser({
              projectId: projectId!,
              region: region!,
              instanceId: instanceId!,
              userId: userId!,
            });
            expect(user.username).toEqual(userName);
          }),
        { timeout: 240_000 },
      );
    });

    describe("TriggerBackup", () => {
      test.provider(
        "starts a backup that the service then lists",
        (_stack) =>
          Effect.gen(function* () {
            const { databaseName } = yield* stack;
            const body = yield* call("/trigger-backup", { name: databaseName! });
            expectOk(body);
            expect(body.result).toEqual({ started: databaseName });
            const backup = yield* firstBackup;
            expect(backup?.id).toEqual(expect.any(Number));
          }),
        { timeout: 900_000 },
      );
    });

    describe("ListBackups", () => {
      test.provider(
        "lists the bound database's backups",
        (_stack) =>
          Effect.gen(function* () {
            const { databaseName } = yield* stack;
            const backup = yield* firstBackup;
            const body = yield* call("/list-backups");
            expectOk(body);
            const entry = body.result.backups.find(
              (candidate: { databaseName: string }) => candidate.databaseName === databaseName,
            );
            expect(entry.backups.map((item: { id: number }) => item.id)).toContain(backup!.id);
          }),
        { timeout: 900_000 },
      );
    });

    describe("GetBackup", () => {
      test.provider(
        "reads a backup by id",
        (_stack) =>
          Effect.gen(function* () {
            const backup = yield* firstBackup;
            const body = yield* call("/get-backup", { id: backup!.id });
            expectOk(body);
            expect(body.result.id).toEqual(backup!.id);
            expect(body.result.name).toEqual(backup!.name);
          }),
        { timeout: 900_000 },
      );
    });

    describe("ReadInstance", () => {
      test.provider(
        "reads the instance and its children through one client",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId, userId, databaseId } = yield* stack;
            const body = yield* call("/read-instance");
            expectOk(body);
            expect(body.result.instance.id).toEqual(instanceId);
            expect(body.result.users.users.map((user: { id: number }) => user.id)).toContain(
              userId,
            );
            expect(
              body.result.databases.databases.map((database: { id: number }) => database.id),
            ).toContain(databaseId);
            expect(body.result.backups.pagination.page).toEqual(1);
            expect(Array.isArray(body.result.restoreJobs.runningRestores)).toEqual(true);
          }),
        { timeout: 240_000 },
      );
    });

    describe("WriteInstance", () => {
      test.provider(
        "resets a password",
        (_stack) =>
          Effect.gen(function* () {
            const { userId, userName } = yield* stack;
            const body = yield* call("/write-instance", { id: userId! });
            expectOk(body);
            expect(body.result).toEqual({ name: userName });
          }),
        { timeout: 240_000 },
      );
    });

    describe("ReadWriteInstance", () => {
      test.provider(
        "reads a user and resets its password",
        (_stack) =>
          Effect.gen(function* () {
            const { userId, userName } = yield* stack;
            const body = yield* call("/read-write-instance", { id: userId! });
            expectOk(body);
            expect(body.result).toEqual({ read: userName, name: userName });
          }),
        { timeout: 240_000 },
      );
    });

    describe("Connect", () => {
      test.provider(
        "resolves the connection settings without opening a socket",
        (_stack) =>
          Effect.gen(function* () {
            const { host, port, databaseName, userName } = yield* stack;
            const body = yield* call("/connect");
            expectOk(body);
            expect(body.result).toEqual({
              host,
              port,
              database: databaseName,
              username: userName,
              encrypt: true,
              hasPassword: true,
              connectionStringServer: `Server=${host},${port}`,
            });
          }),
        { timeout: 240_000 },
      );
    });

    describe("TriggerRestore", () => {
      test.provider(
        "restores a database to a new one at a backup's time",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, instanceId, databaseName } = yield* stack;
            const backup = yield* firstBackup;
            const target = "alchemy_restored";
            const body = yield* call("/trigger-restore", {
              name: databaseName!,
              target,
              time: backup!.completionTime,
            });
            expectOk(body);
            expect(body.result).toEqual({ started: databaseName });
            const restored = yield* observeDatabase(projectId!, region!, instanceId!, target).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("10 seconds"),
                until: (state) => state !== "gone",
                times: 60,
              }),
            );
            expect(restored === "gone" ? "gone" : restored.name).toEqual(target);
          }),
        { timeout: 900_000 },
      );
    });

    describe("ListRestoreJobs", () => {
      test.provider(
        "answers for the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-restore-jobs");
            expectOk(body);
            // A finished restore has left the list, so it may be empty by now.
            expect(Array.isArray(body.result.runningRestores)).toEqual(true);
          }),
        { timeout: 240_000 },
      );
    });

    describe("RestoreDatabaseFromBackup", () => {
      test.provider(
        "accepts a restore of the bound database from its managed backup",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, instanceId, databaseName } = yield* stack;
            yield* firstBackup;
            const body = yield* call("/restore-database-from-backup", { name: databaseName! });
            expectOk(body);
            expect(body.result).toEqual({ started: databaseName });
            // Out of band: the database is still there under its name.
            const live = yield* observeDatabase(
              projectId!,
              region!,
              instanceId!,
              databaseName!,
            ).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("10 seconds"),
                until: (state) => state !== "gone",
                times: 60,
              }),
            );
            expect(live === "gone" ? "gone" : live.name).toEqual(databaseName);
          }),
        { timeout: 900_000 },
      );
    });
  },
);
