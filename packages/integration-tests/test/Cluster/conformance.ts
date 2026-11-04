/**
 * The Effect Cluster conformance cases, driven over HTTP against a front that
 * calls the entities through their gateway. Every host's suite runs them.
 */
import { expect } from "@alchemy.run/test";
import * as Data from "effect/Data";
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
  }: {
    baseUrl: () => string;
    /** Whether the host under test runs in a real cloud or on this machine. */
    kind: "live" | "local";
    /** Whether the host runs an existing Effect Cluster program (not on Workers). */
    external?: boolean;
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
};
