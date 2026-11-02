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

export const conformanceTests = (test: TestFn, { baseUrl }: { baseUrl: () => string }) => {
  const options = { timeout: 120_000 };

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

  test(
    "an external program's entity is called like any other",
    Effect.gen(function* () {
      const a: number = (yield* get(`${baseUrl()}/tally/conf-tally/2`)).value;
      const b: number = (yield* get(`${baseUrl()}/tally/conf-tally/3`)).value;
      expect(b - a).toBe(3);
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
