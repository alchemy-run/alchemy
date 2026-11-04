import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as durableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as workflows from "@distilled.cloud/cloudflare/workflows";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { getWorkerTags } from "../Utils/Worker.ts";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import SharedBillingWorker from "./fixtures/shared-billing-worker.ts";
import SharedNoneWorker from "./fixtures/shared-none-worker.ts";
import SharedWorker from "./fixtures/shared-worker.ts";
import UpgradeNextWorker from "./fixtures/upgrade-next-worker.ts";
import UpgradeNoneWorker from "./fixtures/upgrade-none-worker.ts";
import UpgradePlainWorker from "./fixtures/upgrade-plain-worker.ts";
import UpgradeSharedNextWorker from "./fixtures/upgrade-shared-next-worker.ts";
import UpgradeSharedWorker from "./fixtures/upgrade-shared-worker.ts";
import UpgradeWorker from "./fixtures/upgrade-worker.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

/** A route answered with something other than 200. */
class UpgradeRequestFailed extends Data.TaggedError("UpgradeRequestFailed")<{
  readonly status: number;
  readonly body: string;
}> {}

/** Call a route; right after a deploy, retry until the Worker serves it. */
const call = (url: string, path: string, method: "GET" | "POST" = "GET") =>
  requestWorker(
    (method === "GET" ? HttpClientRequest.get : HttpClientRequest.post)(`${url}${path}`).pipe(
      HttpClientRequest.setHeader("connection", "close"),
    ),
  ).pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? res.json
        : Effect.flatMap(res.text, (body) =>
            Effect.fail(new UpgradeRequestFailed({ status: res.status, body })),
          ),
    ),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }),
  );

/** Wait until the deployed Worker answers with the given Domain version. */
const waitForVersion = (url: string, version: number | null) =>
  call(url, "/version").pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (body) => (body as { version: number | null }).version === version,
      times: 30,
    }),
  );

/** Poll a route until `until` holds. */
const poll = (url: string, path: string, until: (body: unknown) => boolean) =>
  call(url, path).pipe(Effect.repeat({ schedule: Schedule.spaced("1 second"), until, times: 30 }));

/** The Durable Object classes Cloudflare hosts for a script, by class name. */
const namespacesOf = Effect.fn(function* (scriptName: string) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const namespaces = yield* durableObjects.listNamespaces
    .items({ accountId })
    .pipe(Stream.runCollect);
  return Object.fromEntries(
    namespaces.flatMap((namespace) =>
      namespace.script === scriptName && namespace.class ? [[namespace.class, namespace.id]] : [],
    ),
  );
});

/**
 * Read `path` every 250 ms, without retrying, until interrupted: every answer
 * the Worker gave while a deploy rolled out.
 */
const watch = (url: string, path: string, answers: Array<{ status: number; body: string }>) =>
  HttpClient.execute(
    HttpClientRequest.get(`${url}${path}`).pipe(HttpClientRequest.setHeader("connection", "close")),
  ).pipe(
    Effect.flatMap((res) => Effect.map(res.text, (body) => ({ status: res.status, body }))),
    Effect.catch((error) => Effect.succeed({ status: 0, body: String(error) })),
    Effect.tap((answer) => Effect.sync(() => answers.push(answer))),
    Effect.repeat(Schedule.spaced("250 millis")),
  );

/** How many objects of a namespace Cloudflare lists as holding data. */
const holdingData = Effect.fn(function* (namespaceId: string) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const objects = yield* durableObjects.listNamespaceObjects
    .items({ accountId, id: namespaceId })
    .pipe(Stream.runCollect);
  return Array.from(objects).filter((object) => object.hasStoredData === true).length;
});

/** Poll every namespace until `until` holds for its count of objects holding data. */
const untilListed = (namespaceIds: ReadonlyArray<string>, until: (count: number) => boolean) =>
  Effect.forEach(namespaceIds, (id) =>
    holdingData(id).pipe(
      // Cloudflare lists an object a few minutes after it is written.
      Effect.repeat({ schedule: Schedule.spaced("10 seconds"), until, times: 48 }),
    ),
  );

/**
 * How many objects the Worker's migration Workflow moved, from its complete
 * instances (the passes' markers move none).
 */
