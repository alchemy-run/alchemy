import * as Daytona from "@alchemy.run/daytona";
import * as Pi from "@alchemy.run/pi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { sandboxName } from "./name.ts";

/**
 * One Daytona sandbox per conversation, found by its name. Daytona stops it
 * after fifteen idle minutes and deletes it once stopped.
 */
export const DaytonaSandbox = Layer.effect(
  Pi.Sandbox,
  Effect.gen(function* () {
    const base = yield* Daytona.Snapshot("DaytonaBase", {
      image: "node:22-bookworm",
      cpu: 1,
      memory: 1,
      disk: 3,
    });
    const sandboxes = yield* Daytona.CreateSandbox(base);

    return {
      open: Effect.fn(function* (target) {
        const name = sandboxName(target);
        const existing = yield* sandboxes.get(name);
        if (existing === undefined) {
          return yield* sandboxes.create({ name, autoStopInterval: 15, autoDeleteInterval: 0 });
        }
        yield* existing.startSandbox();
        return existing;
      }),
      remove: (key) => sandboxes.delete(sandboxName(key)),
    };
  }),
).pipe(Layer.provide(Daytona.CreateSandboxHttp));
