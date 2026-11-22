import * as machinelearningservices from "@distilled.cloud/azure/machinelearningservices";
import * as Layer from "effect/Layer";
import { MachineLearningRole, makeComputeActionBinding } from "./BindingHttp.ts";
import { RestartCompute } from "./RestartCompute.ts";

/**
 * Implementation of {@link RestartCompute} over the distilled `machinelearningservices` ARM
 * API. Assigns the custom `AzureMachineLearningRestartComputeRole` on the compute.
 *
 * @layer
 * @provides Azure.MachineLearning.RestartCompute
 */
export const RestartComputeHttp = Layer.effect(
  RestartCompute,
  makeComputeActionBinding({
    tag: "Azure.MachineLearning.RestartCompute",
    operation: machinelearningservices.RestartCompute,
    role: MachineLearningRole.RestartCompute,
  }),
);
