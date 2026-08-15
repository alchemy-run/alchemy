/**
 * Live test for the Vercel.Function `logs`/`tail` provider hooks — deploys a
 * tiny function that `console.log`s a marker on every request, then drives
 * the hooks resolved via `findProviderByType` (the exact path the
 * `alchemy logs`/`alchemy tail` CLI commands take).
 *
 * Platform reality (PROBES.md): the runtime-logs endpoint is a live-only
 * hanging stream with zero historical delivery, so both assertions capture
 * lines by making requests WHILE a stream/window is open.
 */
import * as Provider from "@/Provider.ts";
import type { LogLine } from "@/Provider.ts";
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureMain = new URL("./fixtures/logs-fn.ts", import.meta.url).pathname;

// Fresh .vercel.app URLs take a few seconds to start serving 200s — always
// retry the first request (bounded).
const readiness = Schedule.max([
  Schedule.exponential("500 millis"),
  Schedule.recurs(20),
]);

const getOk = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.void
        : Effect.fail(new Error(`status ${response.status}`)),
    ),
    Effect.retry({ schedule: readiness }),
  );

const MARKER = "alchemy-logs-probe";

test.provider(
  "tail streams runtime request logs; logs captures a bounded window",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.Function("LogsFn", { main: fixtureMain });
        }),
      );
      expect(fn.url).toBeDefined();
      expect(fn.deploymentId).toBeDefined();

      // Warm the URL so the tail loop's requests hit a serving deployment.
      yield* getOk(`${fn.url}/warm`);

      // Resolve the SAME provider service the CLI commands use.
      const provider =
        yield* Provider.findProviderByType<Vercel.Function>("Vercel.Function");
      expect(provider.tail).toBeDefined();
      expect(provider.logs).toBeDefined();

      const hookInput = {
        id: "LogsFn",
        fqn: "LogsTestStack/LogsFn",
        instanceId: fn.deploymentId,
        props: { main: fixtureMain },
        output: fn,
      };

      // ── tail: collect the live stream while poking the function ────────
      const captured: LogLine[] = [];
      const collector = yield* Effect.forkChild(
        provider.tail!(hookInput).pipe(
          Stream.runForEach((line) => Effect.sync(() => captured.push(line))),
        ),
      );

      const sawTailLine = yield* Effect.gen(function* () {
        yield* HttpClient.get(`${fn.url}/tail-probe`).pipe(Effect.ignore);
        yield* Effect.sleep("3 seconds");
        return captured.some((line) => line.message.includes(MARKER));
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (found) => found,
          times: 10,
        }),
      );
      yield* Fiber.interrupt(collector);
      expect(sawTailLine).toBe(true);

      // ── logs: a bounded read captures a request made inside its window ──
      const sawLogsLine = yield* Effect.gen(function* () {
        // Fire a request ~1.5s into the 5s live-capture window.
        const requester = yield* Effect.forkChild(
          Effect.sleep("1500 millis").pipe(
            Effect.andThen(HttpClient.get(`${fn.url}/logs-probe`)),
            Effect.ignore,
          ),
        );
        const lines = yield* provider.logs!({
          ...hookInput,
          options: { limit: 200 },
        });
        yield* Fiber.await(requester);
        return lines.some((line) => line.message.includes(MARKER));
      }).pipe(
        Effect.repeat({
          until: (found) => found,
          times: 2,
        }),
      );
      expect(sawLogsLine).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 150_000 },
);
