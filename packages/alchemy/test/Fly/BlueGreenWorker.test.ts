import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  assertOrder,
  assertReplacement,
  assertStopped,
  makeScenario,
  requireValue,
} from "./fixtures/bluegreen-worker-test.ts";

const { test } = Test.make({ providers: Fly.providers() });

// Cold gateway/worker publication, readiness, replacement and census can exceed three minutes.
const timeout = 480_000;

describe.sequential("Fly durable worker acceptance", () => {
  for (const mode of ["stop-delay", "stop-fail", "stop-hang"]) {
    test.provider(
      `R05 live ${mode} preserves another worker and bounds managed shutdown`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const scenario = yield* makeScenario(stack);
          yield* Effect.gen(function* () {
            const first = yield* scenario.deploy({
              version: "one",
              timeout: "10 seconds",
              signal: "SIGTERM",
              runOnly: true,
              mode,
              workers: 2,
            });
            const worker = yield* requireValue(first.worker, "worker output");
            const machineId = worker.machineId;
            const observe = <A, E, R>(
              phase: string,
              effect: Effect.Effect<A, E, R>,
            ) =>
              Effect.gen(function* () {
                const started = yield* Clock.currentTimeMillis;
                yield* Effect.logInfo("R05 phase started", {
                  mode,
                  machineId,
                  phase,
                });
                return yield* effect.pipe(
                  Effect.onExit((exit) =>
                    Clock.currentTimeMillis.pipe(
                      Effect.flatMap((finished) =>
                        Effect.logInfo("R05 phase finished", {
                          mode,
                          machineId,
                          phase,
                          success: Exit.isSuccess(exit),
                          elapsedMs: finished - started,
                        }),
                      ),
                    ),
                  ),
                );
              });
            yield* observe(
              "both-workers-ready-ledger",
              scenario.wait(
                first.ledgerUrl,
                (ledger) =>
                  ledger.events.filter(
                    (event) =>
                      event.machine === machineId &&
                      event.event === "worker-ready",
                  ).length === 2,
              ),
            );
            yield* observe(
              "stop-machine-request",
              machines.stopMachine({
                app_name: first.workerApp.appName,
                machine_id: machineId,
              }),
            );
            const stopped = yield* observe(
              "stopped-machine-observation",
              machines
                .getMachine({
                  app_name: first.workerApp.appName,
                  machine_id: machineId,
                })
                .pipe(
                  Effect.repeat({
                    until: (value) => value.state === "stopped",
                    times: 8,
                    schedule: Schedule.spaced("2 seconds"),
                  }),
                ),
            );
            expect(stopped.state).toBe("stopped");
            const ledger = yield* observe(
              "post-stop-ledger-snapshot",
              scenario.snapshot(first.ledgerUrl),
            );
            assertOrder(ledger.events, machineId, "stopped", "drained", "b");
            assertOrder(
              ledger.events,
              machineId,
              "drained",
              "client-released",
              "b",
            );
            const stopStarted = yield* requireValue(
              ledger.events.find(
                (event) =>
                  event.machine === machineId && event.event === "stop-started",
              ),
              "worker stop-started event",
            );
            const independentRelease = yield* requireValue(
              ledger.events.find(
                (event) =>
                  event.machine === machineId &&
                  event.worker === "b" &&
                  event.event === "client-released",
              ),
              "worker b client release event",
            );
            expect(
              independentRelease.at - stopStarted.at,
            ).toBeGreaterThanOrEqual(0);
            expect(independentRelease.at - stopStarted.at).toBeLessThan(10_000);
            const selected = ledger.events.filter(
              (event) => event.machine === machineId && event.worker === "a",
            );
            if (mode === "stop-delay") {
              const a = yield* requireValue(
                selected.find((event) => event.event === "stopped"),
                "worker a stopped event",
              );
              const b = yield* requireValue(
                ledger.events.find(
                  (event) =>
                    event.machine === machineId &&
                    event.worker === "b" &&
                    event.event === "stopped",
                ),
                "worker b stopped event",
              );
              expect(a.at - b.at).toBeGreaterThan(700);
              assertOrder(ledger.events, machineId, "stopped", "drained", "a");
              assertStopped(ledger.events, machineId);
            } else {
              expect(
                selected.some(
                  (event) =>
                    event.event === "stopped" || event.event === "drained",
                ),
              ).toBe(false);
              expect(
                selected.some(
                  (event) =>
                    event.event ===
                    (mode === "stop-fail" ? "stop-failed" : "stop-started"),
                ),
              ).toBe(true);
            }
            if (mode === "stop-hang") {
              expect(
                selected.some(
                  (event) =>
                    event.event === "work-closed" ||
                    event.event === "client-released",
                ),
              ).toBe(false);
            }
            expect(
              ledger.events.some(
                (event) =>
                  event.machine === machineId &&
                  event.event === "shared-closed",
              ),
            ).toBe(mode !== "stop-hang");
            const exit = stopped.events?.find((event) => event.type === "exit")
              ?.request as { exit_event?: { exit_code?: number } } | undefined;
            yield* Effect.logInfo("Observed managed worker exit", {
              mode,
              exitCode: exit?.exit_event?.exit_code,
            });
            expect(exit?.exit_event?.exit_code).toBe(
              mode === "stop-delay" ? 0 : 1,
            );
          }).pipe(Effect.ensuring(scenario.cleanup));
        }),
      { timeout },
    );
  }

  test.provider(
    "R07 authenticated durable Redis Streams gateway",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const scenario = yield* makeScenario(stack);
        yield* Effect.gen(function* () {
          const first = yield* scenario.deploy({
            version: "one",
            timeout: "30 seconds",
            signal: "SIGTERM",
            runOnly: true,
            gatewayOnly: true,
          });
          expect((yield* HttpClient.post(first.ledgerUrl)).status).toBe(401);
          const added = yield* scenario
            .call(first.ledgerUrl, "enqueue", ["durable-probe", "quick"])
            .pipe(
              Effect.retry({ times: 8, schedule: Schedule.spaced("1 second") }),
            );
          expect(typeof added).toBe("string");
          expect(
            yield* scenario.call(first.ledgerUrl, "enqueue", [
              "durable-probe",
              "quick",
            ]),
          ).toBe(0);
          const claimed = JSON.parse(
            String(
              yield* scenario.call(first.ledgerUrl, "claim", [
                "probe-client",
                "one",
              ]),
            ),
          ) as { id: string; job: string };
          expect(claimed.job).toBe("durable-probe");
          expect(
            yield* scenario.call(first.ledgerUrl, "finish", [
              claimed.id,
              claimed.job,
              "probe-client",
            ]),
          ).toBe(1);
          const ledger = yield* scenario.settle(first.ledgerUrl);
          expect(ledger.pending).toBe(0);
          expect(ledger.results).toContain("durable-probe");
        }).pipe(Effect.ensuring(scenario.cleanup));
      }),
    { timeout },
  );

  for (const raw of [false, true]) {
    test.provider(
      `R07 ${raw ? "raw" : "managed"} private worker checkpoints and reclaims through replacement with producer overlap`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const scenario = yield* makeScenario(stack);
          yield* Effect.gen(function* () {
            const options = {
              raw,
              runOnly: true,
              timeout: "30 seconds" as const,
              signal: "SIGTERM" as const,
              mode: "checkpoint",
            };
            const first = yield* scenario.deploy({
              ...options,
              version: "one",
            });
            const oldWorker = yield* requireValue(
              first.worker,
              "initial worker output",
            );
            const oldId = oldWorker.machineId;
            yield* scenario.call(first.ledgerUrl, "enqueue", [
              "checkpoint-job",
              "checkpoint",
            ]);
            yield* scenario.wait(first.ledgerUrl, (ledger) =>
              ledger.events.some(
                (event) =>
                  event.machine === oldId &&
                  event.event === "claimed" &&
                  event.job === "checkpoint-job",
              ),
            );
            const second = yield* scenario.deploy({
              ...options,
              version: "two",
              mode: "drain",
              signal: "SIGINT",
            });
            const newWorker = yield* requireValue(
              second.worker,
              "replacement worker output",
            );
            const newId = newWorker.machineId;
            yield* assertReplacement(first.workerApp.appName, oldId, newId);
            const ledger = yield* scenario.settle(first.ledgerUrl);
            expect(ledger.results).toContain("checkpoint-job");
            expect(ledger.checkpoints).toContain("saved-step-1");
            expect(
              ledger.events.some(
                (event) =>
                  event.event === "reclaimed" &&
                  event.machine === newId &&
                  event.job === "checkpoint-job",
              ),
            ).toBe(true);
            const ack = ledger.events.filter(
              (event) =>
                event.event === "acked" && event.job === "checkpoint-job",
            );
            expect(ack).toHaveLength(1);
            expect(ack[0]?.ack).toBe(1);
            expect(ack[0]?.fresh).toBe(1);
            assertStopped(ledger.events, oldId);
            assertOrder(ledger.events, oldId, "stopped", "checkpoint");
            assertOrder(ledger.events, oldId, "checkpoint", "client-released");
            assertOrder(
              ledger.events,
              oldId,
              "client-released",
              "shared-closed",
            );
            const oldSlots = new Set(
              ledger.events
                .filter(
                  (event) =>
                    event.machine === oldId && event.event === "producer",
                )
                .map((event) => event.job),
            );
            const overlaps = ledger.events.filter(
              (event) =>
                event.machine === newId &&
                event.event === "producer" &&
                oldSlots.has(event.job),
            );
            expect(overlaps.length).toBeGreaterThan(0);
            for (const event of overlaps) {
              expect(
                ledger.events.filter(
                  (row) =>
                    row.event === "producer" &&
                    row.job === event.job &&
                    row.fresh === 1,
                ),
              ).toHaveLength(1);
            }
          }).pipe(Effect.ensuring(scenario.cleanup));
        }),
      { timeout },
    );
  }
});
