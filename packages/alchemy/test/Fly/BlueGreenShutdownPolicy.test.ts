import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import { predecessorShutdown, retireMachine } from "@/Fly/replicas";
import * as Test from "@/Test/Alchemy";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Fly.providers() });

it.effect(
  "R02 predecessor policy preserves raw overrides and managed legacy grace",
  () =>
    Effect.gen(function* () {
      for (const timeout of ["10s", "60s"]) {
        for (const signal of ["SIGQUIT", "SIGTERM"] as const) {
          const policy = yield* predecessorShutdown({
            config: { stop_config: { signal, timeout } },
          });
          expect(policy.signal).toBe(signal);
          expect(policy.timeout).toBe(timeout);
        }
      }
      const raw = yield* predecessorShutdown({ config: {} });
      expect(raw.signal).toBeUndefined();
      expect(raw.timeout).toBeUndefined();
      const legacy = yield* predecessorShutdown({
        config: {
          stop_config: { signal: "SIGINT" },
          env: { ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: "60000" },
        },
      });
      expect(legacy).toEqual({
        signal: "SIGINT",
        timeout: "60000ms",
        timeoutMs: 60000,
      });
      for (const injected of ["broken", "0", "300001", "60000"]) {
        const error = yield* predecessorShutdown({
          config: {
            stop_config: { signal: "SIGTERM", timeout: "10s" },
            env: { ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: injected },
          },
        }).pipe(Effect.flip);
        expect(error._tag).toBe("Fly.ShutdownPolicyMismatch");
      }
    }),
);

test.provider(
  "R02 observed predecessor policy survives replacement and retires suspended without resume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const current = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          return yield* Fly.Machine("Worker", {
            app,
            image: "nginx:alpine",
            shutdown: { signal: "SIGQUIT", timeout: "60 seconds" },
          });
        }),
      );
      const request = {
        app_name: current.appName,
        machine_id: current.machineId,
      };
      const observed = yield* machines.getMachine(request);
      expect((yield* predecessorShutdown(observed)).timeoutMs).toBe(60_000);
      yield* machines.suspendMachine(request);
      yield* machines.waitMachine({
        ...request,
        state: "suspended",
        timeout: 8,
      });
      yield* retireMachine(current.appName, current.machineId);
      expect(
        yield* machines.getMachine(request).pipe(
          Effect.map((machine) => machine.state === "destroyed"),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
