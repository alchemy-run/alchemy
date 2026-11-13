import { fromApiKey, type Credentials } from "@distilled.cloud/digitalocean";
import * as Output from "alchemy/Output";
import { CurrentRuntimeContext, type RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/**
 * Shared scaffolding for the Serverless Inference bindings. NOT exported
 * from `index.ts`.
 *
 * Serverless Inference (`https://inference.do-ai.run`) authenticates with a
 * model access key. DigitalOcean retired creating those through the API
 * (`410 gone`) and signs no workload identity, so the caller passes a key
 * made in the control panel (or a personal access token); it reaches the
 * host as a secret.
 */
export class InferenceKeyMissing extends Data.TaggedError("DigitalOcean.Inference.KeyMissing")<{}> {
  override get message() {
    return "No model access key is bound to this runtime.";
  }
}

/** Options every inference binding takes. */
export interface InferenceOptions {
  /** A model access key, or a personal access token. */
  readonly key: Redacted.Redacted<string>;
}

const KEY_ENV = "DO_INFERENCE_KEY";

/** Builds one inference binding over a distilled operation. */
export const makeInferenceBinding = <I, A, E>(
  tag: string,
  operation: (input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
) =>
  Effect.fn(function* (options: InferenceOptions) {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const runtime = yield* CurrentRuntimeContext;
      if (runtime !== undefined) yield* runtime.set(KEY_ENV, Output.literal(options.key));
    }
    // Read in the construction phase, where the host's runtime context is
    // present; request handlers close over the value.
    const runtime = globalThis.__ALCHEMY_RUNTIME__ ? yield* CurrentRuntimeContext : undefined;
    const bound =
      runtime === undefined
        ? undefined
        : yield* runtime.get<string | Redacted.Redacted<string>>(KEY_ENV);
    const key =
      bound === undefined ? undefined : typeof bound === "string" ? Redacted.make(bound) : bound;
    const layer =
      key === undefined
        ? undefined
        : Layer.mergeAll(fromApiKey({ apiKey: key }), FetchHttpClient.layer);
    const call = Effect.fn(tag)(function* (input: I) {
      if (layer === undefined) return yield* new InferenceKeyMissing();
      return yield* operation(input).pipe(Effect.provide(layer));
    });
    return call as (input: I) => Effect.Effect<A, E | InferenceKeyMissing, RuntimeContext>;
  });
