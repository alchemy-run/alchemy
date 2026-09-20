import * as machines from "@distilled.cloud/fly-io/machines";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import type { MachineProps } from "@/Fly/Machine";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import {
  assertAppGone,
  assertCommitted,
  census,
  deployWorker,
} from "./fixtures/bluegreen.ts";
import {
  throughProxy,
  transportProxy,
  type TransportEvent,
} from "./fixtures/transport.ts";

let endpoint: string | undefined;
const { test } = Test.make({ providers: throughProxy(() => endpoint) });

describe.sequential("retirement faults", () => {
  test.provider(
    "F04 a real second remover accepts terminal success or typed NotFound and destroy stays idempotent",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const initial = yield* deployWorker(stack, "one");
        const target = {
          app_name: initial.appName,
          machine_id: initial.machineId,
          force: true,
        };
        yield* machines.deleteMachine(target).pipe(Retry.none);
        const removedAgain = yield* machines
          .deleteMachine(target)
          .pipe(Retry.none, Effect.result);
        if (Result.isFailure(removedAgain))
          expect(removedAgain.failure._tag).toBe("NotFound");
        const absent = yield* machines
          .getMachine({
            app_name: target.app_name,
            machine_id: target.machine_id,
          })
          .pipe(
            Retry.none,
            Effect.map(
              (machine) =>
                machine.id === target.machine_id &&
                machine.state === "destroyed",
            ),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
            Effect.repeat({
              times: 8,
              schedule: Schedule.spaced("2 seconds"),
              until: (gone) => gone,
            }),
            Effect.timeout("30 seconds"),
          );
        expect(absent).toBe(true);
        yield* Effect.logInfo("Observed real second-remover outcome", {
          appName: initial.appName,
          machineId: initial.machineId,
          outcome: Result.isSuccess(removedAgain)
            ? "accepted"
            : removedAgain.failure._tag,
          absenceConfirmed: absent,
        });
        expect(yield* census(initial.appName)).toHaveLength(0);
        yield* stack.destroy();
        yield* assertAppGone(initial.appName);
        yield* stack.destroy();
      }),
    { timeout: 180_000 },
  );
  test.provider(
    "FLY-REVIEW-2 lost successful DELETE does not cancel a sibling draining across renewal",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const props = {
          count: 2,
          shutdown: { signal: "SIGTERM", timeout: "90 seconds" },
          init: {
            exec: [
              "/bin/sh",
              "-c",
              "trap 'if [ -f /slow-drain ]; then sleep 60; fi; exit 0' TERM; nginx -g 'daemon off;' & while :; do sleep 1 & wait $!; done",
            ],
          },
        } satisfies Partial<Omit<MachineProps, "app">>;
        const initial = yield* deployWorker(stack, "one", props);
        const [fastId, slowId] = [...initial.machineIds].sort();
        expect(initial.machineIds).toHaveLength(2);
        const configured = yield* machines.execMachine({
          app_name: initial.appName,
          machine_id: slowId!,
          command: ["touch", "/slow-drain"],
          timeout: 5,
        });
        expect(configured.exit_code).toBe(0);
        const proxy = yield* transportProxy();
        const isFastDelete = (event: TransportEvent) =>
          event.machineId === fastId &&
          event.method === "DELETE" &&
          event.path.endsWith(`/machines/${fastId}`);
        yield* Effect.sync(() => {
          endpoint = proxy.url;
          proxy.arm({
            match: isFastDelete,
            action: "drop-response",
            remaining: 1,
          });
          proxy.arm({
            match: isFastDelete,
            action: "cut-request",
            remaining: Infinity,
          });
        });
        const update = yield* deployWorker(stack, "two", props).pipe(
          Effect.result,
          Effect.forkScoped,
        );
        const dropped = yield* proxy.wait(
          (event) =>
            isFastDelete(event) &&
            event.stage === "dropped" &&
            event.status! >= 200 &&
            event.status! < 300,
        );
        const deletedAt = yield* Clock.currentTimeMillis;
        // The real old process remains in its shutdown trap across the 25-second renewal tick.
        yield* Effect.sleep("30 seconds");
        const draining = yield* machines.getMachine({
          app_name: initial.appName,
          machine_id: slowId!,
        });
        expect(draining.state).not.toBe("destroyed");
        expect(
          (yield* Clock.currentTimeMillis) - deletedAt,
        ).toBeGreaterThanOrEqual(30_000);
        expect(
          proxy.events.some(
            (event) =>
              event.sequence > dropped.sequence &&
              event.stage === "completed" &&
              event.method === "POST" &&
              event.machineId === slowId &&
              event.path.endsWith("/lease") &&
              event.status! >= 200 &&
              event.status! < 300,
          ),
        ).toBe(true);
        const result = yield* Fiber.join(update).pipe(
          Effect.timeout("240 seconds"),
        );
        expect(Result.isSuccess(result)).toBe(true);
        if (Result.isSuccess(result))
          yield* assertCommitted(initial.appName, result.success.machineIds);
        const live = yield* census(initial.appName);
        expect(live).toHaveLength(2);
        expect(
          live.every((machine) => !initial.machineIds.includes(machine.id!)),
        ).toBe(true);
        expect(
          proxy.events.some(
            (event) =>
              event.stage === "completed" &&
              event.method === "GET" &&
              event.path.endsWith(`/machines/${fastId}`) &&
              event.sequence > dropped.sequence &&
              (event.status === 404 || event.state === "destroyed"),
          ),
        ).toBe(true);
        yield* Effect.logInfo("Exact-target retirement transport evidence", {
          machineId: fastId,
          events: proxy.events.filter(
            (event) =>
              isFastDelete(event) ||
              (event.method === "GET" &&
                event.path.endsWith(`/machines/${fastId}`)),
          ),
        });
        expect(
          proxy.events.some(
            (event) =>
              isFastDelete(event) &&
              event.stage === "request" &&
              event.sequence > dropped.sequence,
          ),
        ).toBe(false);
        expect(
          proxy.events.some(
            (event) =>
              event.stage === "completed" &&
              event.machineId === slowId &&
              event.method === "DELETE" &&
              event.path.endsWith(`/machines/${slowId}`) &&
              event.status! >= 200 &&
              event.status! < 300,
          ),
        ).toBe(true);
        yield* Effect.sync(() => {
          proxy.clear();
          endpoint = undefined;
        });
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
    { timeout: 600_000 },
  );

  for (const operation of ["cordon", "stop", "delete"] as const) {
    test.provider(
      `F04 completed ${operation} response loss preserves green and recovers residuals`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const initial = yield* deployWorker(stack, "one");
          const proxy = yield* transportProxy();
          const match = (event: TransportEvent) =>
            event.machineId === initial.machineId &&
            (operation === "delete"
              ? event.method === "DELETE" &&
                event.path.endsWith(initial.machineId)
              : event.path.endsWith(`/${operation}`));
          yield* Effect.sync(() => {
            endpoint = proxy.url;
            proxy.arm({ match, action: "drop-response", remaining: 1 });
            proxy.arm({ match, action: "cut-request", remaining: Infinity });
          });
          const result = yield* deployWorker(stack, "two").pipe(
            Effect.timeout("120 seconds"),
            Effect.result,
          );
          expect(
            proxy.events.some(
              (event) => event.stage === "dropped" && event.status! < 300,
            ),
          ).toBe(true);
          const live = yield* census(initial.appName);
          const green = live.filter(
            (machine) => machine.id !== initial.machineId,
          );
          expect(green).toHaveLength(1);
          expect(green[0]!.cordoned).toBe(false);
          expect(green[0]!.config?.metadata?.["alchemy.phase"]).toBe("active");
          if (live.some((machine) => machine.id === initial.machineId))
            expect(Result.isFailure(result)).toBe(true);
          yield* Effect.sync(proxy.clear);
          const recovered = yield* deployWorker(stack, "two");
          expect(recovered.machineIds).toEqual(
            green.map((machine) => machine.id),
          );
          yield* assertCommitted(initial.appName, recovered.machineIds);
          yield* Effect.sync(() => {
            endpoint = undefined;
          });
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
      { timeout: 300_000 },
    );
  }

  for (const phase of ["retiring", "active"] as const) {
    test.provider(
      `F05 ${phase === "retiring" ? "advisory old" : "required commit"} metadata connection failure`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const initial = yield* deployWorker(stack, "one");
          const proxy = yield* transportProxy();
          yield* Effect.sync(() => {
            endpoint = proxy.url;
            proxy.arm({
              match: (event) =>
                event.path.endsWith("/metadata") && event.phase === phase,
              action: "cut-request",
              remaining: Infinity,
            });
          });
          const result = yield* deployWorker(stack, "two").pipe(
            Effect.timeout("120 seconds"),
            Effect.result,
          );
          expect(
            proxy.events.some(
              (event) => event.stage === "cut" && event.phase === phase,
            ),
          ).toBe(true);
          const live = yield* census(initial.appName);
          const green = live.filter(
            (machine) => machine.id !== initial.machineId,
          );
          expect(green).toHaveLength(1);
          expect(green[0]!.cordoned).toBe(false);
          if (phase === "retiring") {
            expect(Result.isSuccess(result)).toBe(true);
            expect(
              live.some((machine) => machine.id === initial.machineId),
            ).toBe(false);
          } else {
            expect(Result.isFailure(result)).toBe(true);
            expect(
              live.find((machine) => machine.id === initial.machineId)
                ?.cordoned,
            ).toBe(false);
            expect(
              proxy.events.some(
                (event) =>
                  event.machineId === initial.machineId &&
                  ["POST", "DELETE"].includes(event.method) &&
                  !event.path.endsWith("/lease"),
              ),
            ).toBe(false);
          }
          yield* Effect.sync(proxy.clear);
          const recovered = yield* deployWorker(stack, "two");
          expect(recovered.machineIds).toEqual(
            green.map((machine) => machine.id),
          );
          yield* assertCommitted(initial.appName, recovered.machineIds);
          yield* Effect.sync(() => {
            endpoint = undefined;
          });
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
      { timeout: 300_000 },
    );
  }
});
