import * as modelServing from "@distilled.cloud/stackit/model_serving";
import * as Layer from "effect/Layer";
import { makeCatalogHttpBinding } from "./BindingHttp.ts";
import { GetChatModel } from "./GetChatModel.ts";

/**
 * HTTP implementation of {@link GetChatModel}.
 *
 * @layer
 * @provides Stackit.ModelServing.GetChatModel
 */
export const GetChatModelHttp = Layer.effect(
  GetChatModel,
  makeCatalogHttpBinding({
    tag: "Stackit.ModelServing.GetChatModel",
    operation: modelServing.getChatModel,
  }),
);
