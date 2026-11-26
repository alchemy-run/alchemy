import { fileURLToPath } from "node:url";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as durableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import {
  current,
  deployArgs,
  MAIN,
  released,
  succeeds,
  workdir,
  type Fixture,
} from "../../StateUpgrade/Harness.ts";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import SharedBillingWorker from "./fixtures/shared-billing-worker.ts";
import SharedNoneWorker from "./fixtures/shared-none-worker.ts";
import SharedV1BillingWorker from "./fixtures/shared-v1-billing-worker.ts";
import SharedV1Worker from "./fixtures/shared-v1-worker.ts";
import SharedWorker from "./fixtures/shared-worker.ts";
import UpgradeNextWorker from "./fixtures/upgrade-next-worker.ts";
import UpgradeNoneWorker from "./fixtures/upgrade-none-worker.ts";
import UpgradePlainWorker from "./fixtures/upgrade-plain-worker.ts";
import UpgradeSharedNextWorker from "./fixtures/upgrade-shared-next-worker.ts";
import UpgradeSharedWorker from "./fixtures/upgrade-shared-worker.ts";
import UpgradeWorker from "./fixtures/upgrade-worker.ts";
import {
  backdatePasses,
  bindingsUntil,
  doBindings,
  movedBy,
  namespacesOf,
  untilListed,
  watch,
} from "./move.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
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
      expect(yield* call(url, "/Billing/state/a-1")).toEqual({ owner: "sam" });

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"], timeout: 600_000 },
);

/**
 * Two models that listed the same aggregate shared its class before Domain
 * versions existed. Only one can keep that data, so the upgrade fails while
 * both would take it over, until the other sets `legacyData: false`.
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
      expect(String(ambiguous)).toContain("DurableObjectRenameConflict");
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
 * Removing every model from a Worker is allowed: its classes are deleted like
 * any Durable Object the Worker stops hosting.
 */
