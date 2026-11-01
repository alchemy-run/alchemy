import * as inference from "@distilled.cloud/stackit/model_serving_inference";
import * as Layer from "effect/Layer";
import { makeInferenceBinding } from "./BindingHttp.ts";
import { ChatCompletion } from "./ChatCompletion.ts";

/**
 * HTTP implementation of {@link ChatCompletion}.
 *
 * @layer
 * @provides Stackit.ModelServing.ChatCompletion
 */
export const ChatCompletionHttp = Layer.succeed(
  ChatCompletion,
  makeInferenceBinding(inference.createChatCompletion),
);
