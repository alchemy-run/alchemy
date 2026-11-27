/**
 * `AI.Sandboxes` on E2B.
 *
 * @module
 */
import * as E2B from "@alchemy.run/e2b";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Sandboxes as SandboxesService } from "../Sandbox.ts";

/** Options of {@link Sandboxes}. */
export interface SandboxesOptions {
  /**
   * Seconds a sandbox runs after its last use before E2B kills it.
   * @default 600
   */
  readonly timeout?: number;
}

/**
 * Run a harness's sandboxes on E2B, each started from `base`. A sandbox is
 * found again by its `key` metadata, and `suspend` pauses it, keeping its
 * memory and files.
 *
 * **Example:** Sandboxes from a template
 * ```typescript
 * import * as AIE2B from "@alchemy.run/ai/E2B";
 * import * as E2B from "@alchemy.run/e2b";
 *
 * export const Sandbox = AIE2B.Sandboxes(E2B.Template("Base", { image: "node:22-bookworm" }));
 * ```
 *
 * @layer
 * @provides AI.Sandboxes
 * @peer @alchemy.run/e2b
 */
export const Sandboxes = <E, R>(
  base: Effect.Effect<E2B.SandboxBase, E, R>,
  options: SandboxesOptions = {},
) => {
  const timeout = options.timeout ?? 600;
  return Layer.effect(
    SandboxesService,
    Effect.gen(function* () {
      const sandboxes = yield* E2B.CreateSandbox(yield* base);
      const find = (key: string) =>
        sandboxes.list({ metadata: { key }, state: ["running", "paused"] });

      return {
        open: Effect.fn(function* (key) {
          const [existing] = yield* find(key);
          return existing
            ? yield* sandboxes.connect(existing.sandboxID, { timeout })
            : yield* sandboxes.create({ metadata: { key }, timeout });
        }),
        suspend: Effect.fn(function* (key) {
          const [existing] = yield* find(key);
          if (existing?.state !== "running") return;
          const sandbox = yield* sandboxes.connect(existing.sandboxID);
          yield* sandbox.pause();
        }),
        remove: Effect.fn(function* (key) {
          const found = yield* find(key);
          yield* Effect.forEach(found, (sandbox) => sandboxes.kill(sandbox.sandboxID));
        }),
      };
    }),
  ).pipe(Layer.provide(E2B.CreateSandboxHttp));
};
