/**
 * The cases every Domain platform passes, driven over HTTP against a front
 * serving {@link app} over the conformance model. Each case uses keys of
 * its own, unique to the run, so a retried or repeated run starts fresh.
 */
import { expect } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { ConformanceApi } from "./model.ts";

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
    "a live read is pushed over a WebSocket",
    Effect.gen(function* () {
      const id = fresh("live");
      const base = yield* url;
      // A platform that can't hold the read's socket answers 501, and the
      // client gives up instead of falling back to polling.
      const api = yield* ConformanceApi.clientWebSocket(`${base}/api`);
      const watched = yield* api.CounterTotal.watch(id).pipe(
        Stream.map((frame) => frame.state?.total ?? 0),
        Stream.takeUntil((total) => total === 5),
        Stream.runCollect,
        Effect.timeout(within),
        Effect.forkChild,
      );
      yield* Effect.sleep("1 second");
      yield* call(`/increment/${id}?by=2`);
      yield* call(`/increment/${id}?by=3`);
      const totals = [...(yield* Fiber.join(watched))];
      expect(totals.at(-1)).toBe(5);
      expect(totals).toEqual([...totals].sort((a, b) => a - b));
    }).pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal)),
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
    "a view lists its entries a page at a time, in either order",
    Effect.gen(function* () {
      const id = fresh("pages");
      for (const by of [1, 2, 3, 4, 5]) yield* call(`/increment/${id}?by=${by}`);
      yield* eventually<{ increments: number }>(`/total/${id}`, (view) => view.increments === 5);
      type Page = { totals: ReadonlyArray<number>; cursor: number | null };
      const newest = yield* call<Page>(`/totals/${id}?order=desc&take=2`);
      expect(newest).toEqual({ totals: [15, 10], cursor: 4 });
      expect(yield* call<Page>(`/totals/${id}?order=desc&take=2&after=4`)).toEqual({
        totals: [6, 3],
        cursor: 2,
      });
      expect(yield* call<Page>(`/totals/${id}?order=desc&take=2&after=2`)).toEqual({
        totals: [1],
        cursor: null,
      });
      expect(yield* call<Page>(`/totals/${id}?take=2&after=2`)).toEqual({
        totals: [6, 10],
        cursor: 4,
      });
      expect(yield* call<Page>(`/totals/${id}?take=2&after=4`)).toEqual({
        totals: [15],
        cursor: null,
      });
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
