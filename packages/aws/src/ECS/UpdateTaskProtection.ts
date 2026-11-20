import * as ECS from "@distilled.cloud/aws/ecs";
import * as Binding from "alchemy/Binding";
import { toWireMinutes } from "alchemy/Util/Duration";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEcsClusterHttpBinding } from "./BindingHttp.ts";
import type { Cluster } from "./Cluster.ts";

export interface UpdateTaskProtectionRequest extends Omit<
  ECS.UpdateTaskProtectionRequest,
  "cluster" | "expiresInMinutes"
> {
  /**
   * How long the protection should last, e.g. `"20 minutes"` or
   * `Duration.hours(1)`. Rounded to whole minutes on the wire
   * (1 minute – 48 hours).
   * @default "2 hours"
   */
  expiresIn?: Duration.Input;
}

/**
 * Runtime binding for `ecs:UpdateTaskProtection`.
 *
 * Bind this operation to a `Cluster` inside a function runtime to get a
 * callable that toggles scale-in protection on service-managed tasks in the
 * bound cluster — the canonical pattern is a task protecting *itself* while
 * it processes long-running work so deployments and scale-in don't terminate
 * it. The cluster ARN is injected automatically and the host is granted
 * `ecs:UpdateTaskProtection` on the cluster's tasks.
 * ### Task Protection
 * **Example:** Protect a Task While It Works
 * ```typescript
 * const updateTaskProtection = yield* AWS.ECS.UpdateTaskProtection(cluster);
 *
 * yield* updateTaskProtection({
 *   tasks: [taskArn],
 *   protectionEnabled: true,
 *   expiresIn: "30 minutes",
 * });
 * ```
 *
 * @binding
 */
export interface UpdateTaskProtection extends Binding.Service<
  UpdateTaskProtection,
  "AWS.ECS.UpdateTaskProtection",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: UpdateTaskProtectionRequest,
    ) => Effect.Effect<ECS.UpdateTaskProtectionResponse, ECS.UpdateTaskProtectionError>
  >
> {}
export const UpdateTaskProtection = Binding.Service<UpdateTaskProtection>(
  "AWS.ECS.UpdateTaskProtection",
);

export const UpdateTaskProtectionHttp = Layer.effect(
  UpdateTaskProtection,
  makeEcsClusterHttpBinding({
    tag: "AWS.ECS.UpdateTaskProtection",
    // Wrap the distilled operation so the binding accepts a Duration.Input
    // `expiresIn` and converts it to the wire's whole minutes.
    //
    // The operation must be *yielded* (its `Symbol.iterator`/`asEffect`
    // protocol), never passed to `Effect.map`: an `API.OperationMethod` is a
    // plain callable that is not `Effect.isEffect`, so `Effect.map` wraps it
    // into an invalid effect that crashes the fiber at run time with
    // "Not a valid effect: function ...".
    operation: Effect.gen(function* () {
      const op = yield* ECS.updateTaskProtection;
      return ({ expiresIn, ...request }: UpdateTaskProtectionRequest & { cluster: string }) =>
        op({ ...request, expiresInMinutes: toWireMinutes(expiresIn) });
    }),
    actions: ["ecs:UpdateTaskProtection"],
    // Authorizes against the task resource:
    // arn:aws:ecs:{region}:{account}:task/{clusterName}/*
    resources: ["task"],
  }),
);
