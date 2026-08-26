import type * as tpu from "@distilled.cloud/gcp/tpu_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { QueuedResource } from "./QueuedResource.ts";

export interface GetQueuedResourceRequest extends Omit<
  tpu.GetProjectsLocationsQueuedResourcesRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud TPU `queuedResources.get`.
 *
 * Bind this operation to a {@link QueuedResource} in a Function/Action
 * init phase. Provide {@link GetQueuedResourceHttp}.
 *
 * ### Observing Queued Resources
 * **Example:** Read the bound queued resource
 * ```typescript
 * const getQueued = yield* GCP.Tpu.GetQueuedResource(request);
 * const live = yield* getQueued();
 * ```
 *
 * @binding
 * @product GCP
 * @category Tpu
 */
export interface GetQueuedResource extends Binding.Service<
  GetQueuedResource,
  "GCP.Tpu.GetQueuedResource",
  (
    resource: QueuedResource,
  ) => Effect.Effect<
    (
      request?: GetQueuedResourceRequest,
    ) => Effect.Effect<
      tpu.QueuedResource,
      tpu.GetProjectsLocationsQueuedResourcesError,
      RuntimeContext
    >
  >
> {}

export const GetQueuedResource = Binding.Service<GetQueuedResource>(
  "GCP.Tpu.GetQueuedResource",
);
