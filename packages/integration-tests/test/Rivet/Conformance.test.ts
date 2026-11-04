import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
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

    conformanceTests(test, { baseUrl: () => baseUrl });

    test(
      "concurrent get-then-put calls on one instance lose no updates",
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        // A fresh instance per attempt, so a retried attempt starts from zero.
        const { count } = (yield* Effect.suspend(() =>
          client.get(`${baseUrl}/race/${crypto.randomUUID()}?n=50`),
        ).pipe(
          Effect.flatMap((res) => res.json),
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
        )) as { count: number };
        expect(count).toBe(50);
      }),
      { timeout: 120_000 },
    );

    test(
      "a transaction keeps other calls out and rolls back on failure",
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const result = (yield* Effect.suspend(() =>
          client.get(`${baseUrl}/transaction/${crypto.randomUUID()}?n=10`),
        ).pipe(
          Effect.flatMap((res) => res.json),
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
        )) as { count: number; aborted: boolean };
        expect(result).toEqual({ count: 110, aborted: true });
      }),
      { timeout: 120_000 },
    );

    test(
      "a background loop the constructor starts loses no updates to concurrent calls",
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const { count } = (yield* Effect.suspend(() =>
          client.get(`${baseUrl}/background/${crypto.randomUUID()}?n=50`),
        ).pipe(
          Effect.flatMap((res) => res.json),
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
        )) as { count: number };
        expect(count).toBe(100);
      }),
      { timeout: 120_000 },
    );

    test(
      "an alarm replaced while it fires leaves the new alarm set and doesn't run",
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const result = (yield* Effect.suspend(() =>
          client.get(`${baseUrl}/alarm-replaced/${crypto.randomUUID()}`),
        ).pipe(
          Effect.flatMap((res) => res.json),
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
        )) as { fired: number; alarm: number | null };
        expect(result.fired).toBe(0);
        expect(result.alarm).not.toBeNull();
      }),
      { timeout: 120_000 },
    );

    describe("calls that could deadlock on the input gate", () => {
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
  },
);
