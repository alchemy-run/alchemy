import * as AIModal from "@alchemy.run/ai/Modal";
import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";

/**
 * Modal finds a sandbox by its name. It has no pause, so `suspend` does
 * nothing: Modal ends a sandbox idle for ten minutes, and the next `open`
 * creates an empty one.
 */
export const ModalSandbox = AIModal.Sandboxes(
  Effect.gen(function* () {
    const app = yield* Modal.App("ModalApp", {});
    return yield* Modal.Image("ModalBase", { app, image: "node:22-bookworm" });
  }),
);