test.provider(
  "removing every model from a Worker deletes its classes",
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
      expect(Object.keys(yield* namespacesOf(scriptName)).length).toBeGreaterThan(0);

      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* UpgradePlainWorker };
        }),
      );
      expect(yield* namespacesOf(scriptName)).toEqual({});

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
      // An account that has only scheduled a command: it has no event, so that code
      // listed it nowhere and it stored no key.
      yield* call(url, "/Billing/later/a-7/tom", "POST");

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
      // a-1 and a-7
      yield* untilListed([legacy["Billing.AccountAggregate"]!], (count) => count > 1);
      // An account and its view row written seconds before the upgrade: Cloudflare
      // doesn't list them yet, the model's directory does.
      yield* call(url, "/Billing/open/a-9/zoe", "POST");
      yield* poll(url, "/Billing/owners/a-9", (body) => (body as any)?.owner === "zoe");

      // Read the account throughout the upgrade: Worker isolates still on the
      // old code reach the old class, which forwards to the shared one.
      const answers: Array<{ status: number; body: string }> = [];
      const watcher = yield* Effect.forkChild(watch(url, "/Billing/state/a-1", answers));
      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* UpgradeSharedWorker };
        }),
      );
      yield* waitForVersion(url, 1);
      // Keep reading a while on the new code (a quick deploy leaves few answers so far).
      const seen = answers.length;
      yield* Effect.sync(() => answers.length).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (count) => count > seen + 10,
          times: 60,
        }),
      );
      yield* Fiber.interrupt(watcher);
      expect(answers.length).toBeGreaterThan(10);
      expect(answers.filter((answer) => answer.status !== 200)).toEqual([]);
      expect(new Set(answers.map((answer) => answer.body))).toEqual(
        new Set([JSON.stringify({ owner: "sam" })]),
      );
      // One deploy: every old class is gone but the saga's. Its runs are listed
      // nowhere before this code, so it waits for the passes over what Cloudflare lists.
      expect(
        yield* bindingsUntil(scriptName, {
          "Billing.Domain": "Billing.Domain",
          "Billing.ApproveWorkflow": "Billing.ApproveWorkflow",
        }),
      ).toEqual({
        "Billing.Domain": "Billing.Domain",
        "Billing.ApproveWorkflow": "Billing.ApproveWorkflow",
      });

      // The deploy waited for the move: the account, the view row, the saga
      // run and the directory and run nodes.
      expect(yield* movedBy(scriptName)).toBeGreaterThanOrEqual(written.length);

      expect(yield* call(url, "/Billing/state/a-1")).toEqual({ owner: "sam" });
      expect(yield* call(url, "/Billing/owners/a-1")).toEqual({ owner: "sam" });
      // written just before the upgrade, and moved though its class is gone
      expect(yield* call(url, "/Billing/state/a-9")).toEqual({ owner: "zoe" });
      expect(yield* call(url, "/Billing/owners/a-9")).toEqual({ owner: "zoe" });
      // the command scheduled before the upgrade moved with its account: it can be cancelled
      expect(yield* call(url, "/Billing/cancel/a-7", "POST")).toEqual({ cancel: "Cancelled" });
      expect((yield* call(url, "/saga/s-1")) as any).toMatchObject({ _tag: "Running" });
      // the run started before the upgrade finishes after it
      yield* call(url, "/approve/s-1/lee", "POST");
      yield* poll(url, "/saga/s-1", (body) => (body as any)._tag === "Completed");
      expect(yield* call(url, "/Billing/state/s-1")).toEqual({ owner: "kim:lee" });
      // new writes land in the model's class
      yield* call(url, "/Billing/open/a-2/ann", "POST");
      yield* poll(url, "/Billing/owners/a-2", (body) => (body as any)?.owner === "ann");

      // A redeploy right away keeps the saga's class: Cloudflare may not list
      // every run yet.
      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* UpgradeSharedNextWorker };
        }),
      );
      expect(Object.keys(yield* doBindings(scriptName)).sort()).toEqual([
        "Billing.ApproveWorkflow",
        "Billing.Domain",
      ]);

      // Record a pass from long ago, as if the move started earlier: with the
      // passes the deploys ran, the next upload deletes the saga's class too.
      yield* backdatePasses(scriptName, ["Billing.ApproveWorkflow"]);
      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* UpgradeSharedWorker };
        }),
      );
      expect(yield* bindingsUntil(scriptName, { "Billing.Domain": "Billing.Domain" })).toEqual({
        "Billing.Domain": "Billing.Domain",
      });
      expect(yield* call(url, "/Billing/state/a-1")).toEqual({ owner: "sam" });
      expect(yield* call(url, "/Billing/owners/a-1")).toEqual({ owner: "sam" });
      expect(yield* call(url, "/Billing/state/a-2")).toEqual({ owner: "ann" });
      expect(yield* call(url, "/Billing/state/s-1")).toEqual({ owner: "kim:lee" });

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"], timeout: 1_500_000 },
);

/**
 * A Worker deployed before Domain versions existed goes straight to the
 * shared class. The upload renames its classes after the model, keeping
 * their objects, which then move into the shared class. That code listed none
 * of its objects, so the old classes stay until the move's passes have seen
 * everything Cloudflare lists.
 */
