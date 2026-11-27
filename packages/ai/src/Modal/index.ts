/**
 * `AI.Sandboxes` on Modal.
 *
 * @module
 */
import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Sandboxes as SandboxesService } from "../Sandbox.ts";

/** Options of {@link Sandboxes}. */
export interface SandboxesOptions {
  /**
   * How long a sandbox may be idle before Modal ends it.
   * @default "10 minutes"
   */
  readonly idleTimeout?: NonNullable<Parameters<Modal.SandboxesClient["create"]>[0]>["idleTimeout"];
}

/**
 * Run a harness's sandboxes on Modal, each started from `base`. A sandbox
 * is named by its key. Modal has no pause, so `suspend` does nothing: Modal
 * ends an idle sandbox, and the next `open` creates an empty one.
 *
 * **Example:** Sandboxes from an image
 * ```typescript
 * import * as AIModal from "@alchemy.run/ai/Modal";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 *
 * export const Sandbox = AIModal.Sandboxes(
 *   Effect.gen(function* () {
 *     const app = yield* Modal.App("App", {});
 *     return yield* Modal.Image("Base", { app, image: "node:22-bookworm" });
 *   }),
 * );
 * ```
 *
 * @layer
 * @provides AI.Sandboxes
 * @peer @alchemy.run/modal
 */
export const Sandboxes = <E, R>(
  base: Effect.Effect<Modal.Image, E, R>,
  options: SandboxesOptions = {},
) =>
  Layer.effect(
    SandboxesService,
    Effect.gen(function* () {
      const sandboxes = yield* Modal.CreateSandbox(yield* base);

      return {
        open: Effect.fn(function* (key) {
          return (
            (yield* sandboxes.fromName(key)) ??
            (yield* sandboxes.create({
              name: key,
              idleTimeout: options.idleTimeout ?? "10 minutes",
            }))
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
