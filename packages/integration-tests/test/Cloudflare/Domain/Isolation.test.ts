import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import Stack from "./fixtures/isolation-stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/** An isolation route answered with something other than 200. */
class IsolationRequestFailed extends Data.TaggedError("IsolationRequestFailed")<{
  readonly status: number;
}> {}

/** Call a route; right after a deploy, retry until the Worker serves it. */
const call = (url: string, method: "GET" | "POST", path: string) =>
  requestWorker(
    (method === "GET" ? HttpClientRequest.get : HttpClientRequest.post)(`${url}${path}`).pipe(
      HttpClientRequest.setHeader("connection", "close"),
    ),
  ).pipe(
    Effect.filterOrFail(
      (res) => res.status === 200,
      (res) => new IsolationRequestFailed({ status: res.status }),
    ),
    Effect.flatMap((res) => res.json),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }),
  );

for (const isolate of ["class", "key"] as const) {
  test(
    `two models with the same definitions in one Worker keep separate data (isolate: "${isolate}")`,
    Effect.gen(function* () {
      const { url } = yield* stack;
      const base = `${url.replace(/\/+$/, "")}/${isolate}`;
      const id = `a-${yield* Effect.sync(() => crypto.randomUUID())}`;

      yield* call(base, "POST", `/Billing/open/${id}/sam`);
      yield* call(base, "POST", `/Audit/open/${id}/alex`);

      // each model's aggregate holds only its own command
      expect(yield* call(base, "GET", `/Billing/state/${id}`)).toEqual({ owner: "sam" });
      expect(yield* call(base, "GET", `/Audit/state/${id}`)).toEqual({ owner: "alex" });

      // each model's view hears only its own aggregate's events
      const owners = (model: string, owner: string) =>
        call(base, "GET", `/${model}/owners/${id}`).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (state) => (state as { owner?: string } | null)?.owner === owner,
            times: 30,
          }),
        );
      expect(yield* owners("Billing", "sam")).toEqual({ owner: "sam" });
      expect(yield* owners("Audit", "alex")).toEqual({ owner: "alex" });
    }),
    { timeout: 180_000 },
  );
}
