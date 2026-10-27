import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "alchemy/Test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import Stack from "./fixtures/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

type Status = "none" | "held" | "released" | "expired";

/** A hold route answered with something other than 200. */
class HoldRequestFailed extends Data.TaggedError("HoldRequestFailed")<{
  readonly status: number;
}> {}

/** Call a hold route; right after a deploy, retry until the Worker serves it. */
const hold = (url: string, action: "place" | "release" | "state", id: string) =>
  requestWorker(
    (action === "state" ? HttpClientRequest.get : HttpClientRequest.post)(
      `${url}/${action}/${id}`,
    ).pipe(HttpClientRequest.setHeader("connection", "close")),
  ).pipe(
    Effect.filterOrFail(
      (res) => res.status === 200,
      (res) => new HoldRequestFailed({ status: res.status }),
    ),
    Effect.flatMap((res) => res.json),
    Effect.map((body) => (body as { readonly status: Status }).status),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }),
  );

test(
  "an unscheduled command never fires on Durable Objects",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");
    const run = yield* Effect.sync(() => crypto.randomUUID());
    const released = `released-${run}`;
    const kept = `kept-${run}`;

    // both holds schedule their expiry (HoldDeadline, on HoldPlaced); one is
    // released, which unschedules its expiry (HoldDeadline, on HoldReleased)
    expect(yield* hold(base, "place", released)).toBe("held");
    expect(yield* hold(base, "place", kept)).toBe("held");
    expect(yield* hold(base, "release", released)).toBe("released");

    // the kept hold expires once its window has passed
    yield* hold(base, "state", kept).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "expired",
        times: 30,
      }),
    );
    // the released hold was placed first, so its expiry would have fired by now
    yield* Effect.sleep("3 seconds");
    expect(yield* hold(base, "state", kept)).toBe("expired");
    expect(yield* hold(base, "state", released)).toBe("released");
  }),
  { timeout: 180_000 },
);
