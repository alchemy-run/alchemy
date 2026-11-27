/**
 * `AI.Sandboxes` on Boat.
 *
 * @module
 */
import * as Boat from "@alchemy.run/boat";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Sandboxes as SandboxesService } from "../Sandbox.ts";

/** Options of {@link Sandboxes}. */
export interface SandboxesOptions {
  /**
   * The size of each sandbox.
   * @default "small"
   */
  readonly type?: NonNullable<Parameters<Boat.SandboxesClient["create"]>[0]>["type"];
  /**
   * How long a sandbox runs after its last use before Boat stops it and saves its disk.
   * @default "10 minutes"
   */
  readonly autoStop?: NonNullable<Parameters<Boat.SandboxesClient["create"]>[0]>["autoStop"];
}

/**
 * Run a harness's sandboxes on Boat, each started from `base`. A sandbox is
 * found again by a `key` label, and `suspend` stops it and keeps its disk.
 * New sandboxes get none of your account's environments.
 *
 * **Example:** Sandboxes from a snapshot
 * ```typescript
 * import * as AIBoat from "@alchemy.run/ai/Boat";
 * import * as Boat from "@alchemy.run/boat";
 *
 * export const Sandbox = AIBoat.Sandboxes(
 *   Boat.Snapshot("Base", { run: ["npm install --global pnpm"] }),
 * );
 * ```
 *
 * @layer
 * @provides AI.Sandboxes
 * @peer @alchemy.run/boat
 */
export const Sandboxes = <E, R>(
  base: Effect.Effect<Boat.Snapshot, E, R>,
  options: SandboxesOptions = {},
) => {
  const autoStop = options.autoStop ?? "10 minutes";
  return Layer.effect(
    SandboxesService,
    Effect.gen(function* () {
      const sandboxes = yield* Boat.CreateSandbox(yield* base);
      const find = (key: string) => sandboxes.list({ labels: { key } });

      return {
        open: Effect.fn(function* (key) {
          const [existing] = yield* find(key);
          if (existing === undefined) {
            return yield* sandboxes.create({
              type: options.type ?? "small",
              noEnv: true,
              autoStop,
              labels: { key },
            });
          }
          const sandbox = yield* sandboxes.connect(existing.id);
          yield* sandbox.resume({ autoStop });
          return sandbox;
        }),
        suspend: Effect.fn(function* (key) {
          const [existing] = yield* find(key);
          if (existing === undefined) return;
          const sandbox = yield* sandboxes.connect(existing.id);
          yield* sandbox.stop();
        }),
        remove: Effect.fn(function* (key) {
          const found = yield* find(key);
          yield* Effect.forEach(found, (sandbox) => sandboxes.delete(sandbox.id));
        }),
      };
    }),
  ).pipe(Layer.provide(Boat.CreateSandboxHttp));
};
