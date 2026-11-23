import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import WorkerFirstCall from "./fixtures/catch-up/first-call.ts";
import WorkerV1 from "./fixtures/catch-up/v1.ts";
import WorkerV2 from "./fixtures/catch-up/v2.ts";
import WorkerV3 from "./fixtures/catch-up/v3.ts";
import WorkerV3b from "./fixtures/catch-up/v3b.ts";

/** A route answered with something other than what the test waits for. */
class NotYet extends Data.TaggedError("NotYet")<{
  readonly status: number;
  readonly body: string;
}> {}

/** Call a route on a fresh connection, so the request reaches the latest deployment. */
const call = (url: string, method: "GET" | "POST", path: string) =>
  requestWorker(
    (method === "GET" ? HttpClientRequest.get : HttpClientRequest.post)(`${url}${path}`).pipe(
      HttpClientRequest.setHeaders({ connection: "close", "cache-control": "no-cache" }),
    ),
  ).pipe(
    // A dropped connection is the network's, not the Worker's answer: ask again.
    Effect.retry({
      while: (error) => error._tag === "HttpClientError",
      schedule: Schedule.spaced("1 second"),
      times: 5,
    }),
    Effect.flatMap((res) =>
      res.text.pipe(
        Effect.flatMap((body) =>
          res.status === 200
            ? Effect.succeed(body)
            : Effect.fail(new NotYet({ status: res.status, body })),
        ),
      ),
    ),
  );

/** Wait until the Worker serves `version`: a redeploy takes a few seconds to roll out. */
const serving = (url: string, version: "v1" | "v2" | "v3" | "v3b" | "first-call") =>
  call(url, "GET", "/version").pipe(
    Effect.filterOrFail(
      (body) => body === version,
      (body) => new NotYet({ status: 200, body }),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 90 }),
  );

const deposit = (url: string, account: string, amount: number) =>
  call(url, "POST", `/deposit/${account}/${amount}`).pipe(
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }),
  );

/** Poll the view until an account's deposits are `expected`. */
const deposits = (url: string, account: string, expected: ReadonlyArray<number>) =>
  call(url, "GET", `/deposits/${account}`).pipe(
    Effect.map((body) => (JSON.parse(body) as { amounts: ReadonlyArray<number> } | null)?.amounts),
    // Cloudflare rolls a deploy out host by host: a host still on v1 has no such route.
    Effect.catchIf(
      (e) => e._tag === "NotYet" && e.status === 404 && e.body === "Not Found",
      () => Effect.succeed(undefined),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (amounts) => JSON.stringify(amounts) === JSON.stringify(expected),
      // Instances still on the code from before the deploy hold the backfill back
      // until they have been idle, in 30 second steps: allow a few minutes.
      times: 150,
    }),
  );

/** Poll the timeline (one key fed by every account) until it holds `count` entries. */
const timeline = (url: string, count: number) =>
  call(url, "GET", "/timeline").pipe(
    Effect.map((body) => (JSON.parse(body) as { entries: ReadonlyArray<string> } | null)?.entries),
    Effect.catchIf(
      (e) => e._tag === "NotYet" && e.status === 404 && e.body === "Not Found",
      () => Effect.succeed(undefined),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (entries) => (entries?.length ?? 0) >= count,
      // Instances still on the code from before the deploy hold the backfill back
      // until they have been idle, in 30 second steps: allow a few minutes.
      times: 150,
    }),
  );

/**
 * Poll the view's history until it reports every earlier event has reached it.
 * The directory answers it, not the view's objects: a Durable Object keeps its
 * old code while calls keep it busy, so polling the view itself would hold it on
 * the code from before the deploy.
 */
const historyComplete = (url: string) =>
  call(url, "GET", "/history").pipe(
    Effect.map((body) => (JSON.parse(body) as { complete: boolean }).complete),
    Effect.catchIf(
      (e) => e._tag === "NotYet" && e.status === 404 && e.body === "Not Found",
      () => Effect.succeed(false),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (complete) => complete,
      // Instances still on the code from before the deploy hold the backfill back
      // until they have been idle, in 30 second steps: allow a few minutes.
      times: 150,
    }),
  );

