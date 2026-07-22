import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Converse } from "./Converse.ts";
import { ConverseHttp } from "./ConverseHttp.ts";
import { ConverseStream } from "./ConverseStream.ts";
import { ConverseStreamHttp } from "./ConverseStreamHttp.ts";
import {
  LanguageModel,
  type LanguageModelOptions,
  makeLanguageModelLayer,
} from "./LanguageModel.ts";

/**
 * HTTP implementation of {@link LanguageModel}. Composes the {@link Converse}
 * and {@link ConverseStream} bindings, so binding a model registers both
 * `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` scoped to
 * exactly that model.
 */
export const LanguageModelHttp = Layer.effect(
  LanguageModel,
  Effect.gen(function* () {
    const converse = yield* Converse;
    const converseStream = yield* ConverseStream;
    return Effect.fn(function* (model: string, options?: LanguageModelOptions) {
      return makeLanguageModelLayer({
        converse: yield* converse(model),
        converseStream: yield* converseStream(model),
        parameters: options?.parameters,
      });
    });
  }),
).pipe(Layer.provide(Layer.mergeAll(ConverseHttp, ConverseStreamHttp)));
