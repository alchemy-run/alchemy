import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import {
  assertAppGone,
  assertCommitted,
  census,
  deployWorker,
} from "./fixtures/bluegreen.ts";
import { engineActor } from "./fixtures/actors.ts";
import { transportProxy, type TransportEvent } from "./fixtures/transport.ts";

const file = "test/Fly/BlueGreenInterruption.test.ts";
const { test } = Test.make({ providers: Fly.providers() });

describe.sequential("in-process engine interruption", () => {
  for (const phase of ["create", "promotion", "retirement"] as const) {
    const title = `${phase === "create" ? "F07" : phase === "promotion" ? "F08" : "F09"} F10 fiber interruption at a completed ${phase} response barrier`;
    test.provider(
      title,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const initial = yield* deployWorker(stack, "one");
          const proxy = yield* transportProxy();
          const match = (event: TransportEvent) =>
            phase === "create"
              ? event.method === "POST" && event.path.endsWith("/machines")
              : phase === "promotion"
                ? event.path.endsWith("/uncordon")
                : event.method === "DELETE" &&
                  /\/machines\/[^/]+$/.test(event.path) &&
                  event.machineId === initial.machineId;
          yield* Effect.sync(() =>
            proxy.arm({ match, action: "hold-response", remaining: 1 }),
          );
          yield* Effect.gen(function* () {
            const actor = yield* engineActor(stack, title, file, proxy.url);
            const interrupted = yield* deployWorker(actor, "two").pipe(
              Effect.scoped,
              Effect.forkScoped,
            );
            const barrier = yield* proxy.wait(
              (event) =>
                event.stage === "held" &&
                event.status! >= 200 &&
                event.status! < 300 &&
                match(event),
            );
            expect(barrier.machineId).toBeDefined();
            const interruption = yield* Fiber.interrupt(interrupted).pipe(
              Effect.forkScoped,
            );
            yield* Effect.yieldNow;
            // Let accepted uninterruptible work and finalizers settle; this is not process-kill evidence.
            yield* Effect.sync(() => {
              proxy.clear();
              proxy.release();
            });
            yield* Fiber.join(interruption).pipe(Effect.timeout("90 seconds"));
            const exit = yield* Fiber.await(interrupted);
            expect(Exit.hasInterrupts(exit)).toBe(true);
            const surviving = yield* census(initial.appName);
            const green = surviving.filter(
              (machine) => machine.id !== initial.machineId,
            );
            if (phase === "create") {
              expect(
                surviving.some((machine) => machine.id === initial.machineId),
              ).toBe(true);
              expect(green.length).toBeLessThanOrEqual(1);
            } else {
              expect(green).toHaveLength(1);
              expect(green[0]!.cordoned).toBe(false);
            }
            const resumed = yield* engineActor(stack, title, file);
            expect(resumed.state).not.toBe(actor.state);
            const recovered = yield* deployWorker(resumed, "two").pipe(
              Effect.scoped,
            );
            if (green.length)
              expect(recovered.machineIds).toEqual(
                green.map((machine) => machine.id),
              );
            yield* assertCommitted(initial.appName, recovered.machineIds);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                proxy.clear();
                proxy.release();
              }),
            ),
            Effect.scoped,
          );
          yield* stack.destroy();
          yield* assertAppGone(initial.appName);
        }).pipe(Effect.scoped),
      { timeout: 300_000 },
    );
  }
});