/**
 * Read the view's history once. A deploy waits for the backfill it starts, so
 * right after one it is already complete; only a host still on the code from
 * before the deploy (which has no such route) is asked again.
 */
const historyNow = (url: string) =>
  call(url, "GET", "/history").pipe(
    Effect.map((body) => (JSON.parse(body) as { complete: boolean }).complete),
    Effect.retry({
      while: (e) => e._tag === "NotYet" && e.status === 404 && e.body === "Not Found",
      schedule: Schedule.spaced("2 seconds"),
      times: 30,
    }),
  );

/** The model's revision, as the deployed Worker has it bound. */
const revisionOf = (workerName: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const settings = yield* workers.getScriptScriptAndVersionSetting({
      accountId,
      scriptName: workerName,
    });
    return (settings.bindings ?? []).find(
      (binding) => binding.name === "ALCHEMY_DOMAIN_REVISION_Ledger",
    );
  });

/** How many new accounts open just before the deploy that adds the view. */
const OPENED = 120;

// Locally a redeploy restarts every object at once; live, an object keeps its old
// code until it has been idle, and the catch-up must wait it out.
for (const dev of [true, false]) {
  describe(
    dev ? "local catch-up" : "live catch-up",
    { tags: ["provider:cloudflare", "provider:cloudflare:worker", dev ? "local" : "live"] },
    () => {
      const { test } = Test.make({
        providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
        dev,
      });

      test.provider(
        // The mode is in the name: the stack is named after the test, and the local and
        // live runs must not share one.
        `${dev ? "local" : "live"}: a view added in a redeploy catches up, and a version bump rebuilds it`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();

            const { worker: v1 } = yield* stack.deploy(
              Effect.gen(function* () {
                return { worker: yield* WorkerV1 };
              }),
            );
            const url = v1.url!.replace(/\/+$/, "");
            yield* serving(url, "v1");
            const history: Record<string, ReadonlyArray<number>> = {
              "a-1": [10, 20],
              "a-2": [5],
              "a-3": [7, 8, 9],
            };
            for (const [account, amounts] of Object.entries(history)) {
              for (const amount of amounts) yield* deposit(url, account, amount);
            }

            // Redeploy with the view: the accounts' history reaches it without another command.
            yield* stack.deploy(
              Effect.gen(function* () {
                return { worker: yield* WorkerV2 };
              }),
            );
            yield* serving(url, "v2");
            // The deploy returned once the backfill was done.
            if (!dev) expect(yield* historyNow(url)).toBe(true);
            for (const [account, amounts] of Object.entries(history)) {
              expect(yield* deposits(url, account, amounts)).toEqual(amounts);
            }

            // One key fed by every account merges their history in the order it was committed.
            const committed = Object.entries(history).flatMap(([account, amounts]) =>
              amounts.map((amount) => `${account}:${amount}`),
            );
            expect(yield* timeline(url, committed.length)).toEqual(committed);

            // Caught up, it receives new deposits live, after the history.
            yield* deposit(url, "a-1", 30);
            expect(yield* deposits(url, "a-1", [10, 20, 30])).toEqual([10, 20, 30]);
            expect(yield* historyComplete(url)).toBe(true);

            // Redefine the view (it now doubles each deposit) and bump its version: it is
            // rebuilt. Written while the deploy waits on the rebuild: a new account, and an
            // account that was inactive.
            const writes = yield* Effect.forkChild(
              Effect.gen(function* () {
                yield* serving(url, "v3");
                yield* deposit(url, "a-4", 4);
                yield* deposit(url, "a-2", 6);
              }),
            );
            yield* stack.deploy(
              Effect.gen(function* () {
                return { worker: yield* WorkerV3 };
              }),
            );
            yield* Fiber.join(writes);
            // New code with the same model: no second run, and the history stays complete.
            yield* stack.deploy(
              Effect.gen(function* () {
                return { worker: yield* WorkerV3b };
              }),
            );
            yield* serving(url, "v3b");
            if (!dev) expect(yield* historyNow(url)).toBe(true);
            const doubled: Record<string, ReadonlyArray<number>> = {
              "a-1": [20, 40, 60],
              "a-2": [10, 12],
              "a-3": [14, 16, 18],
              "a-4": [8],
            };
            expect(yield* historyComplete(url)).toBe(true);
            for (const [account, amounts] of Object.entries(doubled)) {
              expect(yield* deposits(url, account, amounts)).toEqual(amounts);
            }
            // The timeline was not rebuilt: it kept its history in order, and received the
            // new deposits live (live deliveries from different accounts arrive in any order).
            const after = yield* timeline(url, committed.length + 3);
            expect(after?.slice(0, committed.length + 1)).toEqual([...committed, "a-1:30"]);
            expect([...(after?.slice(committed.length + 1) ?? [])].sort()).toEqual([
              "a-2:6",
              "a-4:4",
            ]);

            yield* stack.destroy();
          }),
        { timeout: 600_000 },
      );

      test.provider(
        `${dev ? "local" : "live"}: accounts opened just before and during the deploy that adds a view all reach it`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();

            const { worker: v1 } = yield* stack.deploy(
              Effect.gen(function* () {
                return { worker: yield* WorkerV1 };
              }),
            );
            const url = v1.url!.replace(/\/+$/, "");
            yield* serving(url, "v1");
            // The first deploy is the model's first revision.
            if (!dev)
              expect(yield* revisionOf(v1.workerName)).toMatchObject({ type: "json", json: 1 });

            // A new account's first commit answers before the account is listed in the
            // directory: a stored job lists it afterwards. Open many at once, so their
            // listings queue up on the new directory nodes and are still running when
            // the redeploy restarts the objects (locally every object restarts at once).
            const before = Array.from({ length: OPENED }, (_, i) => `o-${i}`);
            yield* Effect.forEach(before, (account, i) => deposit(url, account, i + 1), {
              concurrency: 32,
              discard: true,
            });
            // More open while the deploy's backfill runs: committed after its run may have
            // read the directory, and listed later still.
            const during = Array.from({ length: OPENED / 4 }, (_, i) => `d-${i}`);
            const writes = yield* Effect.forkChild(
              Effect.gen(function* () {
                yield* serving(url, "v2");
                yield* Effect.forEach(during, (account, i) => deposit(url, account, i + 1), {
                  concurrency: 8,
                  discard: true,
                });
              }),
            );
            yield* stack.deploy(
              Effect.gen(function* () {
                return { worker: yield* WorkerV2 };
              }),
            );
            yield* Fiber.join(writes);
            yield* serving(url, "v2");

            // Adding the view makes the next revision; the same model again keeps it.
            if (!dev) {
              expect(yield* revisionOf(v1.workerName)).toMatchObject({ type: "json", json: 2 });
              const plan = yield* stack.plan(
                Effect.gen(function* () {
                  return { worker: yield* WorkerV2 };
                }),
              );
              expect(plan.resources["Ledger.DomainRevision"]?.action).toBe("noop");
            }

            // Every account reached the view, with no further command to any of them.
            expect(yield* historyComplete(url)).toBe(true);
            yield* Effect.forEach(
              [...before, ...during],
              (account) =>
                Effect.gen(function* () {
                  const amount = Number(account.slice(2)) + 1;
                  expect(yield* deposits(url, account, [amount])).toEqual([amount]);
                }),
              { concurrency: 16, discard: true },
            );

            yield* stack.destroy();
          }),
        { timeout: 600_000 },
      );

      // Live only: locally there is no isolate to start fresh, and no object far away.
      if (!dev)
        test.provider(
          "live: the first Domain call in a fresh isolate doesn't wait for the runs it starts",
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const { worker } = yield* stack.deploy(
                Effect.gen(function* () {
                  return { worker: yield* WorkerFirstCall };
                }),
              );
              const url = worker.url!.replace(/\/+$/, "");
              yield* serving(url, "first-call");

              // The deploy's first Domain call: the isolate's runs are not yet started.
              // Each read is of a new account, so only the first call starts the runs.
              const timing = JSON.parse(yield* call(url, "GET", "/first")) as {
                fresh: boolean;
                first: number;
                second: number;
              };
              expect(timing.fresh).toBe(true);
              // Starting ten far-away runs one after another takes seconds; the
              // first read takes about as long as the second.
              expect(timing.first - timing.second).toBeLessThan(1_000);

              yield* stack.destroy();
            }),
          { timeout: 600_000 },
        );
    },
  );
}
