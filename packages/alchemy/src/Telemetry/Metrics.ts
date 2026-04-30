import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Metric from "effect/Metric";

/**
 * Counter for resource lifecycle operations. Tagged per call with
 * `resource_type`, `op` (`precreate`/`create`/`update`/`delete`/`read`),
 * and `status` (`success`/`error`).
 */
export const resourceCounter = Metric.counter("alchemy.resource.operations", {
  description:
    "Number of resource lifecycle operations dispatched by alchemy apply.",
  incremental: true,
});

/**
 * Histogram of how long each lifecycle operation takes.
 */
export const resourceDuration = Metric.timer("alchemy.resource.duration", {
  description:
    "Wall-clock duration of resource lifecycle operations dispatched by alchemy apply.",
});

/**
 * Counter for CLI command invocations.
 */
export const cliCounter = Metric.counter("alchemy.cli.invocations", {
  description: "Number of alchemy CLI command invocations.",
  incremental: true,
});

/**
 * Counter for Cloudflare State Store bootstrap/deploy operations.
 * Tagged per call with `op` (e.g. `deploy`) and `status`
 * (`success`/`error`) so that the deploy success rate of the
 * state store itself can be tracked separately from regular
 * resource lifecycle ops.
 */
export const stateStoreCounter = Metric.counter(
  "alchemy.state_store.operations",
  {
    description:
      "Number of Cloudflare State Store deploy/bootstrap operations dispatched by alchemy.",
    incremental: true,
  },
);

export type StateStoreOp = "deploy";

/**
 * Wraps a resource lifecycle Effect to record a counter + timer entry,
 * tagged with `resource_type`, `op`, and `status` (`success`/`error`).
 *
 * Usage:
 * ```ts
 * provider.create(input).pipe(recordResourceOp(node.resource.Type, "create"))
 * ```
 */
export const recordResourceOp =
  (resourceType: string, op: ResourceOp) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const startNs = process.hrtime.bigint();
      const baseAttrs = { resource_type: resourceType, op } as const;
      return self.pipe(
        Effect.onExit((exit) =>
          recordOutcome(
            baseAttrs,
            Exit.isSuccess(exit) ? "success" : "error",
            elapsed(startNs),
          ),
        ),
      );
    });

/**
 * Wraps a CLI command Effect to bump {@link cliCounter} with the
 * outcome (`success`/`error`).
 */
export const recordCli =
  (command: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    self.pipe(
      Effect.onExit((exit) =>
        Metric.update(
          Metric.withAttributes(cliCounter, {
            command,
            status: Exit.isSuccess(exit) ? "success" : "error",
          }),
          1,
        ),
      ),
    );

/**
 * Wraps a Cloudflare State Store deploy/bootstrap Effect to bump
 * {@link stateStoreCounter} with the outcome (`success`/`error`),
 * tagged with the given `op`.
 */
export const recordStateStoreOp =
  (op: StateStoreOp) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    self.pipe(
      Effect.onExit((exit) =>
        Metric.update(
          Metric.withAttributes(stateStoreCounter, {
            op,
            status: Exit.isSuccess(exit) ? "success" : "error",
          }),
          1,
        ),
      ),
    );

export type ResourceOp = "precreate" | "create" | "update" | "delete" | "read";

const elapsed = (startNs: bigint): Duration.Duration =>
  Duration.nanos(process.hrtime.bigint() - startNs);

const recordOutcome = (
  baseAttrs: { resource_type: string; op: ResourceOp },
  status: "success" | "error",
  duration: Duration.Duration,
): Effect.Effect<void> => {
  const attrs = { ...baseAttrs, status };
  return Effect.all(
    [
      Metric.update(Metric.withAttributes(resourceCounter, attrs), 1),
      Metric.update(Metric.withAttributes(resourceDuration, attrs), duration),
    ],
    { discard: true },
  );
};
