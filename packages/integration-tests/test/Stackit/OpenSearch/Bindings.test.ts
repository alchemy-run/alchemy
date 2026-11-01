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
import OpenSearchBindingsWorker, { App, Search } from "./fixtures/worker.ts";
import { slow } from "./opensearch.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitOpenSearchBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* OpenSearchBindingsWorker;
    const instance = yield* Search;
    const credential = yield* App;
    return {
      url: worker.url.as<string>(),
      instanceId: instance.instanceId,
      credentialId: credential.credentialId,
      username: credential.username,
      host: credential.host,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// The instance is billed per started hour: gated behind STACKIT_TEST_SLOW, like the
// suites of the same resources. Restarts and restores act on one instance, so the
// bindings run one after another, and each of those waits for it to be active again.
describe.sequential.skipIf(slow)(
  "STACKIT OpenSearch bindings on a Cloudflare Worker",
  { tags: [...stackitTags("opensearch", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 2_700_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 2_700_000 });

    // A fresh workers.dev URL, the created key and the account's new memberships take
    // a while to propagate: retry until the route answers `ok`, then report the last
    // answer so a real failure shows its error.
    const call = (route: string, params: Record<string, string | number> = {}) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        const query = new URLSearchParams(
          Object.entries(params).map(([key, value]) => [key, String(value)]),
        ).toString();
        return yield* HttpClient.get(`${url}${route}?${query}`).pipe(
          Effect.timeout("30 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      });

    /** After an action that takes the instance away, until it reports `active` again. */
    const waitActive = call("/get-instance").pipe(
      Effect.repeat({
        schedule: Schedule.spaced("15 seconds"),
        until: (body) => body.result?.status === "active",
        times: 60,
      }),
    );

    const OPTIONS = { timeout: 240_000 } as const;
    const ACTION_OPTIONS = { timeout: 1_200_000 } as const;

    describe("GetInstance", () => {
      test.provider(
        "reads the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId } = yield* stack;
            const body = yield* call("/get-instance");
            expectOk(body);
            expect(body.result.instanceId).toEqual(instanceId);
            expect(body.result.status).toEqual("active");
          }),
        OPTIONS,
      );
    });

    describe("ListCredentials", () => {
      test.provider(
        "lists the deployed credential",
        (_stack) =>
          Effect.gen(function* () {
            const { credentialId } = yield* stack;
            const body = yield* call("/list-credentials");
            expectOk(body);
            expect(body.result.credentialsList.map((item: { id: string }) => item.id)).toContain(
              credentialId,
            );
          }),
        OPTIONS,
      );
    });

    describe("GetCredential", () => {
      test.provider(
        "reads the credential, without handing out its password",
        (_stack) =>
          Effect.gen(function* () {
            const { credentialId, username } = yield* stack;
            const body = yield* call("/get-credential");
            expectOk(body);
            expect(body.result).toEqual({ id: credentialId, username });
          }),
        OPTIONS,
      );
    });

    describe("Connect", () => {
      test.provider(
        "resolves the credential's connection settings in the host",
        (_stack) =>
          Effect.gen(function* () {
            const { host, username } = yield* stack;
            const body = yield* call("/connect");
            expectOk(body);
            expect(body.result.host).toEqual(host);
            expect(body.result.username).toEqual(username);
          }),
        OPTIONS,
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
        OPTIONS,
      );
    });

    describe("GetUpdates", () => {
      test.provider(
        "reads the update settings",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/get-updates");
            expectOk(body);
            expect(typeof body.result.automaticUpdatesEnabled).toEqual("boolean");
            expect(body.result.availableUpdates).toBeGreaterThanOrEqual(0);
          }),
        OPTIONS,
      );
    });

    describe("TriggerUpdate", () => {
      test.provider(
        "starts the pending updates",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId } = yield* stack;
            const body = yield* call("/trigger-update");
            expectOk(body);
            expect(body.result.instanceId).toEqual(instanceId);
            yield* waitActive;
          }),
        ACTION_OPTIONS,
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
        OPTIONS,
      );
    });

    /** The first finished backup, polling while the one just started runs. */
    const finishedBackup = call("/list-backups").pipe(
      Effect.repeat({
        schedule: Schedule.spaced("15 seconds"),
        until: (body) =>
          (body.result ?? []).some((backup: { downloadable?: boolean }) => backup.downloadable),
        times: 40,
      }),
      Effect.map((body) =>
        (body.result as Array<{ id: number; downloadable?: boolean }>).find(
          (backup) => backup.downloadable,
        ),
      ),
    );

    describe("ListBackups", () => {
      test.provider(
        "lists the backup just started",
        (_stack) =>
          Effect.gen(function* () {
            const backup = yield* finishedBackup;
            expect(backup?.id).toEqual(expect.any(Number));
          }),
        ACTION_OPTIONS,
      );
    });

    describe("DownloadBackup", () => {
      test.provider(
        "downloads a finished backup's bytes",
        (_stack) =>
          Effect.gen(function* () {
            const backup = yield* finishedBackup;
            const body = yield* call("/download-backup", { id: backup?.id ?? -1 });
            expectOk(body);
            expect(body.result.size).toBeGreaterThan(0);
          }),
        ACTION_OPTIONS,
      );
    });

    describe("TriggerRestore", () => {
      test.provider(
        "restores a finished backup",
        (_stack) =>
          Effect.gen(function* () {
            const backup = yield* finishedBackup;
            const body = yield* call("/trigger-restore", { id: backup?.id ?? -1 });
            expectOk(body);
            expect(body.result.id).toEqual(expect.any(Number));
            yield* waitActive;
          }),
        ACTION_OPTIONS,
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
        OPTIONS,
      );
    });

    describe("TriggerRestart", () => {
      test.provider(
        "restarts the instance",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId } = yield* stack;
            const body = yield* call("/trigger-restart");
            expectOk(body);
            expect(body.result.instanceId).toEqual(instanceId);
            yield* waitActive;
          }),
        ACTION_OPTIONS,
      );
    });

    describe("TriggerRecreate", () => {
      test.provider(
        "recreates the instance's VMs",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId } = yield* stack;
            const body = yield* call("/trigger-recreate");
            expectOk(body);
            expect(body.result.instanceId).toEqual(instanceId);
            yield* waitActive;
          }),
        ACTION_OPTIONS,
      );
    });

    describe("IndexDocument", () => {
      test.provider(
        "writes a document under its id, and under a generated one",
        (_stack) =>
          Effect.gen(function* () {
            const named = yield* call("/index-document", { index: "indexed", doc: "a" });
            expectOk(named);
            expect(named.result._id).toEqual("a");
            const generated = yield* call("/add-document", { index: "indexed" });
            expectOk(generated);
            expect(generated.result.result).toEqual("created");
            expect(generated.result._id).not.toEqual("a");
          }),
        OPTIONS,
      );
    });

    describe("GetDocument", () => {
      test.provider(
        "reads a document back",
        (_stack) =>
          Effect.gen(function* () {
            const seeded = yield* call("/index-document", { index: "got", doc: "a" });
            expectOk(seeded);
            const body = yield* call("/get-document", { index: "got", doc: "a" });
            expectOk(body);
            expect(body.result._source).toEqual({ sku: "tea" });
          }),
        OPTIONS,
      );
    });

    describe("Search", () => {
      test.provider(
        "finds an indexed document",
        (_stack) =>
          Effect.gen(function* () {
            const seeded = yield* call("/index-document", { index: "searched", doc: "a" });
            expectOk(seeded);
            const body = yield* call("/search", { index: "searched" });
            expectOk(body);
            expect(body.result.hits.hits.map((hit: { _id: string }) => hit._id)).toEqual(["a"]);
          }),
        OPTIONS,
      );
    });

    describe("DeleteDocument", () => {
      test.provider(
        "removes a document",
        (_stack) =>
          Effect.gen(function* () {
            const seeded = yield* call("/index-document", { index: "deleted", doc: "a" });
            expectOk(seeded);
            const body = yield* call("/delete-document", { index: "deleted", doc: "a" });
            expectOk(body);
            expect(body.result.result).toEqual("deleted");
          }),
        OPTIONS,
      );
    });

    describe("Bulk", () => {
      test.provider(
        "runs an action per line",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/bulk", { index: "bulked", doc: "a" });
            expectOk(body);
            expect(body.result.errors).toEqual(false);
            expect(body.result.items[0].index._id).toEqual("a");
            const read = yield* call("/get-document", { index: "bulked", doc: "a" });
            expect(read.result._source).toEqual({ sku: "bulk" });
          }),
        OPTIONS,
      );
    });

    describe("WriteIndex", () => {
      test.provider(
        "writes through the client",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/write-index", { index: "levels", doc: "w" });
            expectOk(body);
            expect(body.result._id).toEqual("w");
          }),
        OPTIONS,
      );
    });

    describe("ReadIndex", () => {
      test.provider(
        "searches through the client",
        (_stack) =>
          Effect.gen(function* () {
            const seeded = yield* call("/write-index", { index: "levels", doc: "w" });
            expectOk(seeded);
            const body = yield* call("/read-index", { index: "levels" });
            expectOk(body);
            expect(body.result.hits.hits.map((hit: { _id: string }) => hit._id)).toContain("w");
          }),
        OPTIONS,
      );
    });

    describe("ReadWriteIndex", () => {
      test.provider(
        "writes and reads through one client",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/read-write-index", { index: "levels", doc: "both" });
            expectOk(body);
            expect(body.result._source).toEqual({ sku: "both" });
          }),
        OPTIONS,
      );
    });
  },
);
