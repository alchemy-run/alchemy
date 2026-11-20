import * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeBigtableInstanceHttpBinding } from "./BindingHttp.ts";
import type { Instance } from "./Instance.ts";

export interface GetInstanceRequest extends Omit<bigtable.GetProjectsInstancesRequest, "name"> {}

/**
 * Runtime binding for Cloud Bigtable `instances.get`.
 *
 * Bind this operation to an {@link Instance} in a Function/Action init
 * phase. Provide {@link GetInstanceHttp}.
 *
 * ### Observing Instances
 * **Example:** Read the bound instance
 * ```typescript
 * const getInstance = yield* GCP.Bigtable.GetInstance(store);
 * const live = yield* getInstance();
 * ```
 *
 * @binding
 * @category Bigtable
 */
export interface GetInstance extends Binding.Service<
  GetInstance,
  "GCP.Bigtable.GetInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetInstanceRequest,
    ) => Effect.Effect<bigtable.Instance, bigtable.GetProjectsInstancesError, RuntimeContext>
  >
> {}

export const GetInstance = Binding.Service<GetInstance>("GCP.Bigtable.GetInstance");

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides GCP.Bigtable.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeBigtableInstanceHttpBinding({
    tag: "GCP.Bigtable.GetInstance",
    iam: { role: "roles/bigtable.viewer", on: "bigtable.instance" },
    operation: bigtable.getProjectsInstances,
  }),
);
