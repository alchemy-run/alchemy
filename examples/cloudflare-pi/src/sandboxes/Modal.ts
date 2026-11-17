import * as Modal from "@alchemy.run/modal";
import * as Pi from "@alchemy.run/pi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { sandboxName } from "./name.ts";

/**
 * One Modal sandbox per conversation, found by its name. Modal ends it
 * after ten idle minutes.
 */
export const ModalSandbox = Layer.effect(
  Pi.Sandbox,
  Effect.gen(function* () {
    const app = yield* Modal.App("ModalApp", {});
    const base = yield* Modal.Image("ModalBase", { app, image: "node:22-bookworm" });
    const sandboxes = yield* Modal.CreateSandbox(base);

    return {
      open: Effect.fn(function* (target) {
        const name = sandboxName(target);
        return (
          (yield* sandboxes.fromName(name)) ??
          (yield* sandboxes.create({ name, idleTimeout: "10 minutes" }))
        );
      }),
      remove: Effect.fn(function* (key) {
        const sandbox = yield* sandboxes.fromName(sandboxName(key));
        if (sandbox !== undefined) yield* sandbox.terminate();
      }),
    };
  }),
).pipe(Layer.provide(Modal.CreateSandboxHttp));
