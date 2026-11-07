import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import type { Instance } from "./Instance.ts";

export interface GetInstanceRequest extends Omit<
  compute.GetInstancesRequest,
  "instance" | "zone" | "project"
> {}

/**
 * Runtime binding for Compute Engine `instances.get`.
 *
 * Bind this operation to an {@link Instance} in a Function/Action init phase.
 * Provide {@link GetInstanceHttp}.
 *
 * ### Observing Instances
 * **Example:** Read the bound instance
 * ```typescript
 * const getInstance = yield* GCP.Compute.GetInstance(vm);
 * const live = yield* getInstance();
 * ```
 *
 * @binding
 * @category Compute
 */
export interface GetInstance extends Binding.Service<
  GetInstance,
  "GCP.Compute.GetInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetInstanceRequest,
    ) => Effect.Effect<compute.Instance, compute.GetInstancesError, RuntimeContext>
  >
> {}

export const GetInstance = Binding.Service<GetInstance>("GCP.Compute.GetInstance");

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides GCP.Compute.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeInstanceHttpBinding({
    tag: "GCP.Compute.GetInstance",
    iam: { role: "roles/compute.viewer", on: "compute.instance" },
    operation: compute.getInstances,
  }),
);
