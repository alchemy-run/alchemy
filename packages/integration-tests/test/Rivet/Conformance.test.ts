import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
import { ensureDockerSwarm } from "../Docker/Runtime.ts";
import { FRONT_PORT } from "./fixtures/cluster.ts";
import Front from "./fixtures/front.ts";
import { ReentrantLive } from "./fixtures/reentrant.ts";

const testOptions = { providers: Layer.mergeAll(Docker.providers(), Rivet.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "RivetConformance", import.meta.url);

const baseUrl = `http://localhost:${FRONT_PORT}`;

// The engine conformance spec, run against Rivet Durable Objects on a local
// Docker control plane, called from a Docker service through the gateway.
describe.skipIf(!!process.env.FAST)(
  "Rivet engine conformance",
  { tags: ["provider:rivet", "provider:rivet:durable-object", "local"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        // NO_DESTROY keeps the stack between runs, so iterate on it.
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const outputs = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const front = yield* Front;
            return { front: front.name };
          }).pipe(Effect.provide(ReentrantLive)),
        );
        expect(outputs.front).toBeTruthy();
        yield* waitForReady(baseUrl, { attempts: 40, base: "3 seconds" });
      }),
      { timeout: 400_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 300_000 });

    conformanceTests(test, { baseUrl: () => baseUrl, kind: "local" });

    // GET a tally route on a fresh instance; a retried attempt starts over.
    const tally = <T>(path: string, query: string) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return (yield* Effect.suspend(() =>
          client.get(`${baseUrl}/${path}/${crypto.randomUUID()}?${query}`),
        ).pipe(
          Effect.flatMap((res) => res.json),
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
        )) as T;
      });

    describe("in parallel, without an input gate", () => {
      test(
        "a call's storage overlaps another call's",
        Effect.gen(function* () {
          const { seen, n } = yield* tally<{ seen: number; n: number }>("overlap", "n=500");
          expect(seen).toBeGreaterThan(0);
          expect(seen).toBeLessThan(n);
        }),
        { timeout: 120_000 },
      );

      test(
        "concurrent transactional increments lose no updates",
        Effect.gen(function* () {
          const { count } = yield* tally<{ count: number }>("race", "n=50&tx=1");
          expect(count).toBe(50);
        }),
        { timeout: 120_000 },
      );
    });

    describe("behind Workers.InputGate", () => {
      test(
        "a call's storage waits for another call's run of storage",
        Effect.gen(function* () {
          const { seen, n } = yield* tally<{ seen: number; n: number }>("overlap", "n=500&gated=1");
          expect(seen).toBe(n);
        }),
        { timeout: 120_000 },
      );

      test(
        "concurrent get-then-put calls on one instance lose no updates",
        Effect.gen(function* () {
          const { count } = yield* tally<{ count: number }>("race", "n=50&gated=1");
          expect(count).toBe(50);
        }),
        { timeout: 120_000 },
      );

      test(
        "a background loop the constructor starts loses no updates to concurrent calls",
        Effect.gen(function* () {
          const { count } = yield* tally<{ count: number }>("background", "n=50&gated=1");
          expect(count).toBe(100);
        }),
        { timeout: 120_000 },
      );
    });

    // In parallel, the increments racing the transaction are transactions
    // too: plain ones would lose updates to each other.
    for (const [mode, query] of [
      ["in parallel", "gated=0&tx=1"],
      ["behind Workers.InputGate", "gated=1"],
    ] as const) {
      describe(mode, () => {
        test(
          "a transaction keeps other calls out and rolls back on failure",
          Effect.gen(function* () {
            const result = yield* tally<{ count: number; aborted: boolean }>(
              "transaction",
              `n=10&${query}`,
            );
            expect(result).toEqual({ count: 110, aborted: true });
          }),
          { timeout: 120_000 },
        );

        test(
          "an alarm replaced while it fires leaves the new alarm set and doesn't run",
          Effect.gen(function* () {
            const result = yield* tally<{ fired: number; alarm: number | null }>(
              "alarm-replaced",
              query,
            );
            expect(result.fired).toBe(0);
            expect(result.alarm).not.toBeNull();
          }),
          { timeout: 120_000 },
        );
      });
    }

    describe("calls that could deadlock on a transaction", () => {
      interface Outcome {
        ok: boolean;
        error?: string;
        ms: number;
      }
      // A fresh instance per case; never retried, so a hang shows as one.
      const run = <T>(which: string, prefix = "") =>
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const res = yield* client.get(
            `${baseUrl}/reentrant/${prefix}${crypto.randomUUID()}/${which}`,
          );
          expect(res.status).toBe(200);
          return (yield* res.json) as T;
        });
      // Fails fast, rather than waiting on a timeout.
      const fast = 5_000;

      test(
        "a constructor calling its own instance fails fast and the instance still serves",
        Effect.gen(function* () {
          const result = yield* run<{ constructed: Outcome; touched: number; tx: number }>(
            "constructor",
            "ctor-",
          );
          expect(result.constructed).toMatchObject({ ok: false, error: "RpcCallError 508" });
          expect(result.constructed.ms).toBeLessThan(fast);
          expect(result.touched).toBe(1);
        }),
        { timeout: 120_000 },
      );

      test(
        "a transaction calling its own instance fails fast and rolls back",
        Effect.gen(function* () {
          const result = yield* run<{ result: Outcome; touched: number; tx: number }>("self");
          expect(result.result).toMatchObject({ ok: false, error: "RpcCallError 508" });
          expect(result.result.ms).toBeLessThan(fast);
          expect(result).toMatchObject({ touched: 1, tx: 0 });
        }),
        { timeout: 120_000 },
      );

      test(
        "a transaction calling back into its instance through another fails fast",
        Effect.gen(function* () {
          const result = yield* run<{ result: Outcome; touched: number; tx: number }>("peer");
          expect(result.result.ok).toBe(false);
          expect(result.result.ms).toBeLessThan(fast);
          expect(result).toMatchObject({ touched: 1, tx: 0 });
        }),
        { timeout: 120_000 },
      );

      test(
        "a transaction calling its own instance without storage succeeds",
        Effect.gen(function* () {
          const result = yield* run<{ result: Outcome; touched: number; tx: number }>("ping");
          expect(result.result.ok).toBe(true);
          expect(result).toMatchObject({ touched: 1, tx: 1 });
        }),
        { timeout: 120_000 },
      );

      test(
        "a call back into its own instance outside a transaction succeeds",
        Effect.gen(function* () {
          const result = yield* run<{ result: Outcome; touched: number; tx: number }>("outside");
          expect(result.result.ok).toBe(true);
          expect(result).toMatchObject({ touched: 2, tx: 0 });
        }),
        { timeout: 120_000 },
      );

      test(
        "a transaction waiting on a call that needs storage times out, rolls back and lets it run",
        Effect.gen(function* () {
          const result = yield* run<{
            result: Outcome;
            release: Outcome;
            released: number;
            touched: number;
            tx: number;
          }>("await");
          expect(result.result).toMatchObject({ ok: false, error: "Rivet.TransactionTimedOut" });
          expect(result.result.ms).toBeGreaterThanOrEqual(29_000);
          expect(result.result.ms).toBeLessThan(40_000);
          expect(result.release.ok).toBe(true);
          expect(result).toMatchObject({ released: 1, touched: 1, tx: 0 });
        }),
        { timeout: 180_000 },
      );

      test(
        "a transaction past its timeout stops before its next write",
        Effect.gen(function* () {
          const result = yield* run<{ result: Outcome; late: number; touched: number }>("late");
          expect(result.result).toMatchObject({ ok: false, error: "Rivet.TransactionTimedOut" });
          expect(result.result.ms).toBeLessThan(2_500);
          expect(result).toMatchObject({ late: 0, touched: 1 });
        }),
        { timeout: 120_000 },
      );

      test(
        "work a transaction starts that outlives it writes once it has committed",
        Effect.gen(function* () {
          const result = yield* run<{
            result: Outcome;
            waited: number;
            forked: number;
            tx: number;
          }>("outlive");
          expect(result.result.ok).toBe(true);
          expect(result).toMatchObject({ waited: 1, forked: 1, tx: 1 });
        }),
        { timeout: 120_000 },
      );

      interface AlarmState {
        runs: number;
        done: number;
        alarm: number | null;
      }

      test(
        "a failing alarm is retried until it succeeds",
        Effect.gen(function* () {
          const result = yield* run<{ before: AlarmState; alarm: AlarmState }>("flaky-alarm");
          expect(result.before).toMatchObject({ runs: 3, done: 1 });
          expect(result.alarm).toEqual({ runs: 3, done: 1, alarm: null });
        }),
        { timeout: 180_000 },
      );

      test(
        "an alarm running longer than an action may finishes once",
        Effect.gen(function* () {
          const result = yield* run<{ before: AlarmState; alarm: AlarmState }>("slow-alarm");
          expect(result.alarm).toEqual({ runs: 1, done: 1, alarm: null });
        }),
        { timeout: 200_000 },
      );
    });

    test(
      "a second class on the same pool calls the first through the gateway",
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const greet = client.get(`${baseUrl}/greet/sam`).pipe(
          Effect.flatMap((res) => res.json),
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
        );
        const first = (yield* greet) as { greeting: string };
        const second = (yield* greet) as { greeting: string };
        expect(first.greeting).toMatch(/^hello sam #\d+$/);
        const n = (s: string) => Number(s.split("#")[1]);
        expect(n(second.greeting)).toBe(n(first.greeting) + 1);
      }),
      { timeout: 120_000 },
    );

    describe("WebSockets", () => {
      /** A WebSocket to `path` on the front, read one JSON frame at a time. */
      const connect = (path: string) =>
        Effect.gen(function* () {
          const socket = yield* Socket.makeWebSocket(`ws://localhost:${FRONT_PORT}${path}`);
          const { pull } = yield* socket.reader;
          const writer = yield* socket.writer;
          const frames: Array<unknown> = [];
          const next = Effect.gen(function* () {
            while (frames.length === 0) {
              for (const frame of yield* pull) {
                frames.push(
                  JSON.parse(typeof frame === "string" ? frame : new TextDecoder().decode(frame)),
                );
              }
            }
            return frames.shift();
          }).pipe(Effect.timeout("20 seconds"));
          return { next, send: (text: string) => writer.write(text) };
        }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal));
      const count = (room: string) =>
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const res = yield* client.get(`${baseUrl}/socket-count/${room}`);
          return ((yield* res.json) as { sockets: number }).sockets;
        });

      test(
        "a Durable Object accepts WebSockets through the gateway and pushes to them",
        Effect.gen(function* () {
          const room = crypto.randomUUID();
          const a = yield* connect(`/socket/${room}?user=a`).pipe(
            Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
          );
          // The instance sees the caller's path, query and headers.
          expect(yield* a.next).toEqual({ welcome: "a", path: `/socket/${room}`, header: room });
          const b = yield* Effect.scoped(
            Effect.gen(function* () {
              const b = yield* connect(`/socket/${room}?user=b`);
              expect(yield* b.next).toEqual({
                welcome: "b",
                path: `/socket/${room}`,
                header: room,
              });
              expect(yield* count(room)).toBe(2);
              // A message reaches `webSocketMessage`, which pushes to every socket.
              yield* a.send("hello");
              expect(yield* a.next).toEqual({ from: "a", text: "hello" });
              expect(yield* b.next).toEqual({ from: "a", text: "hello" });
              return b;
            }),
          );
          expect(b).toBeDefined();
          // b's socket closed with its scope; the room lets it go.
          yield* count(room).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("500 millis"),
              until: (n) => n === 1,
              times: 20,
            }),
          );
          yield* a.send("still here");
          expect(yield* a.next).toEqual({ from: "a", text: "still here" });
        }).pipe(Effect.scoped),
        { timeout: 120_000 },
      );
    });

    describe("Durable Streams", { tags: ["provider:rivet:durable-stream"] }, () => {
      // GET a stream case on a fresh stream; a retried attempt starts over.
      const stream = <T>(which: string) =>
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          return (yield* Effect.suspend(() =>
            client.get(`${baseUrl}/durable-stream/${crypto.randomUUID()}/${which}`),
          ).pipe(
            Effect.flatMap((res) => res.json),
            Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
          )) as T;
        });
      const m = (user: string, text: string) => ({ user, text });
      type Read = { messages: unknown[]; next: string; upToDate: boolean; closed: boolean };

      test(
        "appends create the stream, and a read from its next offset returns only what came after",
        Effect.gen(function* () {
          const { first, second } = yield* stream<{ first: Read; second: Read }>("roundtrip");
          expect(first.messages).toEqual([m("a", "one"), m("b", "two"), m("a", "three")]);
          expect(first.upToDate).toBe(true);
          expect(first.closed).toBe(false);
          expect(second.messages).toEqual([m("b", "four")]);
        }),
        { timeout: 120_000 },
      );

      test(
        "a tail replays history, then follows new appends live",
        Effect.gen(function* () {
          const { messages } = yield* stream<{ messages: unknown[] }>("tail");
          expect(messages).toEqual([m("a", "1"), m("a", "2"), m("a", "3"), m("a", "4")]);
        }),
        { timeout: 120_000 },
      );

      test(
        "a closed stream refuses appends, and its tail ends",
        Effect.gen(function* () {
          const { after, read, tailed } = yield* stream<{
            after: string;
            read: Read;
            tailed: unknown[];
          }>("closed");
          expect(after).toBe("Rivet.DurableStreamConflict");
          expect(read.closed).toBe(true);
          expect(read.messages).toEqual([m("a", "last")]);
          expect(tailed).toEqual([m("a", "last")]);
        }),
        { timeout: 120_000 },
      );

      test(
        "a stream with its own format writes and reads SchemaBinary on a byte stream",
        Effect.gen(function* () {
          const { read, live } = yield* stream<{ read: Read; live: unknown[] }>("binary");
          expect(read.messages).toEqual([m("a", "één"), m("b", "two")]);
          expect(live).toEqual([m("a", "één"), m("b", "two"), m("a", "three")]);
        }),
        { timeout: 120_000 },
      );

      test(
        "an idempotent writer's repeated append is written once, and an older epoch is refused",
        Effect.gen(function* () {
          const { read, stale } = yield* stream<{ read: Read; stale: string }>("producer");
          expect(read.messages).toEqual([m("a", "once")]);
          expect(stale).toBe("Rivet.DurableStreamStaleProducer");
        }),
        { timeout: 120_000 },
      );

      test(
        "a stream nobody appended to is not found, and a deleted one is gone",
        Effect.gen(function* () {
          const missing = yield* stream<{ read: string }>("missing");
          expect(missing.read).toBe("Rivet.DurableStreamNotFound");
          const deleted = yield* stream<{ read: string }>("deleted");
          expect(deleted.read).toBe("Rivet.DurableStreamNotFound");
        }),
        { timeout: 120_000 },
      );

      test(
        "a Durable Object appends to a stream that another runtime reads",
        Effect.gen(function* () {
          const read = yield* stream<Read>("room");
          expect(read.messages).toEqual([m("a", "from a room"), m("b", "and again")]);
        }),
        { timeout: 120_000 },
      );
    });
  },
);
