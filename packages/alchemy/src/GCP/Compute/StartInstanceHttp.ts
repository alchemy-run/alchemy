import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { StartInstance } from "./StartInstance.ts";

/**
 * HTTP implementation of {@link StartInstance}.
 *
 * @layer
 * @provides GCP.Compute.StartInstance
 */
export const StartInstanceHttp = Layer.effect(
  StartInstance,
  makeInstanceHttpBinding({
    tag: "GCP.Compute.StartInstance",
    operation: compute.startInstances,
  }),
);
