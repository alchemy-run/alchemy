import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import DomainPhaseTimersWorker from "./fixtures/phase-timers-worker.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class AlarmRequestFailed extends Data.TaggedError("AlarmRequestFailed")<{
  readonly status: number;
}> {}

interface AlarmState {
  readonly phase: "off" | "armed";
  readonly rang: number;
}

/** Call an alarm route; right after a deploy, retry until the Worker serves it. */
const call = (url: string, action: "arm" | "disarm" | "state" | "pulse" | "beats", id: string) =>
  requestWorker(
    (action === "state" || action === "beats" ? HttpClientRequest.get : HttpClientRequest.post)(
      `${url}/${action}/${id}`,
    ).pipe(HttpClientRequest.setHeader("connection", "close")),
  ).pipe(
    Effect.filterOrFail(
      (res) => res.status === 200,
      (res) => new AlarmRequestFailed({ status: res.status }),
    ),
    Effect.flatMap((res) => res.json),
    Effect.map((body) => body as unknown as AlarmState & { readonly beats: number }),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }),
  );

/** Wait until the alarm rang `times` times in all. */
const rang = (url: string, id: string, times: number) =>
  call(url, "state", id).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("500 millis"),
      until: (state) => state.rang >= times,
      times: 30,
    }),
  );

test.provider(
  "a Durable Object arms and cancels a phase's timers",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* DomainPhaseTimersWorker };
        }),
      );
      const url = worker.url!;
      const id = `alarm-${yield* Effect.sync(() => crypto.randomUUID())}`;

      // entering the phase arms the timer, and it fires
      expect(yield* call(url, "arm", id)).toEqual({ phase: "armed", rang: 0 });
      expect((yield* rang(url, id, 1)).rang).toBe(1);

      // the timer ran under its id: entering again arms that id again (alchemy#2804)
      yield* call(url, "disarm", id);
      yield* call(url, "arm", id);
      expect((yield* rang(url, id, 2)).rang).toBe(2);

      // leaving the phase cancels the timer
      yield* call(url, "disarm", id);
      yield* call(url, "arm", id);
      yield* call(url, "disarm", id);
      yield* Effect.sleep("4 seconds");
      expect(yield* call(url, "state", id)).toEqual({ phase: "off", rang: 2 });

      // a timer whose own commit leaves the phase and returns arms itself again
      yield* call(url, "pulse", id);
      const pulse = yield* call(url, "beats", id).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (state) => state.beats >= 3,
          times: 30,
        }),
      );
      expect(pulse.beats).toBeGreaterThanOrEqual(3);
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