const movedBy = Effect.fn(function* (scriptName: string) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const settings = yield* workers.getScriptScriptAndVersionSetting({ accountId, scriptName });
  const binding = (settings.bindings ?? []).find(
    (binding) =>
      binding.type === "workflow" &&
      "className" in binding &&
      binding.className === "AlchemyDomainMigration",
  );
  if (binding === undefined || !("workflowName" in binding)) return 0;
  const workflowName = binding.workflowName as string;
  const instances = yield* workflows.listInstances
    .items({ accountId, workflowName, status: "complete" })
    .pipe(Stream.runCollect);
  let moved = 0;
  for (const instance of instances) {
    if (!instance.id.startsWith("migrate-")) continue;
    const { output } = yield* workflows.getInstance({
      accountId,
      workflowName,
      instanceId: instance.id,
    });
    const parsed = typeof output === "string" ? JSON.parse(output) : output;
    moved += (parsed as { moved?: number } | null)?.moved ?? 0;
  }
  return moved;
});

const tagsOf = Effect.fn(function* (scriptName: string) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  return yield* getWorkerTags(scriptName, accountId);
});

/**
 * A Worker deployed before Domain versions existed named its classes after
 * the definition alone (`AccountAggregate`). Upgrading renames them after
 * the model (`Billing.AccountAggregate`) and keeps every account, view row
 * and saga run.
 */
test.provider(
  "upgrading a model deployed before Domain versions keeps its data",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const before = yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* UpgradeNoneWorker };
        }),
      );
      const url = before.worker.url!;
      const scriptName = before.worker.workerName;
      yield* waitForVersion(url, null);

      yield* call(url, "/Billing/open/a-1/sam", "POST");
      yield* poll(url, "/Billing/owners/a-1", (body) => (body as any)?.owner === "sam");
      // a run that waits for its approval across the upgrade
      yield* call(url, "/saga/s-1/kim", "POST");
      yield* poll(url, "/saga/s-1", (body) => (body as any)._tag === "Running");

      const legacy = yield* namespacesOf(scriptName);
      expect(Object.keys(legacy).sort()).toEqual([
        "AccountAggregate",
        "ApproveWorkflow",
        "DomainDirectory",
        "OwnersView",
        "OwnersViewRun",
      ]);
      expect(
        (yield* tagsOf(scriptName)).filter((tag) => tag.startsWith("alchemy:domain:")),
      ).toEqual([]);

      // Read the account throughout the upgrade: while Cloudflare rolls the
      // new code out, every request still answers with it.
      const answers: Array<{ status: number; body: string }> = [];
      const watcher = yield* Effect.forkChild(watch(url, "/Billing/state/a-1", answers));
      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* UpgradeWorker };
        }),
      );
      yield* waitForVersion(url, 0);
      yield* Effect.sleep("5 seconds");
      yield* Fiber.interrupt(watcher);
      expect(answers.length).toBeGreaterThan(10);
      expect(answers.filter((answer) => answer.status !== 200)).toEqual([]);
      expect(new Set(answers.map((answer) => answer.body))).toEqual(
        new Set([JSON.stringify({ owner: "sam" })]),
      );

      // the same namespaces, under the model's names
      expect(yield* namespacesOf(scriptName)).toEqual({
        "Billing.AccountAggregate": legacy.AccountAggregate,
        "Billing.ApproveWorkflow": legacy.ApproveWorkflow,
        "Billing.DomainDirectory": legacy.DomainDirectory,
        "Billing.OwnersView": legacy.OwnersView,
        "Billing.OwnersViewRun": legacy.OwnersViewRun,
      });
      expect(yield* tagsOf(scriptName)).toContain("alchemy:domain:v0");

      expect(yield* call(url, "/Billing/state/a-1")).toEqual({ owner: "sam" });
      expect(yield* call(url, "/Billing/owners/a-1")).toEqual({ owner: "sam" });
      // the run started before the upgrade finishes after it
      yield* call(url, "/approve/s-1/lee", "POST");
      yield* poll(url, "/saga/s-1", (body) => (body as any)._tag === "Completed");
      expect(yield* call(url, "/Billing/state/s-1")).toEqual({ owner: "kim:lee" });
      const upgraded = yield* namespacesOf(scriptName);

      // A later code change at the same version moves nothing.
      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* UpgradeNextWorker };
        }),
      );
      yield* waitForVersion(url, 0);
      expect(yield* namespacesOf(scriptName)).toEqual(upgraded);
      expect(yield* tagsOf(scriptName)).toContain("alchemy:domain:v0");
      expect(yield* call(url, "/Billing/state/a-1")).toEqual({ owner: "sam" });

      // A Worker a newer Alchemy deployed (version 2) is never moved back.
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* workers.patchScriptScriptAndVersionSetting({
        accountId,
        scriptName,
        settings: {
          // Cloudflare checks every class is still declared on any settings change.
          exports: Object.fromEntries(
            Object.keys(upgraded).map((className) => [
              className,
              { type: "durable-object", storage: "sqlite" },
            ]),
          ),
          tags: (yield* tagsOf(scriptName)).map((tag) =>
            tag === "alchemy:domain:v0" ? "alchemy:domain:v2" : tag,
          ),
        },
      });
      const downgrade = yield* stack
        .deploy(
          Effect.gen(function* () {
            return { worker: yield* UpgradeWorker };
          }),
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(downgrade)).toBe(true);
      expect(String(downgrade)).toContain("DomainVersionTooNew");
      expect(yield* namespacesOf(scriptName)).toEqual(upgraded);
      expect(yield* tagsOf(scriptName)).toContain("alchemy:domain:v2");

      // Nor are its classes deleted by older code that hosts no model at all.
      const removed = yield* stack
        .deploy(
          Effect.gen(function* () {
            return { worker: yield* UpgradePlainWorker };
          }),
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(removed)).toBe(true);
      expect(String(removed)).toContain("DomainVersionTooNew");
      expect(yield* namespacesOf(scriptName)).toEqual(upgraded);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"], timeout: 600_000 },
);

