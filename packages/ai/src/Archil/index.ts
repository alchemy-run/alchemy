/**
 * `AI.Sandboxes` on Archil.
 *
 * @module
 */
import * as Archil from "@alchemy.run/archil";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Sandboxes as SandboxesService } from "../Sandbox.ts";

/**
 * Run a harness's sandboxes on Archil, each started from `base`. A sandbox
 * is named by its key. `suspend` pauses a running sandbox, keeping its
 * memory and files; Archil also pauses an idle one, and resumes it on the
 * next command.
 *
 * **Example:** Sandboxes from an image
 * ```typescript
 * import * as AIArchil from "@alchemy.run/ai/Archil";
 * import * as Archil from "@alchemy.run/archil";
 *
 * export const Sandbox = AIArchil.Sandboxes(Archil.Image("Base", { image: "node:22-bookworm" }));
 * ```
 *
 * @layer
 * @provides AI.Sandboxes
 * @peer @alchemy.run/archil
 */
export const Sandboxes = <E, R>(base: Effect.Effect<Archil.Image, E, R>) =>
  Layer.effect(
    SandboxesService,
    Effect.gen(function* () {
      const sandboxes = yield* Archil.CreateSandbox(yield* base);

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
