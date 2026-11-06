import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { passMarker } from "@alchemy.run/cloudflare/Domain/Version";
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
  doBindings,
  movedBy,
  namespacesOf,
  tagsOf,
  untilListed,
  watch,
} from "./move.ts";

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
      const moving = yield* namespacesOf(scriptName);
      // the old classes stay, next to the model's class
      expect(Object.keys(moving).sort()).toEqual([...Object.keys(legacy), "Billing.Domain"].sort());
      for (const [cls, id] of Object.entries(legacy)) expect(moving[cls]).toBe(id);
      expect(yield* tagsOf(scriptName)).toContain("alchemy:domain:v1");

      // The deploy waited for the move: the account, the view row, the saga
      // run and the directory and run nodes.
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

      // A redeploy right away keeps the old classes: Cloudflare may not list
      // every old object yet.
      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* UpgradeSharedNextWorker };
        }),
      );
      expect(Object.keys(yield* namespacesOf(scriptName)).sort()).toEqual(
        Object.keys(moving).sort(),
      );

      // Record a pass from long ago, as if the move started earlier: with the
      // passes the deploys ran, the next upload deletes every old class.
      yield* backdatePasses(scriptName, Object.keys(legacy));
      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* UpgradeSharedWorker };
        }),
      );
      expect(yield* namespacesOf(scriptName)).toEqual({
        "Billing.Domain": moving["Billing.Domain"],
      });
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

/**
 * A Worker deployed before Domain versions existed goes straight to the
 * shared class. Its classes keep their names: nothing is renamed, so the
 * upload lists each once. Keys move on their first call, before the
 * migration has listed them, and the move's passes delete the old classes.
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
      // kept under their own names, next to the shared class
      const upgraded = yield* namespacesOf(scriptName);
      expect(upgraded).toEqual({ ...legacy, "Billing.Domain": upgraded["Billing.Domain"] });
      expect(upgraded["Billing.Domain"]).toBeDefined();
      // each reached through the model's binding to it
      const bindings = yield* doBindings(scriptName);
      for (const cls of Object.keys(legacy))
        expect(bindings[`Billing.${cls}.BeforeVersions`]).toBe(cls);
      expect(yield* tagsOf(scriptName)).toContain("alchemy:domain:v1");
      expect(yield* movedBy(scriptName)).toBeGreaterThanOrEqual(3);

      expect(yield* call(url, "/Billing/state/a-1")).toEqual({ owner: "sam" });
      expect(yield* call(url, "/Billing/owners/a-1")).toEqual({ owner: "sam" });
      yield* call(url, "/approve/s-1/lee", "POST");
      yield* poll(url, "/saga/s-1", (body) => (body as any)._tag === "Completed");
      expect(yield* call(url, "/Billing/state/s-1")).toEqual({ owner: "kim:lee" });
      yield* call(url, "/Billing/open/a-2/ann", "POST");
      yield* poll(url, "/Billing/owners/a-2", (body) => (body as any)?.owner === "ann");

      // Once the move has settled, the next upload deletes the old classes.
      yield* backdatePasses(scriptName, Object.keys(legacy));
      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* UpgradeSharedNextWorker };
        }),
      );
      expect(yield* doBindings(scriptName)).toEqual({ "Billing.Domain": "Billing.Domain" });
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
 * to the shared class, only the model that keeps the data moves it; the other
 * starts empty. Neither chosen, the deploy stops before any upload.
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
      expect(String(ambiguous)).toContain("AmbiguousDomainLegacyData");
      expect(yield* namespacesOf(scriptName)).toEqual(legacy);

      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* SharedV1BillingWorker };
        }),
      );
      yield* waitForVersion(url, 1);
      const upgraded = yield* namespacesOf(scriptName);
      expect(upgraded).toEqual({
        ...legacy,
        "Billing.Domain": upgraded["Billing.Domain"],
        "Audit.Domain": upgraded["Audit.Domain"],
      });
      // Billing's binding stays; Audit's is left out
      const bindings = yield* doBindings(scriptName);
      expect(bindings["Billing.AccountAggregate.BeforeVersions"]).toBe("AccountAggregate");
      expect(bindings["Audit.AccountAggregate.BeforeVersions"]).toBeUndefined();
      expect(yield* call(url, "/Billing/state/a-1")).toEqual({ owner: "sam" });
      expect(yield* call(url, "/Billing/owners/a-1")).toEqual({ owner: "sam" });
      expect(yield* call(url, "/Audit/state/a-1")).toEqual({ owner: null });
      // each model writes its own objects now
      yield* call(url, "/Audit/open/a-1/ann", "POST");
      expect(yield* call(url, "/Audit/state/a-1")).toEqual({ owner: "ann" });
      expect(yield* call(url, "/Billing/state/a-1")).toEqual({ owner: "sam" });

      yield* backdatePasses(scriptName, Object.keys(legacy));
      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* SharedV1BillingWorker };
        }),
      );
      expect(yield* doBindings(scriptName)).toEqual({
        "Audit.Domain": "Audit.Domain",
        "Billing.Domain": "Billing.Domain",
      });
      expect(yield* call(url, "/Billing/state/a-1")).toEqual({ owner: "sam" });
      expect(yield* call(url, "/Audit/state/a-1")).toEqual({ owner: "ann" });

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"], timeout: 1_200_000 },
);
