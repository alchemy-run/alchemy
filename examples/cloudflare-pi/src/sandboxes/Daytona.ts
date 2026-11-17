import * as AI from "@alchemy.run/ai";
import * as Daytona from "@alchemy.run/daytona";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Daytona finds a sandbox by its name and stops it on `suspend`, keeping
 * its disk. Daytona stops a sandbox idle for fifteen minutes and deletes
 * one that has been stopped for a day.
 */
export const DaytonaSandbox = Layer.effect(
  AI.Sandbox,
  Effect.gen(function* () {
    const base = yield* Daytona.Snapshot("DaytonaBase", {
      image: "node:22-bookworm",
      cpu: 1,
      memory: 1,
      disk: 3,
    });
    const sandboxes = yield* Daytona.CreateSandbox(base);

    return {
      open: Effect.fn(function* (key) {
        const existing = yield* sandboxes.get(key);
        if (existing === undefined) {
          return yield* sandboxes.create({
            name: key,
            autoStopInterval: 15,
            autoDeleteInterval: 24 * 60,
          });
        }
        yield* existing.startSandbox();
        return existing;
      }),
      suspend: Effect.fn(function* (key) {
        const existing = yield* sandboxes.get(key);
        if (existing === undefined) return;
        const { state } = yield* existing.getSandbox();
        if (state === "started") yield* existing.stopSandbox();
      }),
      remove: (key) => sandboxes.delete(key),
    };
  }),
).pipe(Layer.provide(Daytona.CreateSandboxHttp));
