import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import DomainScheduleWorker from "./fixtures/worker.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

/** A hold route answered with something other than 200. */
class HoldRequestFailed extends Data.TaggedError("HoldRequestFailed")<{
  readonly status: number;
}> {}

/** Call a hold route; right after a deploy, retry until the Worker serves it. */
const call = (url: string, action: "state" | "schedule" | "rearm" | "cancel", id: string) =>
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
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }),
  );

/** Cancel a hold's expiry; answers `Cancelled` or why nothing was cancelled. */
const cancel = (url: string, id: string) =>
  call(url, "cancel", id).pipe(Effect.map((body) => (body as { readonly cancel: string }).cancel));

/** Wait until the hold expired. */
const expired = (url: string, id: string) =>
  call(url, "state", id).pipe(
    Effect.map((body) => (body as { readonly status: string }).status),
    Effect.repeat({
      schedule: Schedule.spaced("500 millis"),
      until: (status) => status === "expired",
      times: 30,
    }),
  );

/**
 * A timer scheduled again under a command id that already ran (alchemy#2804):
 * by default `schedule` fails with `AlreadyExecuted`; with `replace: "always"`
 * the Durable Object drops the old receipt and the command runs again.
 */
test.provider(
  "replace 'always' schedules a command id that already ran on Durable Objects",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* DomainScheduleWorker };
        }),
      );
      const url = worker.url!;
      const id = `rearm-${yield* Effect.sync(() => crypto.randomUUID())}`;

      // the expiry runs once
      expect(yield* call(url, "rearm", id)).toMatchObject({ commandId: "expire" });
      expect(yield* expired(url, id)).toBe("expired");
      expect(yield* cancel(url, id)).toBe("AlreadyExecuted");

      // scheduling it again by default fails: the instance has its receipt
      expect(yield* call(url, "schedule", id)).toEqual({ failed: "AlreadyExecuted" });

      // with replace "always" it is pending again, so it can be cancelled
      expect(yield* call(url, "rearm", id)).toMatchObject({ commandId: "expire" });
      expect(yield* cancel(url, id)).toBe("Cancelled");

      // and, when not cancelled, it runs again: its receipt is back
      expect(yield* call(url, "rearm", id)).toMatchObject({ commandId: "expire" });
      yield* Effect.sleep("5 seconds");
      expect(yield* cancel(url, id)).toBe("AlreadyExecuted");
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
