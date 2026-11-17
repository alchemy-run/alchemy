import * as AI from "@alchemy.run/ai";
import * as Archil from "@alchemy.run/archil";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { sandboxName } from "./name.ts";

/**
 * One Archil sandbox per conversation. `create` returns the sandbox that
 * already has the name, and Archil pauses it while it is idle.
 */
export const ArchilSandbox = Layer.effect(
  AI.Sandbox,
  Effect.gen(function* () {
    const base = yield* Archil.Image("ArchilBase", { image: "node:22-bookworm" });
    const sandboxes = yield* Archil.CreateSandbox(base);

    return {
      open: (target) => sandboxes.create({ name: sandboxName(target) }),
      remove: (key) => sandboxes.delete(sandboxName(key)),
    };
  }),
).pipe(Layer.provide(Archil.CreateSandboxHttp));
