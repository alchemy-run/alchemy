import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { createHash } from "node:crypto";
import {
  assertOrder,
  assertReplacement,
  assertStopped,
  makeScenario,
  requireValue,
} from "./fixtures/bluegreen-worker-test.ts";

const { test } = Test.make({ providers: Fly.providers() });

describe.sequential("Fly live HTTP and worker drain", () => {
  for (const policy of [
    {
      name: "managed old60/new10 SIGTERM",
      raw: false,
      old: "60 seconds",
      next: "10 seconds",
      signal: "SIGTERM",
      nextSignal: "SIGINT",
      rawSignal: undefined,
      nextRawSignal: undefined,
      delay: 12_000,
    },
    {
      name: "managed old10/new60 SIGINT",
      raw: false,
      old: "10 seconds",
      next: "60 seconds",
      signal: "SIGINT",
      nextSignal: "SIGTERM",
      rawSignal: undefined,
      nextRawSignal: undefined,
      delay: 3_000,
    },
    {
      name: "raw old60/new10 SIGQUIT to SIGTERM",
      raw: true,
      old: "60 seconds",
      next: "10 seconds",
      signal: "SIGTERM",
      nextSignal: "SIGTERM",
      rawSignal: "SIGQUIT",
      nextRawSignal: "SIGTERM",
      delay: 12_000,
    },
    {
      name: "raw old10/new60 SIGTERM to SIGQUIT",
      raw: true,
      old: "10 seconds",
      next: "60 seconds",
      signal: "SIGTERM",
      nextSignal: "SIGTERM",
      rawSignal: "SIGTERM",
      nextRawSignal: "SIGQUIT",
      delay: 3_000,
    },
  ] as const) {
    test.provider(
      `R01/R02/R03/R04 ${policy.name} preserves traffic, jobs and streaming after the actual stop barrier`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const scenario = yield* makeScenario(stack);
          yield* Effect.gen(function* () {
            const first = yield* scenario.deploy({
              raw: policy.raw,
              version: "one",
              timeout: policy.old,
              signal: policy.signal,
              rawSignal: policy.rawSignal,
              afterSignalMs: policy.delay,
            });
            const oldWorker = yield* requireValue(
              first.worker,
              "initial worker output",
            );
            const oldId = oldWorker.machineId;
            const url = `https://${first.workerApp.appName}.fly.dev`;
            const get = (route: string) =>
              HttpClient.get(`${url}${route}`, {
                headers: { connection: "close" },
              }).pipe(
                Effect.flatMap((response) =>
                  response.status === 200
                    ? response.text
                    : Effect.fail(new Error(`HTTP ${response.status}`)),
                ),
                Effect.timeout(route === "/" ? "5 seconds" : "240 seconds"),
              );
            expect(
              JSON.parse(
                yield* get("/").pipe(
                  Effect.retry({
                    times: 8,
                    schedule: Schedule.spaced("1 second"),
                  }),
                ),
              ),
            ).toEqual({ machine: oldId, version: "one" });
            const observed = yield* machines.getMachine({
              app_name: first.workerApp.appName,
              machine_id: oldId,
            });
            expect(observed.config?.stop_config?.signal).toBe(
              policy.rawSignal ?? policy.signal,
            );
            expect(
              policy.old === "60 seconds"
                ? ["60000ms", "60s", "1m", "1m0s"]
                : ["10000ms", "10s"],
            ).toContain(observed.config?.stop_config?.timeout);
            yield* scenario.call(first.ledgerUrl, "enqueue", [
              "in-flight-job",
              "hold",
            ]);
            yield* scenario.wait(first.ledgerUrl, (ledger) =>
              ledger.events.some(
                (event) =>
                  event.machine === oldId &&
                  event.event === "claimed" &&
                  event.job === "in-flight-job",
              ),
            );
            const slow = yield* get("/hold").pipe(Effect.forkScoped);
            const streamed = yield* get("/stream").pipe(Effect.forkScoped);
            yield* scenario.wait(
              first.ledgerUrl,
              (ledger) =>
                ledger.events.filter(
                  (event) =>
                    event.machine === oldId &&
                    event.event === "request-started",
                ).length === 2,
            );
            const responses = yield* Ref.make<
              Array<{ machine: string; version: string } | { failure: string }>
            >([]);
            const finished = yield* Ref.make(false);
            yield* Effect.addFinalizer(() =>
              Ref.get(responses).pipe(
                Effect.flatMap((samples) =>
                  Effect.logInfo("Unretried public traffic samples", samples),
                ),
              ),
            );
            const traffic = yield* Stream.range(0, 599).pipe(
              Stream.mapEffect(() =>
                get("/").pipe(
                  Effect.result,
                  Effect.flatMap((result) =>
                    Ref.update(responses, (values) => [
                      ...values,
                      Result.isSuccess(result)
                        ? (JSON.parse(result.success) as {
                            machine: string;
                            version: string;
                          })
                        : { failure: String(result.failure) },
                    ]),
                  ),
                  Effect.andThen(Effect.sleep("500 millis")),
                  Effect.andThen(Ref.get(finished)),
                ),
              ),
              Stream.takeUntil((done) => done),
              Stream.runDrain,
              Effect.forkScoped,
            );
            const second = yield* scenario.deploy({
              raw: policy.raw,
              version: "two",
              timeout: policy.next,
              signal: policy.nextSignal,
              rawSignal: policy.nextRawSignal,
              afterSignalMs: 1000,
            });
            const newWorker = yield* requireValue(
              second.worker,
              "replacement worker output",
            );
            expect(JSON.parse(yield* Fiber.join(slow))).toEqual({
              machine: oldId,
              version: "one",
            });
            const body = yield* Fiber.join(streamed);
            const expected = "first\n".repeat(32768) + "last\n".repeat(32768);
            const hashes = yield* Effect.sync(() =>
              [body, expected].map((value) =>
                createHash("sha256").update(value).digest("hex"),
              ),
            );
            expect(body.length).toBe(360448);
            expect(hashes[0]).toBe(hashes[1]);
            expect(JSON.parse(yield* get("/"))).toEqual({
              machine: newWorker.machineId,
              version: "two",
            });
            yield* Effect.sleep("600 millis");
            yield* Ref.set(finished, true);
            yield* Fiber.join(traffic);
            const samples = yield* Ref.get(responses);
            expect(samples.filter((sample) => "failure" in sample)).toEqual([]);
            expect(
              samples.some(
                (sample) =>
                  "version" in sample &&
                  sample.version === "one" &&
                  sample.machine === oldId,
              ),
            ).toBe(true);
            expect(
              samples.some(
                (sample) =>
                  "version" in sample &&
                  sample.version === "two" &&
                  sample.machine === newWorker.machineId,
              ),
            ).toBe(true);
            yield* assertReplacement(
              first.workerApp.appName,
              oldId,
              newWorker.machineId,
            );
            const ledger = yield* scenario.settle(first.ledgerUrl);
            assertStopped(ledger.events, oldId);
            assertOrder(
              ledger.events,
              oldId,
              "request-finalized",
              "shared-closed",
            );
            assertOrder(
              ledger.events,
              oldId,
              "client-released",
              "shared-closed",
            );
            const stop = yield* requireValue(
              ledger.events.find(
                (event) =>
                  event.machine === oldId && event.event === "stop-started",
              ),
              "old worker stop event",
            );
            if (policy.raw) expect(stop.signal).toBe(policy.rawSignal);
            const completed = ledger.events.filter(
              (event) =>
                event.machine === oldId && event.event === "response-finished",
            );
            expect(completed).toHaveLength(2);
            for (const event of completed) {
              expect(event.at - stop.at).toBeGreaterThan(policy.delay - 500);
            }
            const ack = yield* requireValue(
              ledger.events.find(
                (event) =>
                  event.machine === oldId &&
                  event.event === "acked" &&
                  event.job === "in-flight-job",
              ),
              "in-flight job ACK event",
            );
            expect(ack.ack).toBe(1);
            expect(ack.at - stop.at).toBeGreaterThan(policy.delay - 500);
            if (policy.old === "10 seconds")
              expect(ack.at - stop.at).toBeLessThan(10_000);
          }).pipe(Effect.scoped, Effect.ensuring(scenario.cleanup));
        }),
      {
        // Includes cold publication, both readiness phases, proxy overlap, post-signal work and census.
        timeout: 480_000,
      },
    );
  }
});
