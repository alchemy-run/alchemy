import * as AI from "@alchemy.run/ai";
import * as Archil from "@alchemy.run/archil";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Archil finds a sandbox by its name: `create` returns the one that already
 * has it. `suspend` pauses a running sandbox, keeping its memory and files;
 * Archil also pauses one that is idle, and resumes it on the next command.
 */
export const ArchilSandbox = Layer.effect(
  AI.Sandbox,
  Effect.gen(function* () {
    const base = yield* Archil.Image("ArchilBase", { image: "node:22-bookworm" });
    const sandboxes = yield* Archil.CreateSandbox(base);

    return {
      open: (key) => sandboxes.create({ name: key }),
      suspend: Effect.fn(function* (key) {
        const sandbox = yield* sandboxes.get(key);
        if (sandbox === undefined) return;
        const { status } = yield* sandbox.refresh();
        if (status === "running") yield* sandbox.pause();
      }),
      remove: (key) => sandboxes.delete(key),
    };
  }),
).pipe(Layer.provide(Archil.CreateSandboxHttp));
