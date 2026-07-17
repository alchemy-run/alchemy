import * as Effect from "effect/Effect";
import * as Binding from "../Workers/Binding.ts";
import { makeBindingLayer } from "../Workers/BindingLayer.ts";
import { Ai, WorkersAiError, type AiClient } from "./Ai.ts";
import { makeLanguageModelLayer, type WorkersAi } from "./LanguageModel.ts";

/** The binding value produced by calling {@link Ai} (declared on `env` or `yield*`-ed). */
export type AiBinding = Binding.Binding<Ai["key"], AiClient, Ai>;

/**
 * The layer that provides the Effect-native interface for the Cloudflare
 * Workers AI binding.
 *
 * Provide it on the Worker effect (`Effect.provide(Cloudflare.AI.AiBinding)`)
 * so that yielding an {@link Ai} binding attaches the native `ai` binding to
 * the surrounding Worker at deploy time and, at runtime, resolves to the
 * Effect-native {@link AiClient} (wrapping the raw `Ai` handle so `run` /
 * `models` return Effects and `model(...)` yields a `LanguageModel` layer).
 */
export const AiBinding = makeBindingLayer<Ai, WorkersAi, AiClient>(
  Ai,
  (raw) => {
    const self: AiClient = {
      raw,
      run: (model, inputs, options) =>
        Effect.gen(function* () {
          const ai = yield* raw;
          return yield* tryPromise(() => ai.run(model, inputs, options));
        }),
      models: (params) =>
        Effect.gen(function* () {
          const ai = yield* raw;
          return yield* tryPromise(() => ai.models(params));
        }),
      model: (options) =>
        makeLanguageModelLayer({
          ...options,
          client: self,
        }),
    };
    return self;
  },
);

const tryPromise = <T>(
  fn: () => Promise<T>,
): Effect.Effect<T, WorkersAiError> =>
  Effect.tryPromise({
    try: fn,
    catch: (error) =>
      new WorkersAiError({
        message:
          error instanceof Error
            ? error.message
            : "Unknown Workers AI runtime error",
        cause: error,
      }),
  });
