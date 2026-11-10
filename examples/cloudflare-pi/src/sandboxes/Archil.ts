import * as Archil from "@alchemy.run/archil";
import * as Pi from "@alchemy.run/pi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RemoveSandbox, sandboxName } from "./RemoveSandbox.ts";

/** The sandbox client, bound to the image every conversation's sandbox boots from. */
const Sandboxes = Effect.gen(function* () {
  const base = yield* Archil.Image("ArchilBase", { image: "node:22-bookworm" });
  return yield* Archil.CreateSandbox(base);
});

/**
 * One Archil sandbox per conversation. `create` returns the sandbox that
 * already has the name, and Archil pauses it while it is idle.
 */
const SandboxLive = Layer.effect(
  Pi.Sandbox,
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes;
    return (target) => sandboxes.create({ name: sandboxName(target) });
  }),
);

const RemoveLive = Layer.effect(
  RemoveSandbox,
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes;
    return (key) => sandboxes.delete(sandboxName(key));
  }),
);

export const ArchilSandbox = Layer.mergeAll(SandboxLive, RemoveLive).pipe(
  Layer.provide(Archil.CreateSandboxHttp),
);
