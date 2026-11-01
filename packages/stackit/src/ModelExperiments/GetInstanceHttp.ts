import * as modelExperiments from "@distilled.cloud/stackit/model_experiments";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetInstance } from "./GetInstance.ts";

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides Stackit.ModelExperiments.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeInstanceHttpBinding({
    tag: "Stackit.ModelExperiments.GetInstance",
    permission: "model-experiments.instance.get",
    operation: modelExperiments.getInstance,
  }),
);