/**
 * Two models that listed the same aggregate shared its class before Domain
 * versions existed. Only one can keep that data, so the upgrade fails until
 * one model sets `legacyData`.
 */
test.provider(
  "upgrading models that shared a class needs one to keep its data",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const before = yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* SharedNoneWorker };
        }),
      );
      const url = before.worker.url!;
      const scriptName = before.worker.workerName;
      yield* waitForVersion(url, null);
      // one class: Audit sees what Billing wrote
      yield* call(url, "/Billing/open/a-1/sam", "POST");
      expect(yield* call(url, "/Audit/state/a-1")).toEqual({ owner: "sam" });
      const legacy = yield* namespacesOf(scriptName);

      const ambiguous = yield* stack
        .deploy(
          Effect.gen(function* () {
            return { worker: yield* SharedWorker };
          }),
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(ambiguous)).toBe(true);
      expect(String(ambiguous)).toContain("AmbiguousDomainLegacyData");
      // nothing changed on Cloudflare
      expect(yield* namespacesOf(scriptName)).toEqual(legacy);

      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* SharedBillingWorker };
        }),
      );
      yield* waitForVersion(url, 0);
      const upgraded = yield* namespacesOf(scriptName);
      expect(upgraded["Billing.AccountAggregate"]).toBe(legacy.AccountAggregate);
      expect(upgraded["Audit.AccountAggregate"]).toBeDefined();
      expect(upgraded["Audit.AccountAggregate"]).not.toBe(legacy.AccountAggregate);
      expect(yield* call(url, "/Billing/state/a-1")).toEqual({ owner: "sam" });
      expect(yield* call(url, "/Audit/state/a-1")).toEqual({ owner: null });

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"], timeout: 600_000 },
);

/**
 * Removing every model from a Worker at the current version is allowed: its
 * classes are deleted like any Durable Object the Worker stops hosting, and
 * its version tag goes with them.
 */
test.provider(
  "removing every model from a Worker deletes its classes and version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* UpgradeWorker };
        }),
      );
      const scriptName = worker.workerName;
      yield* waitForVersion(worker.url!, 0);
      expect(yield* tagsOf(scriptName)).toContain("alchemy:domain:v0");

      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* UpgradePlainWorker };
        }),
      );
      expect(yield* namespacesOf(scriptName)).toEqual({});
      expect(
        (yield* tagsOf(scriptName)).filter((tag) => tag.startsWith("alchemy:domain:")),
      ).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"], timeout: 300_000 },
);

/**
 * Domain version 1 hosts every object of every model in one Durable Object
 * class. Upgrading a version 0 Worker keeps its classes live while the
 * deploy's migration Workflow moves each object's storage over; once the
 * move has settled, the next deploy deletes them, and every account, view
 * row and saga run is still there.
 */
