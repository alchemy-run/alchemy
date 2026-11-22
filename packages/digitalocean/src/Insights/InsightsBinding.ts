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
 * Shared scaffolding for the Insights query bindings. NOT exported from
 * `index.ts`.
 *
 * Insights queries are signed with a personal access token. DigitalOcean
 * has no API to create a narrower token and signs no workload identity, so
 * the caller passes one (with the `insights:read` scope); it reaches the
 * host as a secret.
 */
export class InsightsTokenMissing extends Data.TaggedError(
  "DigitalOcean.Insights.TokenMissing",
)<{}> {
  override get message() {
    return "No Insights token is bound to this runtime.";
  }
}

/** Options every Insights query binding takes. */
export interface InsightsOptions {
  /** A personal access token with the `insights:read` scope. */
  readonly token: Redacted.Redacted<string>;
}

const TOKEN_ENV = "DO_INSIGHTS_TOKEN";

/** Builds one Insights binding over a distilled operation. */
export const makeInsightsBinding = <I, A, E>(
  tag: string,
  operation: (input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
) =>
  Effect.fn(function* (options: InsightsOptions) {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const runtime = yield* CurrentRuntimeContext;
      if (runtime !== undefined) yield* runtime.set(TOKEN_ENV, Output.literal(options.token));
    }
    // Read in the construction phase, where the host's runtime context is
    // present; request handlers close over the value.
    const runtime = globalThis.__ALCHEMY_RUNTIME__ ? yield* CurrentRuntimeContext : undefined;
    const bound =
      runtime === undefined
        ? undefined
        : yield* runtime.get<string | Redacted.Redacted<string>>(TOKEN_ENV);
    const token =
      bound === undefined ? undefined : typeof bound === "string" ? Redacted.make(bound) : bound;
    const layer =
      token === undefined
        ? undefined
        : Layer.mergeAll(fromApiKey({ apiKey: token }), FetchHttpClient.layer);
    const call = Effect.fn(tag)(function* (input: I) {
      if (layer === undefined) return yield* new InsightsTokenMissing();
      return yield* operation(input).pipe(Effect.provide(layer));
    });
    return call as (input: I) => Effect.Effect<A, E | InsightsTokenMissing, RuntimeContext>;
  });
