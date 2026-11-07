/**
 * The cases every Domain platform passes, driven over HTTP against a front
 * serving {@link app} over the conformance model. Each case uses keys of
 * its own, unique to the run, so a retried or repeated run starts fresh.
 */
import { expect } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";

type TestFn = (
  name: string,
  effect: Effect.Effect<void, any, any>,
  options?: { readonly timeout?: number; readonly tags?: ReadonlyArray<string> },
) => void;

export interface ConformanceOptions {
  readonly test: TestFn;
  /** The front's base URL, once it is deployed. */
  readonly url: Effect.Effect<string, any, any>;
  /** Where the platform runs: on this machine, or in a cloud. */
  readonly kind: "local" | "live";
  /** How long a case waits for asynchronous work (deliveries, sagas, timers). */
  readonly within?: number;
}

const fresh = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}`;

const get = <T>(base: string, path: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(`${base}${path}`);
    if (response.status !== 200) {
      return yield* Effect.fail(
        new Error(`${path} answered ${response.status}: ${yield* response.text}`),
      );
    }
    return (yield* response.json) as T;
  });

/** Wait for the front to serve. */
export const waitForReady = (url: string) =>
  get<unknown>(url, "/ready").pipe(
    Effect.catch(() => Effect.fail("not ready")),
    Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 60 }),
    Effect.ignore,
  );

export const conformance = ({ test, url, kind, within = 30_000 }: ConformanceOptions) => {
  const options = { timeout: 120_000, tags: [kind] };
  /** GET a route of the front. */
  const call = <T>(path: string) => Effect.flatMap(url, (base) => get<T>(base, path));
  const eventually = <T>(path: string, until: (value: T) => boolean) =>
    call<T>(path).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("500 millis"),
        until,
        times: Math.ceil(within / 500),
      }),
    );

  test(
    "a command commits and replies with the new state",
    Effect.gen(function* () {
      const id = fresh("commit");
      expect(yield* call(`/increment/${id}?by=2`)).toMatchObject({ accepted: 2 });
      expect(yield* call(`/increment/${id}?by=3`)).toMatchObject({ accepted: 5 });
      expect(yield* call(`/counter/${id}`)).toEqual({ total: 5 });
    }),
    options,
  );

  test(
    "a rejected command commits nothing",
    Effect.gen(function* () {
      const id = fresh("reject");
      expect(yield* call(`/increment/${id}?by=11`)).toEqual({ rejected: "TooBig" });
      expect(yield* call(`/counter/${id}`)).toEqual({ total: 0 });
    }),
    options,
  );

  test(
    "a command sent twice under one id commits once",
    Effect.gen(function* () {
      const id = fresh("dedupe");
      const { first, second } = yield* call<{ first: unknown; second: unknown }>(
        `/again/${id}?by=4`,
      );
      expect(first).toEqual(second);
      expect(yield* call(`/counter/${id}`)).toEqual({ total: 4 });
    }),
    options,
  );

  test(
    "commands to one instance run one at a time",
    Effect.gen(function* () {
      const id = fresh("serial");
      yield* Effect.forEach(
        Array.from({ length: 10 }, (_, i) => i),
        () => call(`/increment/${id}?by=1`),
        { concurrency: "unbounded", discard: true },
      );
      expect(yield* call(`/counter/${id}`)).toEqual({ total: 10 });
    }),
    options,
  );

  test(
    "a view applies every event once, in order",
    Effect.gen(function* () {
      const id = fresh("view");
      for (const by of [1, 2, 3]) yield* call(`/increment/${id}?by=${by}`);
      const total = yield* eventually<{ total: number; increments: number }>(
        `/total/${id}`,
        (view) => view.increments >= 3,
      );
      expect(total).toEqual({ total: 6, increments: 3 });
    }),
    options,
  );

  test(
    "a policy starts a saga, and the saga's step commits",
    Effect.gen(function* () {
      const id = fresh("saga");
      yield* call(`/increment/${id}?by=7`);
      // One run per counter: a second increment starts nothing new.
      yield* call(`/increment/${id}?by=1`);
      const echo = yield* eventually<{ total: number }>(`/echo/${id}`, (e) => e.total > 0);
      expect(echo).toEqual({ total: 7 });
    }),
    options,
  );

  test(
    "a scheduled command runs when it is due",
    Effect.gen(function* () {
      const id = fresh("expire");
      expect(yield* call(`/place/${id}`)).toEqual({ status: "held" });
      const hold = yield* eventually<{ status: string }>(
        `/hold/${id}`,
        (h) => h.status === "expired",
      );
      expect(hold).toEqual({ status: "expired" });
    }),
    options,
  );

  test(
    "a cancelled command never runs",
    Effect.gen(function* () {
      const id = fresh("release");
      yield* call(`/place/${id}`);
      expect(yield* call(`/release/${id}`)).toEqual({ status: "released" });
      // Past the hold's window, and the policy's delivery.
      yield* Effect.sleep("10 seconds");
      expect(yield* call(`/hold/${id}`)).toEqual({ status: "released" });
    }),
    options,
  );
};
