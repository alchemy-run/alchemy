/**
 * The cases every Domain platform passes, driven over HTTP against a front
 * serving {@link app} over the conformance model. Each case uses keys of
 * its own, unique to the run, so a retried or repeated run starts fresh.
 */
import { expect } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { ConformanceApi, SECRET } from "./model.ts";

type TestFn = (
  name: string,
  effect: Effect.Effect<void, any, any>,
  options?: {
    readonly timeout?: number;
    readonly tags?: ReadonlyArray<string>;
    readonly exclusive?: boolean;
  },
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

/**
 * The first frame a live read's WebSocket receives, opened by hand at an
 * Api's URL: what any caller sees, cursor included, without the client.
 */
export const liveFrame = (
  api: string,
  read: { readonly tag: string; readonly key: string; readonly cursor?: number },
) =>
  Effect.gen(function* () {
    const request = {
      id: 1,
      tag: read.tag,
      payload: { key: read.key },
      ...(read.cursor === undefined ? {} : { cursor: read.cursor }),
    };
    const socket = yield* Socket.makeWebSocket(
      `${api.replace(/^http/, "ws")}?read=${encodeURIComponent(JSON.stringify(request))}`,
    );
    const pull = yield* Socket.readerString(socket);
    for (;;) {
      const [text] = yield* pull;
      if (text !== undefined) return JSON.parse(text) as Record<string, unknown>;
    }
  }).pipe(
    Effect.scoped,
    // A read that stays open says nothing: the case expects a frame.
    Effect.timeout("10 seconds"),
    Effect.provide(Socket.layerWebSocketConstructorGlobal),
  );

/** How long a refused read may take: well under a read's wait for `atLeast`. */
const AT_ONCE = "5 seconds";

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
    "a refused read looks the same for a key with history and one without",
    Effect.gen(function* () {
      const has = fresh("hidden");
      const none = fresh("never");
      yield* call(`/increment/${has}?by=1`);
      yield* call(`/hidden/${has}?version=1`);
      const base = yield* url;
      const api = yield* ConformanceApi.clientWebSocket(`${base}/api`);
      for (const key of [has, none]) {
        // A version neither key has reached: the read is refused before it waits.
        const atLeast = { stream: `Counter/${key}`, version: 5 };
        const refusals = yield* Effect.all([
          api.HiddenTotal.get(key, { atLeast }).pipe(Effect.flip),
          api.HiddenTotal.snapshot(key, { atLeast }).pipe(Effect.flip),
          api.HiddenTotal.list(key, { atLeast }).pipe(Effect.flip),
          api.HiddenTotal.events(key).pipe(Stream.runHead, Effect.flip),
          api.HiddenTotal.events(key, { after: 5 }).pipe(Stream.runHead, Effect.flip),
          api.HiddenTotal.watch(key).pipe(Stream.runHead, Effect.flip),
        ]).pipe(Effect.timeout(AT_ONCE));
        expect(refusals.map((refusal) => refusal._tag)).toEqual(Array(6).fill("Hidden"));
      }
    }).pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal)),
    options,
  );

  test(
    "a refused live read carries nothing of the key's state",
    Effect.gen(function* () {
      const has = fresh("hidden");
      const none = fresh("never");
      for (const by of [1, 2]) yield* call(`/increment/${has}?by=${by}`);
      yield* call(`/hidden/${has}?version=2`);
      const api = `${yield* url}/api`;
      for (const read of [
        { tag: "HiddenTotal.watch" },
        // A resume cursor is no shortcut past `validate`.
        { tag: "HiddenTotal.watch", cursor: 0 },
        { tag: "HiddenTotal.events" },
        { tag: "HiddenTotal.events", cursor: 5 },
      ]) {
        const [withHistory, withNone] = yield* Effect.all([
          liveFrame(api, { ...read, key: has }),
          liveFrame(api, { ...read, key: none }),
        ]);
        expect(withHistory._tag).toBe("Exit");
        // The same refusal, and the cursor the caller sent: never the key's.
        expect(withHistory).toEqual(withNone);
      }
    }),
    options,
  );

  test(
    "a live read is judged again when its middleware's verdict runs out, with no commit",
    Effect.gen(function* () {
      const id = fresh("ticket");
      yield* call(`/increment/${id}?by=1`);
      const base = yield* url;
      /** A client whose live reads send `ticket` (see `Ticket`): Bun's WebSocket takes headers. */
      const clientWith = (ticket: string) =>
        ConformanceApi.clientWebSocket(`${base}/api`).pipe(
          Effect.provideService(Socket.WebSocketConstructor, (socketUrl, protocols) => {
            const init = { protocols, headers: { "x-ticket": ticket } };
            return new WebSocket(socketUrl, init as unknown as string[]);
          }),
        );
      const watch = (api: Effect.Success<ReturnType<typeof clientWith>>, first: number) =>
        Effect.gen(function* () {
          const seen = yield* Queue.unbounded<number | undefined>();
          const read = yield* api.TicketedTotal.watch(id).pipe(
            Stream.runForEach((frame) => Queue.offer(seen, frame.state?.total)),
            Effect.flip,
            Effect.forkScoped,
          );
          // The view folds the increment eventually: frames before it carry less.
          const next = Queue.take(seen).pipe(Effect.timeout(within));
          let total = yield* next;
          while (total !== first) total = yield* next;
          return { seen, read };
        });

      // Still signed in: each verdict holds 2 seconds, and the read rides over every close.
      const signedIn = yield* watch(yield* clientWith("for:2000"), 1);
      yield* Effect.sleep("6 seconds");
      expect(yield* Queue.size(signedIn.seen)).toBe(0);
      yield* call(`/increment/${id}?by=2`);
      expect(yield* Queue.take(signedIn.seen).pipe(Effect.timeout(within))).toBe(3);

      // A ticket that expires: once it has, the read ends with the middleware's rejection.
      const expiring = yield* watch(
        yield* clientWith(`until:${(yield* Clock.currentTimeMillis) + 5_000}`),
        3,
      );
      const ended = yield* Fiber.join(expiring.read).pipe(Effect.timeout(within));
      expect(ended._tag).toBe("Expired");
      expect(yield* Queue.size(expiring.seen)).toBe(0);
      expect(yield* Queue.size(signedIn.seen)).toBe(0);
    }).pipe(Effect.scoped),
    options,
  );

  test(
    "a defect reaches the client as a generic error",
    Effect.gen(function* () {
      const base = yield* url;
      const api = yield* ConformanceApi.clientWebSocket(`${base}/api`);
      const exit = yield* api.Explode({ id: fresh("explode") }).pipe(Effect.exit);
      if (!Exit.isFailure(exit)) return yield* Effect.die("Explode committed");
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(String((Cause.squash(exit.cause) as { message?: unknown }).message)).toBe(
        "Internal server error",
      );
      expect(Cause.pretty(exit.cause)).not.toContain(SECRET);
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
    "a decision commits to every instance it reads",
    Effect.gen(function* () {
      const [from, to] = [fresh("give-from"), fresh("give-to")];
      yield* call(`/increment/${from}?by=5`);
      expect(yield* call(`/give/${from}?to=${to}&by=3`)).toEqual({
        accepted: 2,
        commits: [
          { stream: `Counter/${from}`, version: 2 },
          { stream: `Counter/${to}`, version: 1 },
        ],
      });
      expect(yield* call(`/counter/${from}`)).toEqual({ total: 2 });
      expect(yield* call(`/counter/${to}`)).toEqual({ total: 3 });
      // Each instance takes its own commands again, and its view follows.
      expect(yield* call(`/increment/${to}?by=1`)).toMatchObject({ accepted: 4 });
      const view = yield* eventually<{ total: number }>(`/total/${to}`, (v) => v.total === 4);
      expect(view).toMatchObject({ total: 4 });
    }),
    options,
  );

  test(
    "a rejected decision commits nothing",
    Effect.gen(function* () {
      const [from, to] = [fresh("short-from"), fresh("short-to")];
      yield* call(`/increment/${from}?by=2`);
      expect(yield* call(`/give/${from}?to=${to}&by=3`)).toEqual({ rejected: "Short" });
      expect(yield* call(`/counter/${from}`)).toEqual({ total: 2 });
      expect(yield* call(`/counter/${to}`)).toEqual({ total: 0 });
    }),
    options,
  );

  test(
    "a decision sent twice under one id commits once",
    Effect.gen(function* () {
      const [from, to] = [fresh("once-from"), fresh("once-to")];
      yield* call(`/increment/${from}?by=5`);
      const first = yield* call(`/give/${from}?to=${to}&by=2&id=give-${from}`);
      expect(yield* call(`/give/${from}?to=${to}&by=2&id=give-${from}`)).toEqual(first);
      expect(yield* call(`/counter/${from}`)).toEqual({ total: 3 });
      expect(yield* call(`/counter/${to}`)).toEqual({ total: 2 });
    }),
    options,
  );

  test(
    "decisions that share instances commit one at a time, in both directions",
    Effect.gen(function* () {
      const [left, right] = [fresh("swap-left"), fresh("swap-right")];
      yield* call(`/increment/${left}?by=10`);
      yield* call(`/increment/${right}?by=10`);
      type Given = { accepted?: number; rejected?: string };
      const results = yield* Effect.forEach(
        Array.from({ length: 12 }, (_, i) => i),
        (i) =>
          call<Given>(
            i % 2 === 0 ? `/give/${left}?to=${right}&by=4` : `/give/${right}?to=${left}&by=4`,
          ),
        { concurrency: "unbounded" },
      );
      const totals = [
        (yield* call<{ total: number }>(`/counter/${left}`)).total,
        (yield* call<{ total: number }>(`/counter/${right}`)).total,
      ];
      // Nothing is lost or made up, and nobody goes below zero.
      expect(totals[0]! + totals[1]!).toBe(20);
      expect(Math.min(...totals)).toBeGreaterThanOrEqual(0);
      expect(results.filter((result) => result.accepted !== undefined).length).toBeGreaterThan(0);
    }),
    options,
  );

  test(
    "a decision's command is served by an Api, with no target",
    Effect.gen(function* () {
      const [from, to] = [fresh("api-from"), fresh("api-to")];
      const base = yield* url;
      yield* call(`/increment/${from}?by=5`);
      const api = yield* ConformanceApi.clientHttp(`${base}/api`);
      const receipt = yield* api.Give({ from, to, by: 3 });
      expect(receipt.reply).toEqual({ total: 2 });
      expect(receipt.commits.map((commit) => commit.stream)).toEqual([
        `Counter/${from}`,
        `Counter/${to}`,
      ]);
      expect(yield* Effect.flip(api.Give({ from, to, by: 30 }))).toMatchObject({ _tag: "Short" });
    }).pipe(Effect.scoped),
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
    "caughtUp waits for a projection fed by a view",
    Effect.gen(function* () {
      const id = fresh("record");
      // The route reads the projection's stream right after caughtUp: each
      // total is there only if caughtUp waited for the view, then for the
      // projection, which takes a second over each batch.
      expect(yield* call(`/record/${id}?by=2`)).toEqual([2]);
      expect(yield* call(`/record/${id}?by=3`)).toEqual([2, 5]);
    }),
    options,
  );

  test(
    "a policy starts a saga, and its step commits once when it runs again",
    Effect.gen(function* () {
      const id = fresh("saga");
      yield* call(`/increment/${id}?by=7`);
      // One run per counter: a second increment starts nothing new.
      yield* call(`/increment/${id}?by=1`);
      const echo = yield* eventually<{ total: number }>(`/echo/${id}`, (e) => e.total > 0);
      expect(echo).toEqual({ total: 7 });
      // The step's second attempt sent the same command: it never commits again.
      yield* Effect.sleep("3 seconds");
      expect(yield* call(`/echo/${id}`)).toEqual({ total: 7 });
    }),
    options,
  );

  test(
    "an import appends history once, which views and projections apply and policies ignore",
    Effect.gen(function* () {
      const id = fresh("import");
      // History from another system, committed at its own times.
      const at = Date.parse("2020-01-01T00:00:00Z");
      type Imported = { version: number; rejected?: string; index?: number };
      expect(yield* call<Imported>(`/import/${id}?n=3&id=a&at=${at}`)).toEqual({ version: 3 });
      // A retried import commits nothing and answers its first receipt.
      expect(yield* call<Imported>(`/import/${id}?n=3&id=a&at=${at}`)).toEqual({ version: 3 });
      // Another import into an instance with events is refused.
      expect(yield* call<Imported>(`/import/${id}?n=3&id=b`)).toEqual({
        rejected: "UnexpectedVersion",
        version: 3,
      });
      // The next batch continues from the last.
      expect(yield* call<Imported>(`/import/${id}?n=2&id=c&expected=3&at=${at + 3}`)).toEqual({
        version: 5,
      });
      // Times only go forward: from the instance's latest event, within a batch, up to now.
      const refused = (index: number) => ({ rejected: "ImportOutOfOrder", index });
      expect(yield* call(`/import/${id}?n=2&id=d&expected=5&at=${at}`)).toEqual(refused(0));
      expect(yield* call(`/import/${id}?n=2&id=e&expected=5&at=${at + 9}&step=-1`)).toEqual(
        refused(1),
      );
      const future = Date.parse("2100-01-01T00:00:00Z");
      expect(yield* call(`/import/${id}?n=1&id=f&expected=5&at=${future}`)).toEqual(refused(0));
      expect(yield* call(`/counter/${id}`)).toEqual({ total: 5 });
      const times = yield* eventually<{ first: number; last: number }>(
        `/times/${id}`,
        (view) => view.last === at + 4,
      );
      expect(times).toEqual({ first: at, last: at + 4 });
      // A live command after it: the projection has every imported total, then the new one.
      expect(yield* call(`/record/${id}?by=7`)).toEqual([1, 2, 3, 4, 5, 12]);
      // The policy reacts to the live command alone: the saga mirrors 7, not an imported 1.
      const echo = yield* eventually<{ total: number }>(`/echo/${id}`, (e) => e.total > 0);
      expect(echo).toEqual({ total: 7 });
    }),
    options,
  );

  test(
    "an import of 200 events commits them at once",
    Effect.gen(function* () {
      const id = fresh("bulk");
      expect(yield* call(`/import/${id}?on=echo&n=200`)).toEqual({ version: 200 });
      expect(yield* call(`/echo/${id}`)).toEqual({ total: 200 });
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

  test(
    "a policy relays a command through 20 aggregate instances",
    Effect.gen(function* () {
      // Each hop's event makes a policy send a command to the next instance.
      // A platform that runs each hop inside the call that delivered the last
      // one nests deeper every hop, until the host refuses the call (#3627).
      const chain = fresh("relay");
      expect(yield* call(`/relay/${chain}?hops=20`)).toEqual({ passed: true });
      const last = yield* eventually<{ passed: boolean }>(`/hop/${chain}-0`, (hop) => hop.passed);
      expect(last).toEqual({ passed: true });
    }),
    options,
  );
};

export interface RebuildOptions extends Omit<ConformanceOptions, "within"> {
  /**
   * Deploy the front over `ConformanceLive` (0) or `ConformanceLiveV1` (1),
   * and wait until it serves.
   */
  readonly deploy: (version: 0 | 1) => Effect.Effect<void, any, any>;
}

/**
 * A projection rebuilt by a version bump, writing a stream it wrote before:
 * every entry is kept, none is appended twice, and what happens after the
 * bump is appended. A view the bump adds is backfilled from every counter
 * that recorded events before it. The case redeploys the front, so it runs
 * alone and last.
 */
export const rebuild = ({ test, url, kind, deploy }: RebuildOptions) => {
  const call = <T>(path: string) => Effect.flatMap(url, (base) => get<T>(base, path));
  /** Increment a counter of the run, and read the run's tallies once they have it. */
  const tally = (counter: string, by: number) =>
    call<ReadonlyArray<number>>(`/tally/${counter}?by=${by}`);

  type Replay = { readonly total: number; readonly increments: number };
  /** Read the view version 1 adds for a counter, until it holds `expected` or time is up. */
  const replay = (counter: string, expected: Replay) =>
    call<Replay>(`/replay/${counter}`).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (view) => view.total === expected.total && view.increments === expected.increments,
        times: 90,
      }),
    );

  test(
    "a version bump rebuilds a projection, keeping its stream, and backfills a view it adds",
    Effect.gen(function* () {
      yield* deploy(0);
      const run = fresh("rebuild");
      // Version 0 tallies increments and what a decision takes: three inputs.
      expect(yield* call(`/increment/${run}~a?by=5`)).toMatchObject({ accepted: 5 });
      expect(yield* call(`/give/${run}~a?to=${run}~b&by=2`)).toMatchObject({ accepted: 3 });
      expect(yield* tally(`${run}~a`, 1)).toEqual([5, -2, 1]);

      // Version 1 tallies increments alone, rebuilt from the history: two inputs replayed.
      yield* deploy(1);
      expect(
        yield* call<number>("/generation").pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (generation) => generation === 1,
            times: 90,
          }),
        ),
      ).toBe(1);
      // A counter of the same run that is new to this version.
      expect(yield* tally(`${run}~c`, 3)).toEqual([5, -2, 1, 3]);
      // The replay appends nothing again; the increments after the bump are appended.
      expect(yield* tally(`${run}~c`, 4)).toEqual([5, -2, 1, 3, 4]);

      // The view version 1 adds holds what the counters recorded under version 0.
      expect(yield* replay(`${run}~a`, { total: 4, increments: 2 })).toEqual({
        total: 4,
        increments: 2,
      });
      expect(yield* replay(`${run}~b`, { total: 2, increments: 0 })).toEqual({
        total: 2,
        increments: 0,
      });
      expect(yield* replay(`${run}~c`, { total: 7, increments: 2 })).toEqual({
        total: 7,
        increments: 2,
      });
    }),
    { timeout: 900_000, tags: [kind], exclusive: true },
  );
};
