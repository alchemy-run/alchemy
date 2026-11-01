import * as modelServing from "@distilled.cloud/stackit/model_serving";
import * as Layer from "effect/Layer";
import { makeTokenHttpBinding } from "./BindingHttp.ts";
import { GetToken } from "./GetToken.ts";

/**
 * HTTP implementation of {@link GetToken}.
 *
 * @layer
 * @provides Stackit.ModelServing.GetToken
 */
export const GetTokenHttp = Layer.effect(
  GetToken,
  makeTokenHttpBinding({
    tag: "Stackit.ModelServing.GetToken",
    permission: "model-serving.token.get",
    operation: modelServing.getToken,
  }),
);
