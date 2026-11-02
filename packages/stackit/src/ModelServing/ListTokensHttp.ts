import * as modelServing from "@distilled.cloud/stackit/model_serving";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding } from "./BindingHttp.ts";
import { ListTokens } from "./ListTokens.ts";

/**
 * HTTP implementation of {@link ListTokens}.
 *
 * @layer
 * @provides Stackit.ModelServing.ListTokens
 */
export const ListTokensHttp = Layer.effect(
  ListTokens,
  makeProjectHttpBinding({
    tag: "Stackit.ModelServing.ListTokens",
    permission: "model-serving.token.list",
    operation: modelServing.listTokens,
  }),
);
