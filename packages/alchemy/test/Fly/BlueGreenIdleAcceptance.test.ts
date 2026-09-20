import * as machines from "@distilled.cloud/fly-io/machines";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  assertAppGone,
  census,
  checks,
  deployWorker,
} from "./fixtures/bluegreen.ts";
import { throughProxy, transportProxy } from "./fixtures/transport.ts";

let endpoint: string | undefined;
const { test } = Test.make({ providers: throughProxy(() => endpoint) });

describe.sequential("idle topology", () => {
  for (const mode of ["stop", "suspend"] as const) {
    for (const allIdle of [false, true]) {
      test.provider(
        `S05 S11 ${mode} ${allIdle ? "all-idle" : "mixed"} replacement keeps an idle nonrepresentative`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const props = {
              count: 2,
              services: [
                {
                  protocol: "tcp",
                  internalPort: 80,
                  autostop: mode,
                  autostart: true,
                  minMachinesRunning: 0,
                  ports: [{ port: 80, handlers: ["http"] }],
                  checks: [checks.ready],
                },
              ],
            };
            const initial = yield* deployWorker(stack, "one", {
              ...props,
              deploy: { strategy: "rolling" },
            });
            for (const id of allIdle
              ? initial.machineIds
              : initial.machineIds.slice(1)) {
              const target = { app_name: initial.appName, machine_id: id };
              yield* mode === "stop"
                ? machines.stopMachine({
                    ...target,
                    signal: "SIGQUIT",
                    timeout: "5s",
                  })
                : machines.suspendMachine(target);
              const observed = yield* machines.getMachine(target).pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("2 seconds"),
                  times: 8,
                  until: (machine) =>
                    machine.state ===
                    (mode === "stop" ? "stopped" : "suspended"),
                }),
              );
              expect(observed.state).toBe(
                mode === "stop" ? "stopped" : "suspended",
              );
            }
            const proxy = yield* transportProxy();
            yield* Effect.sync(() => {
              endpoint = proxy.url;
            });
            const next = yield* deployWorker(stack, "two", props);
            expect(next.machineIds).toHaveLength(2);
            const live = yield* census(initial.appName);
            expect(live.map((machine) => machine.id).sort()).toEqual(
              [...next.machineIds].sort(),
            );
            expect(
              live.every((machine) => {
                const autostop = machine.config?.services?.[0]?.autostop;
                return (autostop === true ? "stop" : autostop) === mode;
              }),
            ).toBe(true);
            expect(
              live.filter((machine) => machine.state === "started").length,
            ).toBeLessThanOrEqual(1);
            expect(
              live.some((machine) =>
                ["stopped", "suspended"].includes(machine.state!),
              ),
            ).toBe(true);
            expect(
              proxy.events.some(
                (event) =>
                  initial.machineIds.includes(event.machineId!) &&
                  event.path.endsWith("/start"),
              ),
            ).toBe(false);
            const same = yield* deployWorker(stack, "two", props);
            expect(same.machineIds).toEqual(next.machineIds);
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
  }
});
