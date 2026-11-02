import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import MongoDBFlexBindingsWorker, { AppUser, Db } from "./fixtures/worker.ts";
import { slow } from "./mongodb.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitMongoDBFlexBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* MongoDBFlexBindingsWorker;
    const db = yield* Db;
    const user = yield* AppUser;
    return {
      url: worker.url.as<string>(),
      projectId: db.projectId,
      region: db.region,
      instanceId: db.instanceId,
      userId: user.userId,
      userName: user.userName,
      database: user.database,
      host: user.host,
      port: user.port,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// The instance is billed per started hour: gated behind STACKIT_TEST_SLOW, like the suites
// of the same resources. Password resets act on one user, so the bindings run one after
// another.
describe.sequential.skipIf(slow)(
  "STACKIT MongoDB Flex bindings on a Cloudflare Worker",
  { tags: [...stackitTags("mongodbflex", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 2_700_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 2_700_000 });

    // A fresh workers.dev URL, the created key and the account's new memberships take a
    // while to propagate: retry until the route answers `ok`, then report the last answer
    // so a real failure shows its STACKIT error.
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

    describe("GetInstance", () => {
      test.provider(
        "reads the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId } = yield* stack;
            const body = yield* call("/get-instance");
            expectOk(body);
            expect(body.result.item.id).toEqual(instanceId);
            expect(body.result.item.status).toEqual("READY");
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
            expect(body.result.items.map((user: { id: string }) => user.id)).toContain(userId);
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
            expect(body.result.item.username).toEqual(userName);
            expect(body.result.item.roles).toEqual(["read"]);
            expect(body.result.item.password).toBeUndefined();
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListBackups", () => {
      test.provider(
        "answers for the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, instanceId } = yield* stack;
            const body = yield* call("/list-backups");
            expectOk(body);
            // The instance may not have reached its first backup yet, so compare with
            // what the deployer sees.
            const { items } = yield* mongodb.listBackups({
              projectId: projectId!,
              region: region!,
              instanceId: instanceId!,
            });
            expect((body.result.items ?? []).length).toEqual((items ?? []).length);
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
            const { items } = yield* mongodb.listBackups({
              projectId: projectId!,
              region: region!,
              instanceId: instanceId!,
            });
            const backup = items?.[0];
            const body = yield* call("/get-backup", { id: backup?.id ?? "missing-backup" });
            expectOk(body);
            expect(body.result).toEqual(
              backup === undefined ? { missing: true } : { item: backup },
            );
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListRestoreJobs", () => {
      test.provider(
        "lists no restore job on an instance nothing restored",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-restore-jobs");
            expectOk(body);
            expect(body.result.items ?? []).toEqual([]);
          }),
        { timeout: 240_000 },
      );
    });

    describe("CloneInstance", () => {
      test.provider(
        "reaches the API with the host's identity, and a point before any backup is rejected",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId } = yield* stack;
            const body = yield* call("/clone-instance", { target: instanceId! });
            expectOk(body);
            expect(body.result).toEqual({ rejected: "BadRequest" });
          }),
        { timeout: 240_000 },
      );
    });

    describe("RestoreInstance", () => {
      test.provider(
        "reaches the API with the host's identity, and an unknown backup is rejected",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId } = yield* stack;
            const body = yield* call("/restore-instance", {
              id: "missing-backup",
              target: instanceId!,
            });
            expectOk(body);
            expect(body.result).toEqual({ rejected: "NotFound" });
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListMetrics", () => {
      test.provider(
        "reads a metric of the instance's hosts",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-metrics");
            expectOk(body);
            expect(body.result.hosts.length).toBeGreaterThan(0);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListAdvisorSlowQueries", () => {
      test.provider(
        "answers for the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-advisor-slow-queries");
            expectOk(body);
            expect(body.result).toEqual(expect.any(Object));
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListSuggestedIndexes", () => {
      test.provider(
        "answers for the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-suggested-indexes");
            expectOk(body);
            expect(body.result).toEqual(expect.any(Object));
          }),
        { timeout: 240_000 },
      );
    });

    describe("ReadInstance", () => {
      test.provider(
        "reads the instance and its children through one client",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId, userId } = yield* stack;
            const body = yield* call("/read-instance");
            expectOk(body);
            expect(body.result.instance.item.id).toEqual(instanceId);
            expect(body.result.users.items.map((user: { id: string }) => user.id)).toContain(
              userId,
            );
            expect(body.result.restores.items ?? []).toEqual([]);
          }),
        { timeout: 240_000 },
      );
    });

    describe("Connect", () => {
      test.provider(
        "resolves the connection settings without opening a socket",
        (_stack) =>
          Effect.gen(function* () {
            const { host, port, database, userName } = yield* stack;
            const body = yield* call("/connect");
            expectOk(body);
            expect(body.result).toEqual({
              host,
              port,
              database,
              username: userName,
              hasPassword: true,
              uriHasUser: true,
            });
          }),
        { timeout: 240_000 },
      );
    });

    // Resets change the user's password, which `Connect` read from the deploy above.
    describe("ResetUser", () => {
      test.provider(
        "resets the password and keeps it in the Worker",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, instanceId, userId, userName } = yield* stack;
            const body = yield* call("/reset-user", { id: userId! });
            expectOk(body);
            expect(body.result).toEqual({ username: userName });
            // Out of band: the user survived the reset.
            const { item } = yield* mongodb.getUser({
              projectId: projectId!,
              region: region!,
              instanceId: instanceId!,
              userId: userId!,
            });
            expect(item?.username).toEqual(userName);
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
            expect(body.result).toEqual({ username: userName });
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
            expect(body.result).toEqual({ read: userName, username: userName });
          }),
        { timeout: 240_000 },
      );
    });
  },
);
