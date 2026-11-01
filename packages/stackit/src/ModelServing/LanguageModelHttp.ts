import * as inference from "@distilled.cloud/stackit/model_serving_inference";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { inferenceCallerOf } from "./BindingHttp.ts";
import {
  LanguageModel,
  type LanguageModelOptions,
  makeLanguageModelLayer,
} from "./LanguageModel.ts";
import type { Token } from "./Token.ts";

/**
 * HTTP implementation of {@link LanguageModel}, on the OpenAI-compatible
 * `POST /v1/chat/completions`, with and without streaming.
 *
 * @layer
 * @provides Stackit.ModelServing.LanguageModel
 */
export const LanguageModelHttp = Layer.succeed(
  LanguageModel,
  Effect.fn(function* (token: Token, options: LanguageModelOptions) {
    const call = yield* inferenceCallerOf(token);
    return makeLanguageModelLayer({
      ...options,
      chat: (request) => call(inference.createChatCompletion, request),
      chatStream: (request) => call(inference.streamChatCompletion, request),
    });
  }),
);
