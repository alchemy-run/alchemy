import * as modelExperiments from "@distilled.cloud/stackit/model_experiments";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListTokens } from "./ListTokens.ts";

/**
 * HTTP implementation of {@link ListTokens}.
 *
 * @layer
 * @provides Stackit.ModelExperiments.ListTokens
 */
export const ListTokensHttp = Layer.effect(
  ListTokens,
  makeInstanceHttpBinding({
    tag: "Stackit.ModelExperiments.ListTokens",
    permission: "model-experiments.token.list",
    operation: modelExperiments.listInstanceTokens,
  }),
);
