import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import Stack from "./fixtures/relay/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
});

const stack = beforeAll(deploy(Stack), { timeout: 420_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/** A relay route answered with something other than 200. */
class RelayRequestFailed extends Data.TaggedError("RelayRequestFailed")<{
  readonly status: number;
}> {}

/** Call a relay route; right after a deploy, retry until the Worker serves it. */
const call = (url: string, method: "GET" | "POST", path: string) =>
  requestWorker(
    (method === "GET" ? HttpClientRequest.get : HttpClientRequest.post)(`${url}${path}`).pipe(
      HttpClientRequest.setHeader("connection", "close"),
    ),
  ).pipe(
    Effect.filterOrFail(
      (res) => res.status === 200,
      (res) => new RelayRequestFailed({ status: res.status }),
    ),
    Effect.flatMap((res) => res.text),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }),
  );

// Each hop is an aggregate whose event a policy turns into a command on the
// next one. Every hop's delivery must start a call chain of its own: one that
// nests each hop inside the last is refused by Cloudflare after a few hops.
test(
  "an aggregate → policy → aggregate chain runs past Cloudflare's call depth",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");
    const chain = `relay-${yield* Effect.sync(() => crypto.randomUUID())}`;
    const hops = 20;

    yield* call(base, "POST", `/start/${chain}/${hops}`);
    const last = yield* call(base, "GET", `/hop/${chain}/0`).pipe(
      Effect.map((body) => JSON.parse(body) as { passed: boolean }),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (state) => state.passed,
        times: 60,
      }),
    );
    expect(last).toEqual({ passed: true });
  }),
  { timeout: 180_000, tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
);
