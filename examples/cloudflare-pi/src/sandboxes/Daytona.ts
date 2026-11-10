import * as Daytona from "@alchemy.run/daytona";
import * as Pi from "@alchemy.run/pi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RemoveSandbox, sandboxName } from "./RemoveSandbox.ts";

/** The sandbox client, bound to the snapshot every conversation's sandbox boots from. */
const Sandboxes = Effect.gen(function* () {
  const base = yield* Daytona.Snapshot("DaytonaBase", {
    image: "node:22-bookworm",
    cpu: 1,
    memory: 1,
    disk: 3,
  });
  return yield* Daytona.CreateSandbox(base);
});

/**
 * One Daytona sandbox per conversation, found by its name. Daytona stops it
 * after fifteen idle minutes and deletes it once stopped.
 */
const SandboxLive = Layer.effect(
  Pi.Sandbox,
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes;
    return Effect.fn(function* (target) {
      const name = sandboxName(target);
      const existing = yield* sandboxes.get(name);
      if (existing === undefined) {
        return yield* sandboxes.create({ name, autoStopInterval: 15, autoDeleteInterval: 0 });
      }
      yield* existing.startSandbox();
      return existing;
    });
  }),
);

const RemoveLive = Layer.effect(
  RemoveSandbox,
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes;
    return (key) => sandboxes.delete(sandboxName(key));
  }),
);

export const DaytonaSandbox = Layer.mergeAll(SandboxLive, RemoveLive).pipe(
  Layer.provide(Daytona.CreateSandboxHttp),
);
