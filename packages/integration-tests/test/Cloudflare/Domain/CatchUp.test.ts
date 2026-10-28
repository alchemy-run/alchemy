import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import WorkerV1 from "./fixtures/catch-up/v1.ts";
import WorkerV2 from "./fixtures/catch-up/v2.ts";

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
const serving = (url: string, version: "v1" | "v2") =>
  call(url, "GET", "/version").pipe(
    Effect.filterOrFail(
      (body) => body === version,
      (body) => new NotYet({ status: 200, body }),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
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
      times: 60,
    }),
  );

// Locally a redeploy restarts every object at once; live, an object keeps its old
// code until it has been idle, and the catch-up must wait it out.
for (const dev of [true, false]) {
  describe(dev ? "local catch-up" : "live catch-up", () => {
    const { test } = Test.make({ providers: Cloudflare.providers(), dev });

    test.provider(
      "a view added in a redeploy folds the history recorded before it",
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
          for (const [account, amounts] of Object.entries(history)) {
            expect(yield* deposits(url, account, amounts)).toEqual(amounts);
          }

          // Caught up, it receives new deposits live, after the history.
          yield* deposit(url, "a-1", 30);
          expect(yield* deposits(url, "a-1", [10, 20, 30])).toEqual([10, 20, 30]);

          yield* stack.destroy();
        }),
      { timeout: 300_000 },
    );
  });
}
