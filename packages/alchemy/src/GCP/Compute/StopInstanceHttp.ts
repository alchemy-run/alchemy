import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { StopInstance } from "./StopInstance.ts";

/**
 * HTTP implementation of {@link StopInstance}.
 *
 * @layer
 * @provides GCP.Compute.StopInstance
 */
export const StopInstanceHttp = Layer.effect(
  StopInstance,
  makeInstanceHttpBinding({
    tag: "GCP.Compute.StopInstance",
    operation: compute.stopInstances,
  }),
);