test.provider(
  "upgrading to one shared class moves every object, then deletes the old classes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const before = yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* UpgradeWorker };
        }),
      );
      const url = before.worker.url!;
      const scriptName = before.worker.workerName;
      yield* waitForVersion(url, 0);

      yield* call(url, "/Billing/open/a-1/sam", "POST");
      yield* poll(url, "/Billing/owners/a-1", (body) => (body as any)?.owner === "sam");
      // a run that waits for its approval across the upgrade
      yield* call(url, "/saga/s-1/kim", "POST");
      yield* poll(url, "/saga/s-1", (body) => (body as any)._tag === "Running");

      const legacy = yield* namespacesOf(scriptName);
      expect(Object.keys(legacy).sort()).toEqual([
        "Billing.AccountAggregate",
        "Billing.ApproveWorkflow",
        "Billing.DomainDirectory",
        "Billing.OwnersView",
        "Billing.OwnersViewRun",
      ]);
      // The deploy's migration moves what Cloudflare lists: wait until it lists these.
      const written = [
        legacy["Billing.AccountAggregate"]!,
        legacy["Billing.ApproveWorkflow"]!,
        legacy["Billing.OwnersView"]!,
      ];
      yield* untilListed(written, (count) => count > 0);

      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* UpgradeSharedWorker };
        }),
      );
      yield* waitForVersion(url, 1);
      const moving = yield* namespacesOf(scriptName);
      // the old classes stay, next to the shared one
      expect(Object.keys(moving).sort()).toEqual([...Object.keys(legacy), "AlchemyDomain"].sort());
      for (const [cls, id] of Object.entries(legacy)) expect(moving[cls]).toBe(id);
      const tags = yield* tagsOf(scriptName);
      expect(tags).toContain("alchemy:domain:v1");
      const movingTag = tags.find((tag) => tag.startsWith("alchemy:domain:moving:"));
      expect(movingTag).toBeDefined();

      // The deploy waited for the move, before anything read them: the
      // account, the view row, the saga run and the directory and run nodes.
      expect(yield* movedBy(scriptName)).toBeGreaterThanOrEqual(written.length);

      expect(yield* call(url, "/Billing/state/a-1")).toEqual({ owner: "sam" });
      expect(yield* call(url, "/Billing/owners/a-1")).toEqual({ owner: "sam" });
      expect((yield* call(url, "/saga/s-1")) as any).toMatchObject({ _tag: "Running" });
      // the run started before the upgrade finishes after it
      yield* call(url, "/approve/s-1/lee", "POST");
      yield* poll(url, "/saga/s-1", (body) => (body as any)._tag === "Completed");
      expect(yield* call(url, "/Billing/state/s-1")).toEqual({ owner: "kim:lee" });
      // new writes land in the shared class
      yield* call(url, "/Billing/open/a-2/ann", "POST");
      yield* poll(url, "/Billing/owners/a-2", (body) => (body as any)?.owner === "ann");

      // Pretend the move started long enough ago for Cloudflare to list
      // every old object: the next upload deletes each old class that holds
      // no data.
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* workers.patchScriptScriptAndVersionSetting({
        accountId,
        scriptName,
        settings: {
          exports: Object.fromEntries(
            Object.keys(moving).map((className) => [
              className,
              { type: "durable-object", storage: "sqlite" },
            ]),
          ),
          tags: tags.map((tag) => (tag === movingTag ? "alchemy:domain:moving:1" : tag)),
        },
      });
      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* UpgradeSharedNextWorker };
        }),
      );
      expect(yield* namespacesOf(scriptName)).toEqual({ AlchemyDomain: moving.AlchemyDomain });
      expect(
        (yield* tagsOf(scriptName)).filter((tag) => tag.startsWith("alchemy:domain:")),
      ).toEqual(["alchemy:domain:v1"]);
      expect(yield* call(url, "/Billing/state/a-1")).toEqual({ owner: "sam" });
      expect(yield* call(url, "/Billing/owners/a-1")).toEqual({ owner: "sam" });
      expect(yield* call(url, "/Billing/state/a-2")).toEqual({ owner: "ann" });
      expect(yield* call(url, "/Billing/state/s-1")).toEqual({ owner: "kim:lee" });

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"], timeout: 1_500_000 },
);
