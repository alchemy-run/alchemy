import * as modelExperiments from "@distilled.cloud/stackit/model_experiments";
import * as Layer from "effect/Layer";
import { makeTokenHttpBinding } from "./BindingHttp.ts";
import { GetToken } from "./GetToken.ts";

/**
 * HTTP implementation of {@link GetToken}.
 *
 * @layer
 * @provides Stackit.ModelExperiments.GetToken
 */
export const GetTokenHttp = Layer.effect(
  GetToken,
  makeTokenHttpBinding({
    tag: "Stackit.ModelExperiments.GetToken",
    permission: "model-experiments.token.get",
    operation: modelExperiments.getInstanceToken,
  }),
);