test.provider(
  "upgrading a model deployed before Domain versions straight to the shared class keeps its data",
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
      // The deploy's migration moves what Cloudflare lists: wait until it lists these.
      yield* untilListed(
        [legacy.AccountAggregate!, legacy.ApproveWorkflow!, legacy.OwnersView!],
        (count) => count > 0,
      );

      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* UpgradeSharedWorker };
        }),
      );
      yield* waitForVersion(url, 1);
      // renamed after the model, keeping their namespaces, next to the shared class
      const renamed = Object.fromEntries(
        Object.entries(legacy).map(([cls, id]) => [`Billing.${cls}`, id]),
      );
      const upgraded = yield* namespacesOf(scriptName);
      expect(upgraded).toEqual({ ...renamed, "Billing.Domain": upgraded["Billing.Domain"] });
      expect(upgraded["Billing.Domain"]).toBeDefined();
      // kept: that code listed nothing, so the move's passes decide
      const bindings = yield* doBindings(scriptName);
      for (const cls of Object.keys(renamed)) expect(bindings[cls]).toBe(cls);
      expect(yield* movedBy(scriptName)).toBeGreaterThanOrEqual(3);

      expect(yield* call(url, "/Billing/state/a-1")).toEqual({ owner: "sam" });
      expect(yield* call(url, "/Billing/owners/a-1")).toEqual({ owner: "sam" });
      yield* call(url, "/approve/s-1/lee", "POST");
      yield* poll(url, "/saga/s-1", (body) => (body as any)._tag === "Completed");
      expect(yield* call(url, "/Billing/state/s-1")).toEqual({ owner: "kim:lee" });
      yield* call(url, "/Billing/open/a-2/ann", "POST");
      yield* poll(url, "/Billing/owners/a-2", (body) => (body as any)?.owner === "ann");

      // Once the move has settled, the next upload deletes the old classes. The saga's
      // waits for passes of its own: a run started just before the upgrade is listed
      // nowhere until Cloudflare lists it.
      yield* backdatePasses(scriptName, Object.keys(renamed));
      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* UpgradeSharedNextWorker };
        }),
      );
      expect(yield* call(url, "/Billing/state/a-1")).toEqual({ owner: "sam" });
      expect(yield* call(url, "/Billing/owners/a-1")).toEqual({ owner: "sam" });
      // Every class but the saga's is gone; the saga's may wait one more deploy, until a
      // pass that moved all of its objects is far enough from an earlier one.
      expect(Object.keys(yield* doBindings(scriptName))).toEqual(
        expect.arrayContaining(["Billing.Domain"]),
      );
      expect(
        Object.keys(yield* doBindings(scriptName)).filter(
          (name) => name !== "Billing.Domain" && name !== "Billing.ApproveWorkflow",
        ),
      ).toEqual([]);
      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* UpgradeSharedWorker };
        }),
      );
      yield* waitForVersion(url, 1);
      expect(yield* bindingsUntil(scriptName, { "Billing.Domain": "Billing.Domain" })).toEqual({
        "Billing.Domain": "Billing.Domain",
      });
      expect(yield* call(url, "/Billing/state/a-1")).toEqual({ owner: "sam" });
      expect(yield* call(url, "/Billing/owners/a-1")).toEqual({ owner: "sam" });
      expect(yield* call(url, "/Billing/state/a-2")).toEqual({ owner: "ann" });
      expect(yield* call(url, "/Billing/state/s-1")).toEqual({ owner: "kim:lee" });

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"], timeout: 1_200_000 },
);

/**
 * Two models shared a class before Domain versions existed. Upgraded straight
 * to the shared class, only the model that keeps the data takes the class
 * over and moves it; the other, with `legacyData: false`, starts empty. Until
 * one opts out, the deploy stops before any upload.
 */
test.provider(
  "upgrading models that shared a class straight to the shared class moves it to one",
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
      yield* call(url, "/Billing/open/a-1/sam", "POST");
      expect(yield* call(url, "/Audit/state/a-1")).toEqual({ owner: "sam" });
      yield* poll(url, "/Billing/owners/a-1", (body) => (body as any)?.owner === "sam");
      const legacy = yield* namespacesOf(scriptName);
      yield* untilListed([legacy.AccountAggregate!], (count) => count > 0);

      const ambiguous = yield* stack
        .deploy(
          Effect.gen(function* () {
            return { worker: yield* SharedV1Worker };
          }),
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(ambiguous)).toBe(true);
      expect(String(ambiguous)).toContain("DurableObjectRenameConflict");
      expect(yield* namespacesOf(scriptName)).toEqual(legacy);

      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* SharedV1BillingWorker };
        }),
      );
      yield* waitForVersion(url, 1);
      // Billing takes the class over; Audit's is never created
      const upgraded = yield* namespacesOf(scriptName);
      expect(upgraded["Billing.AccountAggregate"]).toBe(legacy.AccountAggregate);
      expect(upgraded["Billing.Domain"]).toBeDefined();
      expect(upgraded["Audit.Domain"]).toBeDefined();
      expect(upgraded["Audit.AccountAggregate"]).toBeUndefined();
      const renamed = Object.keys(upgraded).filter(
        (cls) => cls.startsWith("Billing.") && cls !== "Billing.Domain",
      );
      expect(yield* call(url, "/Billing/state/a-1")).toEqual({ owner: "sam" });
      expect(yield* call(url, "/Billing/owners/a-1")).toEqual({ owner: "sam" });
      expect(yield* call(url, "/Audit/state/a-1")).toEqual({ owner: null });
      // each model writes its own objects now
      yield* call(url, "/Audit/open/a-1/ann", "POST");
      expect(yield* call(url, "/Audit/state/a-1")).toEqual({ owner: "ann" });
      expect(yield* call(url, "/Billing/state/a-1")).toEqual({ owner: "sam" });

      yield* backdatePasses(scriptName, renamed);
      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* SharedV1BillingWorker };
        }),
      );
      expect(
        yield* bindingsUntil(scriptName, {
          "Audit.Domain": "Audit.Domain",
          "Billing.Domain": "Billing.Domain",
        }),
      ).toEqual({
        "Audit.Domain": "Audit.Domain",
        "Billing.Domain": "Billing.Domain",
      });
      expect(yield* call(url, "/Billing/state/a-1")).toEqual({ owner: "sam" });
      expect(yield* call(url, "/Audit/state/a-1")).toEqual({ owner: "ann" });

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"], timeout: 1_200_000 },
);

