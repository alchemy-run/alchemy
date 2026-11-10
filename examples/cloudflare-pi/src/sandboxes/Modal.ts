import * as Modal from "@alchemy.run/modal";
import * as Pi from "@alchemy.run/pi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RemoveSandbox, sandboxName } from "./RemoveSandbox.ts";

/** The sandbox client, bound to the image every conversation's sandbox boots from. */
const Sandboxes = Effect.gen(function* () {
  const app = yield* Modal.App("ModalApp", {});
  const base = yield* Modal.Image("ModalBase", { app, image: "node:22-bookworm" });
  return yield* Modal.CreateSandbox(base);
});

/**
 * One Modal sandbox per conversation, found by its name. Modal ends it
 * after ten idle minutes.
 */
const SandboxLive = Layer.effect(
  Pi.Sandbox,
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes;
    return Effect.fn(function* (target) {
      const name = sandboxName(target);
      return (
        (yield* sandboxes.fromName(name)) ??
        (yield* sandboxes.create({ name, idleTimeout: "10 minutes" }))
      );
    });
  }),
);

const RemoveLive = Layer.effect(
  RemoveSandbox,
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes;
    return Effect.fn(function* (key) {
      const sandbox = yield* sandboxes.fromName(sandboxName(key));
      if (sandbox !== undefined) yield* sandbox.terminate();
    });
  }),
);

export const ModalSandbox = Layer.mergeAll(SandboxLive, RemoveLive).pipe(
  Layer.provide(Modal.CreateSandboxHttp),
);
