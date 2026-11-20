import * as file from "@distilled.cloud/gcp/file_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFilestoreInstanceHttpBinding } from "./BindingHttp.ts";
import type { Instance } from "./Instance.ts";

export interface GetInstanceRequest extends Omit<
  file.GetProjectsLocationsInstancesRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Filestore `instances.get`.
 *
 * Bind this operation to an {@link Instance} in a Function/Action init
 * phase. Provide {@link GetInstanceHttp}.
 *
 * ### Observing Instances
 * **Example:** Read the bound instance
 * ```typescript
 * const getInstance = yield* GCP.Filestore.GetInstance(nfs);
 * const live = yield* getInstance();
 * ```
 *
 * @binding
 * @category Filestore
 */
export interface GetInstance extends Binding.Service<
  GetInstance,
  "GCP.Filestore.GetInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetInstanceRequest,
    ) => Effect.Effect<file.Instance, file.GetProjectsLocationsInstancesError, RuntimeContext>
  >
> {}

export const GetInstance = Binding.Service<GetInstance>("GCP.Filestore.GetInstance");

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides GCP.Filestore.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeFilestoreInstanceHttpBinding({
    tag: "GCP.Filestore.GetInstance",
    iam: { role: "roles/file.viewer" },
    operation: file.getProjectsLocationsInstances,
  }),
);
