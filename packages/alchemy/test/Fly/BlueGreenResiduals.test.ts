import { ReplicaRetirementIncomplete } from "@/Fly/replicas";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  assertAppGone,
  assertCommitted,
  census,
  deployWorker,
} from "./fixtures/bluegreen.ts";
import { throughProxy, transportProxy } from "./fixtures/transport.ts";

let endpoint: string | undefined;
const { test } = Test.make({ providers: throughProxy(() => endpoint) });
const props = {
  count: 2,
  deploy: { strategy: "bluegreen", healthTimeout: "90 seconds" },
} as const;

describe.sequential("real retirement residual diagnostics", () => {
  for (const operation of ["cordon", "stop", "delete"] as const) {
    test.provider(
      `F04 real ${operation} transport fault reports exact target/stage while sibling retirement completes`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const initial = yield* deployWorker(stack, "one", props);
          const [targetId, siblingId] = [...initial.machineIds].sort();
          expect(initial.machineIds).toHaveLength(2);
          const proxy = yield* transportProxy();
          try {
            yield* Effect.sync(() => {
              endpoint = proxy.url;
              proxy.arm({
                match: (event) =>
                  event.machineId === targetId &&
                  (operation === "delete"
                    ? event.method === "DELETE" &&
                      event.path.endsWith(`/machines/${targetId}`)
                    : event.method === "POST" &&
                      event.path.endsWith(`/${operation}`)),
                action: "cut-request",
                remaining: Infinity,
              });
            });
            const result = yield* deployWorker(stack, "two", props).pipe(
              Effect.result,
            );
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure).toBeInstanceOf(
                ReplicaRetirementIncomplete,
              );
              if (result.failure instanceof ReplicaRetirementIncomplete) {
                expect(result.failure.appName).toBe(initial.appName);
                expect(result.failure.residuals).toEqual([
                  {
                    machineId: targetId,
                    stage: `${operation}: Fly.MachineMutationUncertain`,
                  },
                ]);
              }
            }
            const cuts = proxy.events.filter((event) => event.stage === "cut");
            expect(cuts.length).toBeGreaterThan(0);
            expect([...new Set(cuts.map((event) => event.machineId))]).toEqual([
              targetId,
            ]);
            const live = yield* census(initial.appName);
            const old = live.filter((machine) =>
              initial.machineIds.includes(machine.id!),
            );
            const green = live.filter(
              (machine) => !initial.machineIds.includes(machine.id!),
            );
            expect(old.map((machine) => machine.id)).toEqual([targetId]);
            expect(live.some((machine) => machine.id === siblingId)).toBe(
              false,
            );
            expect(old[0]!.cordoned).toBe(operation !== "cordon");
            expect(old[0]!.state).toBe(
              operation === "delete" ? "stopped" : "started",
            );
            expect(green).toHaveLength(2);
            expect(
              green.every(
                (machine) =>
                  machine.cordoned === false &&
                  machine.config?.metadata?.["alchemy.phase"] === "active",
              ),
            ).toBe(true);
            expect(
              proxy.events.some(
                (event) =>
                  event.stage === "completed" &&
                  event.machineId === siblingId &&
                  event.method === "DELETE" &&
                  event.path.endsWith(`/machines/${siblingId}`) &&
                  event.status! >= 200 &&
                  event.status! < 300,
              ),
            ).toBe(true);
            const greenIds = green.map((machine) => machine.id!).sort();
            expect(live.map((machine) => machine.id).sort()).toEqual(
              [...greenIds, targetId].sort(),
            );
            yield* Effect.sync(proxy.clear);
            const recovered = yield* deployWorker(stack, "two", props);
            expect([...recovered.machineIds].sort()).toEqual(greenIds);
            yield* assertCommitted(initial.appName, recovered.machineIds);
            expect(
              (yield* census(initial.appName)).some((machine) =>
                initial.machineIds.includes(machine.id!),
              ),
            ).toBe(false);
          } finally {
            yield* Effect.sync(() => {
              endpoint = undefined;
              proxy.clear();
            });
          }
          yield* stack.destroy();
          yield* assertAppGone(initial.appName);
        }).pipe(
          Effect.scoped,
          Effect.ensuring(
            Effect.sync(() => {
              endpoint = undefined;
            }),
          ),
        ),
      { timeout: 900_000 },
    );
  }
});
