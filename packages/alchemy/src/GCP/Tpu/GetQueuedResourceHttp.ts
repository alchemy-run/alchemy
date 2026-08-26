import * as tpu from "@distilled.cloud/gcp/tpu_v2";
import * as Layer from "effect/Layer";
import { makeTpuQueuedResourceHttpBinding } from "./BindingHttp.ts";
import { GetQueuedResource } from "./GetQueuedResource.ts";

/**
 * HTTP implementation of {@link GetQueuedResource}.
 *
 * @layer
 * @provides GCP.Tpu.GetQueuedResource
 */
export const GetQueuedResourceHttp = Layer.effect(
  GetQueuedResource,
  makeTpuQueuedResourceHttpBinding({
    tag: "GCP.Tpu.GetQueuedResource",
    operation: tpu.getProjectsLocationsQueuedResources,
  }),
);
