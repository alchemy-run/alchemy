/**
 * `AI.Sandboxes` on Daytona.
 *
 * @module
 */
import * as Daytona from "@alchemy.run/daytona";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Sandboxes as SandboxesService } from "../Sandbox.ts";

/** Options of {@link Sandboxes}. */
export interface SandboxesOptions {
  /**
   * Minutes a sandbox may be idle before Daytona stops it, keeping its disk.
   * @default 15
   */
  readonly autoStopInterval?: number;
  /**
   * Minutes a sandbox may stay stopped before Daytona deletes it.
   * @default 1440
   */
  readonly autoDeleteInterval?: number;
}

/**
 * Run a harness's sandboxes on Daytona, each started from `base`. A sandbox
 * is named by its key, and `suspend` stops it and keeps its disk.
 *
 * **Example:** Sandboxes from a snapshot
 * ```typescript
 * import * as AIDaytona from "@alchemy.run/ai/Daytona";
 * import * as Daytona from "@alchemy.run/daytona";
 *
 * export const Sandbox = AIDaytona.Sandboxes(
 *   Daytona.Snapshot("Base", { image: "node:22-bookworm", cpu: 1, memory: 1, disk: 3 }),
 * );
 * ```
 *
 * @layer
 * @provides AI.Sandboxes
 * @peer @alchemy.run/daytona
 */
export const Sandboxes = <E, R>(
  base: Effect.Effect<Daytona.Snapshot, E, R>,
  options: SandboxesOptions = {},
) =>
  Layer.effect(
    SandboxesService,
    Effect.gen(function* () {
      const sandboxes = yield* Daytona.CreateSandbox(yield* base);

      return {
        open: Effect.fn(function* (key) {
          const existing = yield* sandboxes.get(key);
          if (existing === undefined) {
            return yield* sandboxes.create({
              name: key,
              autoStopInterval: options.autoStopInterval ?? 15,
              autoDeleteInterval: options.autoDeleteInterval ?? 24 * 60,
            });
          }
          yield* existing.startSandbox();
          return existing;
        }),
        suspend: Effect.fn(function* (key) {
          const existing = yield* sandboxes.get(key);
          if (existing === undefined) return;
          const { state } = yield* existing.getSandbox();
          if (state === "started") yield* existing.stopSandbox();
        }),
        remove: (key) => sandboxes.delete(key),
      };
    }),
  ).pipe(Layer.provide(Daytona.CreateSandboxHttp));