/** The Feeds Worker as 2.0.0-beta.85 deploys it, then as this workspace does. */
const SCHEDULED_RELEASE = "2.0.0-beta.85";
const scheduledUpgrade: Fixture = {
  name: "domain-scheduled",
  released: fileURLToPath(new URL("./fixtures/scheduled-upgrade/released", import.meta.url)),
  current: fileURLToPath(new URL("./fixtures/scheduled-upgrade/current", import.meta.url)),
  dependencies: ["@alchemy.run/domain"],
};

/**
 * Before 2.0.0-beta.86 a schedule's command id was also the id its command
 * committed with, and nothing else recorded the arming. Scheduling the same
 * id again after an upgrade (a policy whose delivery is redelivered) must not
 * run the command a second time (#3508).
 */
test.provider(
  `a command scheduled and run on ${SCHEDULED_RELEASE} does not run again after an upgrade`,
  () =>
    Effect.gen(function* () {
      const cwd = yield* workdir("domain-scheduled", { keep: true });
      const old = yield* released(SCHEDULED_RELEASE, scheduledUpgrade);
      const next = yield* current(scheduledUpgrade);
      const stage = `sched-${Test.defaultStage().replaceAll("_", "-")}`;
      const options = { cwd, env: {} };
      const urlOf = (output: string) => {
        const url = output.match(/url: '(https:[^']+)'/)?.[1];
        expect(url).toBeDefined();
        return url!;
      };
      const destroy = succeeds(next, ["destroy", MAIN, "--stage", stage, "--yes"], options);
      yield* destroy;

      yield* Effect.gen(function* () {
        const url = urlOf((yield* succeeds(old, deployArgs(stage), options)).output);
        yield* poll(url, "/version", (body) => (body as any)?.release === "released");
        expect(yield* call(url, "/schedule/f-1", "POST")).toEqual({ outcome: "Scheduled" });
        yield* poll(url, "/state/f-1", (body) => (body as any)?.refreshes === 1);

        yield* succeeds(next, deployArgs(stage), options);
        yield* poll(url, "/version", (body) => (body as any)?.release === "current");
        // A busy Durable Object keeps the code it started with until it is
        // idle for about ten seconds: leave the feed alone until it runs this one.
        yield* Effect.sleep("15 seconds");

        // the same schedule again: it ran on the old release, so nothing is armed
        expect(yield* call(url, "/schedule/f-1", "POST")).toEqual({ outcome: "Scheduled" });
        yield* Effect.sleep("8 seconds");
        expect(yield* call(url, "/state/f-1")).toEqual({ refreshes: 1 });

        // a later trigger still arms the name again (#2806)
        yield* call(url, "/schedule/f-1", "POST");
        yield* poll(url, "/state/f-1", (body) => (body as any)?.refreshes === 2);
      }).pipe(Effect.ensuring(destroy.pipe(Effect.ignore)));
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 600_000,
  },
);
