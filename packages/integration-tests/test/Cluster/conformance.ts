/**
 * The Effect Cluster conformance cases, driven over HTTP against a front that
 * calls the entities through their gateway. Every host's suite runs them.
 */
import { expect } from "@alchemy.run/test";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";

class NotReady extends Data.TaggedError("NotReady")<{ readonly detail: string }> {}

/** GET a route and decode its JSON, retrying while the front or runners start. */
export const get = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.mapError((cause) => new NotReady({ detail: String(cause) })),
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.orElseSucceed(() => ""),
            Effect.flatMap((body) =>
              Effect.fail(new NotReady({ detail: `${response.status}: ${body.slice(0, 500)}` })),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 6 }),
    Effect.flatMap((response) => response.json),
  ) as Effect.Effect<any, unknown, HttpClient.HttpClient>;

/** Wait until the front answers and a counter call goes through. */
export const waitForReady = (baseUrl: string) =>
  HttpClient.get(`${baseUrl}/increment/ready-probe/0`).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.void
        : Effect.fail(new NotReady({ detail: `${response.status}` })),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
  );

type TestFn = (name: string, effect: Effect.Effect<void, unknown, any>, options?: object) => void;

export const conformanceTests = (
  test: TestFn,
  {
    baseUrl,
    kind,
    external = true,
    deliverWithinMillis = 15_000,
  }: {
    baseUrl: () => string;
    /** Whether the host under test runs in a real cloud or on this machine. */
    kind: "live" | "local";
    /** Whether the host runs an existing Effect Cluster program (not on Workers). */
    external?: boolean;
    /**
     * How late a `DeliverAt` message may run on an entity nothing else is
     * calling. Runners find it on their next poll of the message store.
     */
    deliverWithinMillis?: number;
  },
) => {
  const options = { timeout: 120_000, tags: [kind] };

  test(
    "messages to one entity run in order against its state",
    Effect.gen(function* () {
      const a: number = (yield* get(`${baseUrl()}/increment/conf-order/1`)).value;
      const b: number = (yield* get(`${baseUrl()}/increment/conf-order/2`)).value;
      expect(b - a).toBe(2);
      expect((yield* get(`${baseUrl()}/get/conf-order`)).value).toBe(b);
    }),
    options,
  );

  test(
    "entities are isolated by id",
    Effect.gen(function* () {
      const a: number = (yield* get(`${baseUrl()}/increment/conf-iso-a/3`)).value;
      const b: number = (yield* get(`${baseUrl()}/increment/conf-iso-b/7`)).value;
      expect((yield* get(`${baseUrl()}/get/conf-iso-a`)).value).toBe(a);
      expect((yield* get(`${baseUrl()}/get/conf-iso-b`)).value).toBe(b);
      expect((yield* get(`${baseUrl()}/whoami/conf-iso-a`)).value).toBe("conf-iso-a");
    }),
    options,
  );

  test(
    "a persisted message with a primary key runs once",
    Effect.gen(function* () {
      const id = `conf-persist-${Date.now()}`;
      const first: number = (yield* get(`${baseUrl()}/add/${id}/op-1`)).value;
      const again: number = (yield* get(`${baseUrl()}/add/${id}/op-1`)).value;
      expect(again).toBe(first);
      const second: number = (yield* get(`${baseUrl()}/add/${id}/op-2`)).value;
      expect(second - first).toBe(5);
    }),
    options,
  );

  test(
    "a typed failure keeps its tag across the gateway",
    Effect.gen(function* () {
      expect((yield* get(`${baseUrl()}/boom/conf-boom`)).tag).toBe("CounterBoom");
    }),
    options,
  );

  test(
    "a streaming RPC delivers every value",
    Effect.gen(function* () {
      expect((yield* get(`${baseUrl()}/tick/conf-stream/5`)).values).toEqual([1, 2, 3, 4, 5]);
    }),
    options,
  );

  (external ? test : () => {})(
    "an external program's entity is called like any other",
    Effect.gen(function* () {
      const a: number = (yield* get(`${baseUrl()}/tally/conf-tally/2`)).value;
      const b: number = (yield* get(`${baseUrl()}/tally/conf-tally/3`)).value;
      expect(b - a).toBe(3);
    }),
    options,
  );

  test(
    "RPC middleware sees the caller's headers and provides the current user",
    Effect.gen(function* () {
      expect((yield* get(`${baseUrl()}/secret/conf-secret`)).tag).toBe("Unauthorized");
      expect((yield* get(`${baseUrl()}/secret/conf-secret/user:sam`)).value).toBe(
        "conf-secret belongs to sam",
      );
    }),
    options,
  );

  test(
    "a discarded message is delivered without waiting for its reply",
    Effect.gen(function* () {
      const id = `conf-discard-${Date.now()}`;
      expect((yield* get(`${baseUrl()}/forget/${id}/4`)).value).toBe("sent");
      const value = yield* get(`${baseUrl()}/get/${id}`).pipe(
        Effect.map((body) => body.value as number),
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (n) => n === 4,
          times: 20,
        }),
      );
      expect(value).toBe(4);
    }),
    options,
  );

  test(
    "one entity calls another by name",
    Effect.gen(function* () {
      const first: string = (yield* get(`${baseUrl()}/greet/conf-sam`)).value;
      const second: string = (yield* get(`${baseUrl()}/greet/conf-sam`)).value;
      expect(first).toMatch(/^hello conf-sam #\d+$/);
      const n = (s: string) => Number(s.split("#")[1]);
      expect(n(second) - n(first)).toBe(1);
    }),
    options,
  );

  test(
    "a handler that returns Rpc.fork runs while another holds the instance",
    Effect.gen(function* () {
      expect((yield* get(`${baseUrl()}/fork/conf-fork-${Date.now()}`)).value).toBe("released");
    }),
    options,
  );

  test(
    "a defect restarts the instance and runs its message again",
    Effect.gen(function* () {
      const id = `conf-flaky-${Date.now()}`;
      expect((yield* get(`${baseUrl()}/increment/${id}/3`)).value).toBe(3);
      // The rebuilt instance answers, with its state started over.
      expect((yield* get(`${baseUrl()}/flaky/${id}`)).value).toBe(0);
      expect((yield* get(`${baseUrl()}/get/${id}`)).value).toBe(0);
    }),
    options,
  );

  test(
    "interrupting a caller interrupts its handler",
    Effect.gen(function* () {
      const id = `conf-hang-${Date.now()}`;
      // Started first: a message interrupted before its instance is up never runs.
      expect((yield* get(`${baseUrl()}/get/${id}`)).value).toBe(0);
      expect((yield* get(`${baseUrl()}/hang/${id}`)).value).toBe("timed out");
      const interrupted = yield* get(`${baseUrl()}/interrupted/${id}`).pipe(
        Effect.map((body) => body.value as boolean),
        Effect.repeat({ schedule: Schedule.spaced("500 millis"), until: (b) => b, times: 20 }),
      );
      expect(interrupted).toBe(true);
    }),
    options,
  );

  test(
    "a persisted message with DeliverAt runs at its time, not before",
    Effect.gen(function* () {
      const id = `conf-later-${Date.now()}`;
      const sentAt = Date.now();
      expect((yield* get(`${baseUrl()}/later/${id}/5000`)).value).toBe("sent");
      expect((yield* get(`${baseUrl()}/get/${id}`)).value).toBe(0);
      const value = yield* get(`${baseUrl()}/get/${id}`).pipe(
        Effect.map((body) => body.value as number),
        Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (n) => n === 5, times: 60 }),
      );
      expect(value).toBe(5);
      expect(Date.now() - sentAt).toBeGreaterThanOrEqual(4_000);
    }),
    options,
  );

  test(
    "duplicates of a persisted message sent at once run it once",
    Effect.gen(function* () {
      const body = yield* get(`${baseUrl()}/credit-race/conf-race-${Date.now()}`);
      expect(body.values).toEqual([10, 10, 10, 10, 10]);
      expect(body.balance).toBe(10);
    }),
    options,
  );

  test(
    "a discarded persisted message with a primary key runs once",
    Effect.gen(function* () {
      const id = `conf-add-forget-${Date.now()}`;
      expect((yield* get(`${baseUrl()}/add-forget/${id}/op-1`)).value).toBe("sent");
      const value = yield* get(`${baseUrl()}/get/${id}`).pipe(
        Effect.map((body) => body.value as number),
        Effect.repeat({ schedule: Schedule.spaced("500 millis"), until: (n) => n > 0, times: 20 }),
      );
      expect(value).toBe(5);
      yield* Effect.sleep("2 seconds");
      expect((yield* get(`${baseUrl()}/get/${id}`)).value).toBe(5);
    }),
    options,
  );

  test(
    "an idle instance stops after its maxIdleTime, unless kept alive",
    Effect.gen(function* () {
      const id = `conf-idle-${Date.now()}`;
      yield* get(`${baseUrl()}/remember/${id}-held/7`);
      yield* get(`${baseUrl()}/pin/${id}-held`);
      yield* get(`${baseUrl()}/remember/${id}-idle/7`);
      // The ledger's maxIdleTime is five seconds.
      yield* Effect.sleep("20 seconds");
      expect((yield* get(`${baseUrl()}/recall/${id}-held`)).value).toBe(7);
      expect((yield* get(`${baseUrl()}/recall/${id}-idle`)).value).toBe(0);
    }),
    options,
  );

  test(
    "a DeliverAt message wakes an entity nothing is calling",
    Effect.gen(function* () {
      const id = `conf-wake-${Date.now()}`;
      const { at }: { at: number } = yield* get(`${baseUrl()}/later/${id}/20000`);
      // No calls until its time has passed: only the host can run it.
      yield* Effect.sleep(Duration.millis(20_000 + deliverWithinMillis));
      const ranAt: number = (yield* get(`${baseUrl()}/ran-at/${id}`)).value;
      expect(ranAt).toBeGreaterThanOrEqual(at - 1_000);
      expect(ranAt - at).toBeLessThanOrEqual(deliverWithinMillis);
      expect((yield* get(`${baseUrl()}/get/${id}`)).value).toBe(5);
    }),
    options,
  );

  test(
    "an ask with DeliverAt answers every caller at its time, having run once",
    Effect.gen(function* () {
      const id = `conf-later-ask-${Date.now()}`;
      const body = yield* get(`${baseUrl()}/later-ask/${id}/3000`);
      expect(body.values).toEqual([5, 5]);
      expect(body.elapsed).toBeGreaterThanOrEqual(2_500);
      expect((yield* get(`${baseUrl()}/get/${id}`)).value).toBe(5);
    }),
    options,
  );

  test(
    "Rpc.uninterruptible finishes after its caller is interrupted",
    Effect.gen(function* () {
      const id = `conf-settle-${Date.now()}`;
      expect((yield* get(`${baseUrl()}/settle/${id}`)).value).toBe("timed out");
      const settled = yield* get(`${baseUrl()}/settled/${id}`).pipe(
        Effect.map((body) => body.value as boolean),
        Effect.repeat({ schedule: Schedule.spaced("500 millis"), until: (b) => b, times: 20 }),
      );
      expect(settled).toBe(true);
    }),
    options,
  );

  test(
    "a message interrupted while it waits its turn never runs",
    Effect.gen(function* () {
      const body = yield* get(`${baseUrl()}/queued-interrupt/conf-queued-${Date.now()}`);
      expect(body).toEqual({ waited: "released", abandoned: "timed out", marked: false });
    }),
    options,
  );

  test(
    "messages arriving while an instance is built share that one build",
    Effect.gen(function* () {
      expect((yield* get(`${baseUrl()}/builds/conf-builds-${Date.now()}`)).value).toBe(1);
    }),
    options,
  );

  test(
    "a persisted stream with a primary key runs once",
    Effect.gen(function* () {
      const id = `conf-countdown-${Date.now()}`;
      const first = yield* get(`${baseUrl()}/countdown/${id}/op-1`);
      expect(first.values).toEqual([1, 2, 3, 4, 5]);
      expect(first.runs).toBe(1);
      // A duplicate sent after it finished ends without running it again.
      expect((yield* get(`${baseUrl()}/countdown/${id}/op-1`)).runs).toBe(1);
      const second = yield* get(`${baseUrl()}/countdown/${id}/op-2`);
      expect(second.values).toEqual([1, 2, 3, 4, 5]);
      expect(second.runs).toBe(2);
    }),
    options,
  );

  test(
    "a full mailbox turns a volatile message away",
    Effect.gen(function* () {
      const body = yield* get(`${baseUrl()}/pass-race/conf-full-${Date.now()}`);
      expect([...(body.results as string[])].sort()).toEqual(["full", "full", "passed", "passed"]);
    }),
    options,
  );

  test(
    "a persisted message waits for room in a full mailbox",
    Effect.gen(function* () {
      const body = yield* get(`${baseUrl()}/pass-once-race/conf-room-${Date.now()}`);
      expect([...(body.values as number[])].sort()).toEqual([1, 2, 3, 4, 5]);
      expect(body.passed).toBe(5);
    }),
    options,
  );
};
