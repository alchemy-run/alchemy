import * as inference from "@distilled.cloud/stackit/model_serving_inference";
import * as Layer from "effect/Layer";
import { makeInferenceBinding } from "./BindingHttp.ts";
import { StreamChatCompletion } from "./StreamChatCompletion.ts";

/**
 * HTTP implementation of {@link StreamChatCompletion}.
 *
 * @layer
 * @provides Stackit.ModelServing.StreamChatCompletion
 */
export const StreamChatCompletionHttp = Layer.succeed(
  StreamChatCompletion,
  makeInferenceBinding(inference.streamChatCompletion),
);
