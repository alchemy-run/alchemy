import * as machinelearningservices from "@distilled.cloud/azure/machinelearningservices";
import * as Layer from "effect/Layer";
import { MachineLearningRole, makeComputeActionBinding } from "./BindingHttp.ts";
import { StartCompute } from "./StartCompute.ts";

/**
 * Implementation of {@link StartCompute} over the distilled `machinelearningservices` ARM
 * API. Assigns the custom `AzureMachineLearningStartComputeRole` on the compute.
 *
 * @layer
 * @provides Azure.MachineLearning.StartCompute
 */
export const StartComputeHttp = Layer.effect(
  StartCompute,
  makeComputeActionBinding({
    tag: "Azure.MachineLearning.StartCompute",
    operation: machinelearningservices.StartCompute,
    role: MachineLearningRole.StartCompute,
  }),
);
