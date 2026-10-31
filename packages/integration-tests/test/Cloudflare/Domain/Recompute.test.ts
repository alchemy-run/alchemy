import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { CloudflareApiLive } from "@alchemy.run/cloudflare/Providers";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as durableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import WorkerV2 from "./fixtures/catch-up/v2.ts";
import WorkerRecomputed from "./fixtures/catch-up/v3-recompute.ts";

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
const serving = (url: string, version: string) =>
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
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (amounts) => JSON.stringify(amounts) === JSON.stringify(expected),
      // An object keeps the code from before the deploy until it has been idle: it
      // recomputes when it starts on the new code. Allow a few minutes.
      times: 150,
    }),
  );

/** The view's Durable Object classes on the Worker, by class name. */
const viewClasses = (scriptName: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const namespaces = yield* durableObjects.listNamespaces
      .items({ accountId })
      .pipe(Stream.runCollect);
    return Object.fromEntries(
      namespaces.flatMap((namespace) =>
        namespace.script === scriptName && namespace.class?.startsWith("Ledger.DepositsView")
          ? [[namespace.class, namespace.id]]
          : [],
      ),
    );
  }).pipe(Effect.provide(CloudflareApiLive()), Effect.scoped);

for (const dev of [true, false]) {
  describe(dev ? "local recompute" : "live recompute", () => {
    const { test } = Test.make({ providers: Cloudflare.providers(), dev });

    test.provider(
      `${dev ? "local" : "live"}: recomputing a view re-folds its keys in place`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { worker } = yield* stack.deploy(
            Effect.gen(function* () {
              return { worker: yield* WorkerV2 };
            }),
          );
          const url = worker.url!.replace(/\/+$/, "");
          yield* serving(url, "v2");
          yield* deposit(url, "a-1", 10);
          yield* deposit(url, "a-1", 20);
          yield* deposit(url, "a-2", 5);
          expect(yield* deposits(url, "a-1", [10, 20])).toEqual([10, 20]);
          expect(yield* deposits(url, "a-2", [5])).toEqual([5]);
          const before = dev ? {} : yield* viewClasses(worker.workerName);

          // A new `evolve` (each deposit doubled) and a recompute: no history is read.
          yield* stack.deploy(
            Effect.gen(function* () {
              return { worker: yield* WorkerRecomputed };
            }),
          );
          yield* serving(url, "v3-recompute");
          expect(yield* deposits(url, "a-1", [20, 40])).toEqual([20, 40]);
          expect(yield* deposits(url, "a-2", [10])).toEqual([10]);
          yield* deposit(url, "a-1", 30);
          expect(yield* deposits(url, "a-1", [20, 40, 60])).toEqual([20, 40, 60]);

          // The same class, with the same data: no new generation was created.
          if (!dev) expect(yield* viewClasses(worker.workerName)).toEqual(before);

          yield* stack.destroy();
        }),
      { timeout: 900_000 },
    );
  });
}
