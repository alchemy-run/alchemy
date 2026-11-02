import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as postgres from "@distilled.cloud/stackit/postgres_flex";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import PostgresFlexBindingsWorker, { AppDatabase, AppUser, Db } from "./fixtures/worker.ts";
import { slow } from "./postgres.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitPostgresFlexBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* PostgresFlexBindingsWorker;
    const db = yield* Db;
    const user = yield* AppUser;
    const database = yield* AppDatabase;
    return {
      url: worker.url.as<string>(),
      projectId: db.projectId,
      region: db.region,
      instanceId: db.instanceId,
      host: db.host,
      port: db.port,
      userId: user.userId,
      userName: user.userName,
      databaseId: database.databaseId,
      databaseName: database.name,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// The instance is billed per started hour: gated behind STACKIT_TEST_SLOW, like the
// suites of the same resources. Password resets act on one user, so the bindings run
// one after another.
describe.sequential.skipIf(slow)(
  "STACKIT PostgreSQL Flex bindings on a Cloudflare Worker",
  { tags: [...stackitTags("postgresflex", "bindings"), "provider:cloudflare"] },
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

    describe("GetInstance", () => {
      test.provider(
        "reads the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId, host } = yield* stack;
            const body = yield* call("/get-instance");
            expectOk(body);
            expect(body.result.id).toEqual(instanceId);
            expect(body.result.connectionInfo.write.host).toEqual(host);
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
        "reads a database by id",
        (_stack) =>
          Effect.gen(function* () {
            const { databaseId, databaseName, userName } = yield* stack;
            const body = yield* call("/get-database", { id: databaseId });
            expectOk(body);
            expect(body.result.name).toEqual(databaseName);
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
            const body = yield* call("/get-user", { id: userId });
            expectOk(body);
            expect(body.result.name).toEqual(userName);
            expect(body.result.roles).toEqual(["login"]);
            expect(body.result.password).toBeUndefined();
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListBackups", () => {
      test.provider(
        "answers for the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-backups");
            expectOk(body);
            // The instance may not have reached its first backup yet.
            expect(body.result.pagination.page).toEqual(1);
            expect(Array.isArray(body.result.backups)).toEqual(true);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetBackup", () => {
      test.provider(
        "reads a backup, or reports the typed NotFound",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, instanceId } = yield* stack;
            const { backups } = yield* postgres.listBackups({
              projectId: projectId!,
              region: region!,
              instanceId: instanceId!,
            });
            const backup = backups[0];
            const body = yield* call("/get-backup", { id: backup?.id ?? 999_999_999 });
            expectOk(body);
            expect(body.result).toEqual(backup ?? { missing: true });
          }),
        { timeout: 240_000 },
      );
    });

    describe("ResetUserPassword", () => {
      test.provider(
        "resets the password and keeps it in the Worker",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, instanceId, userId, userName } = yield* stack;
            const body = yield* call("/reset-user-password", { id: userId });
            expectOk(body);
            expect(body.result).toEqual({ name: userName });
            // Out of band: the user survived the reset.
            const user = yield* postgres.getUser({
              projectId: projectId!,
              region: region!,
              instanceId: instanceId!,
              userId: userId!,
            });
            expect(user.name).toEqual(userName);
          }),
        { timeout: 240_000 },
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
            const body = yield* call("/write-instance", { id: userId });
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
            const body = yield* call("/read-write-instance", { id: userId });
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
              ssl: true,
              hasPassword: true,
              urlHost: host,
              urlDatabase: `/${databaseName}`,
              urlSslMode: "require",
            });
          }),
        { timeout: 240_000 },
      );
    });
  },
);
