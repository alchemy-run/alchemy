import * as AI from "@alchemy.run/ai";
import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Modal finds a sandbox by its name. It has no pause, so `suspend` does
 * nothing: Modal ends a sandbox idle for ten minutes, and the next `open`
 * creates an empty one.
 */
export const ModalSandbox = Layer.effect(
  AI.Sandboxes,
  Effect.gen(function* () {
    const app = yield* Modal.App("ModalApp", {});
    const base = yield* Modal.Image("ModalBase", { app, image: "node:22-bookworm" });
    const sandboxes = yield* Modal.CreateSandbox(base);

    return {
      open: Effect.fn(function* (key) {
        return (
          (yield* sandboxes.fromName(key)) ??
          (yield* sandboxes.create({ name: key, idleTimeout: "10 minutes" }))
        );
      }),
      suspend: () => Effect.void,
      remove: Effect.fn(function* (key) {
        const sandbox = yield* sandboxes.fromName(key);
        if (sandbox !== undefined) yield* sandbox.terminate();
      }),
    };
  }),
).pipe(Layer.provide(Modal.CreateSandboxHttp));
