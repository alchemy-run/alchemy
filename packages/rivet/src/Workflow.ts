/**
 * Rivet Workflows: durable, replayable multi-step Actors from
 * `@rivet-dev/workflows`, deployed on a Rivet pool as an external Durable
 * Object.
 *
 * A workflow is a RivetKit Actor whose `run` is wrapped by
 * `workflow({ run })`. Steps run once, resume after a crash or redeploy, and
 * sleep with `ctx.sleep`. Deploy the registry that starts them with
 * {@link Workflow}; callers reach them with RivetKit's client against the
 * pool that hosts them.
 *
 * @see https://rivet.dev/docs/workflows
 */
import type * as Effect from "effect/Effect";
import {
  DurableObject,
  type DurableObject as DurableObjectResource,
  type ExternalDurableObjectProps,
} from "./DurableObject.ts";
import type { PoolHost } from "./Host.ts";
import type { Providers } from "./Providers.ts";

export type { ExternalDurableObjectProps as WorkflowProps } from "./DurableObject.ts";

/**
 * Re-export of `@rivet-dev/workflows`'s `workflow` helper, so a registry can
 * declare durable runs without a second import.
 */
export { workflow } from "@rivet-dev/workflows";
export type {
  WorkflowConfigInput,
  WorkflowContext,
  WorkflowOptions,
  WorkflowRunFunction,
} from "@rivet-dev/workflows";

/**
 * Deploy a Rivet Workflows program on a pool: the entry file is a RivetKit
 * registry that registers actors built with {@link workflow} and calls
 * `registry.start()`. The pool bundles and runs it unchanged, with
 * `RIVET_ENDPOINT`, `RIVET_TOKEN`, `RIVET_NAMESPACE` and `RIVET_POOL` set.
 *
 * Provide a pool Layer of its own — workflows share a node image with no
 * Alchemy Effect Durable Objects.
 *
 * ### Declaring a workflow program
 * **Example:** A checkout workflow on a Docker pool
 * ```typescript
 * // src/workflows.ts
 * import { workflow } from "@alchemy.run/rivet/Workflow";
 * import { setup } from "rivetkit";
 *
 * const checkout = workflow({
 *   run: async (ctx) => {
 *     const order = await ctx.step("load", async () => loadOrder(ctx.key[0]!));
 *     await ctx.sleep("1 day");
 *     await ctx.step("charge", async () => charge(order));
 *   },
 * });
 *
 * export const registry = setup({ use: { checkout } });
 * await registry.start();
 *
 * // src/cluster.ts
 * export const Cluster = RivetDocker.SwarmControlPlane("Rivet");
 * export const Workflows = RivetDocker.SwarmPool("Workflows").pipe(Layer.provide(Cluster));
 *
 * // alchemy.run.ts
 * yield* Rivet.Workflow("Checkout", { main: "./src/workflows.ts" }).pipe(
 *   Effect.provide(Workflows),
 * );
 * ```
 *
 * @resource
 */
export const Workflow: (
  id: string,
  props: ExternalDurableObjectProps,
) => Effect.Effect<DurableObjectResource, never, PoolHost | Providers> = DurableObject;
