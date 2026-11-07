import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import type { Instance } from "./Instance.ts";

export interface StopInstanceRequest extends Omit<
  compute.StopInstancesRequest,
  "instance" | "zone" | "project"
> {}

/**
 * Runtime binding for Compute Engine `instances.stop`.
 *
 * Bind this operation to an {@link Instance} in a Function/Action init phase.
 * Provide {@link StopInstanceHttp}.
 *
 * ### Instance Lifecycle Control
 * **Example:** Stop the bound instance
 * ```typescript
 * const stopInstance = yield* GCP.Compute.StopInstance(vm);
 * yield* stopInstance();
 * ```
 *
 * @binding
 * @category Compute
 */
export interface StopInstance extends Binding.Service<
  StopInstance,
  "GCP.Compute.StopInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: StopInstanceRequest,
    ) => Effect.Effect<compute.Operation, compute.StopInstancesError, RuntimeContext>
  >
> {}

export const StopInstance = Binding.Service<StopInstance>("GCP.Compute.StopInstance");

/**
 * HTTP implementation of {@link StopInstance}.
 *
 * Grants `roles/compute.instanceAdmin.v1` on the bound instance only,
 * because no narrower predefined role contains `compute.instances.stop`.
 *
 * @layer
 * @provides GCP.Compute.StopInstance
 */
export const StopInstanceHttp = Layer.effect(
  StopInstance,
  makeInstanceHttpBinding({
    tag: "GCP.Compute.StopInstance",
    iam: { role: "roles/compute.instanceAdmin.v1", on: "compute.instance" },
    operation: compute.stopInstances,
  }),
);
