import * as machinelearningservices from "@distilled.cloud/azure/machinelearningservices";
import * as Layer from "effect/Layer";
import { MachineLearningRole, makeComputeActionBinding } from "./BindingHttp.ts";
import { StopCompute } from "./StopCompute.ts";

/**
 * Implementation of {@link StopCompute} over the distilled `machinelearningservices` ARM
 * API. Assigns the custom `AzureMachineLearningStopComputeRole` on the compute.
 *
 * @layer
 * @provides Azure.MachineLearning.StopCompute
 */
export const StopComputeHttp = Layer.effect(
  StopCompute,
  makeComputeActionBinding({
    tag: "Azure.MachineLearning.StopCompute",
    operation: machinelearningservices.StopCompute,
    role: MachineLearningRole.StopCompute,
  }),
);
